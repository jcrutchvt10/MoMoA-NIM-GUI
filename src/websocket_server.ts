/**
 * Copyright 2026 Reto Meier
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import WebSocket, { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import * as http from 'http';
import { Orchestrator } from './momoa_core/orchestrator.js';
import { Config, DEFAULT_GEMINI_EMBEDDING_MODEL } from './config/config.js';
import { AuthType } from './services/contentGenerator.js';
import { randomUUID } from 'crypto';
import { isBinaryFileSync } from 'isbinaryfile';
import { ServerMode, UserSecrets } from './shared/model.js';
import { ProgressQueue } from './utils/progressQueue.js';

// --- Type Definitions ---
/**
 * Defines the structure for incoming WebSocket messages.
 */
interface WebSocketMessage {
  status: 'INITIAL_REQUEST_PARAMS' | 'FILE_CHUNK' | 'START_TASK' | 'HITL_RESPONSE' | string;
  data?: unknown;
  messageId?: string;
  answer?: unknown;
}

interface UploadedFile {
  name: string;
  content: string;
}

/**
 * Defines the structure for the data in an 'INITIAL_REQUEST_PARAMS' message,
 * matching the Python client's payload but without files.
 */
interface InitialRequestData {
  prompt: string;
  image: string;
  imageMimeType: string;
  llmName: string;
  maxTurns?: number;
  assumptions?: string;
  files?: UploadedFile[]; // This will be populated by chunks
  apiKey?: string;
  saveFiles?: boolean; 
  mode?: ServerMode;
  projectSpecification?: string;
  environmentInstructions?: string;
  notWorkingBuild?: boolean;
  weaveId?: string;
  maxDurationMs?: number;
  gracePeriodMs?: number;
  secrets?: {
    nvidiaApiKey?: string;
    githubToken?: string;
    julesApiKey?: string;
    stitchApiKey?: string;
    e2BApiKey?: string;
    githubScratchPadRepo?: string;
  };
}

/**
 * Defines the structure for the data in a 'FILE_CHUNK' message.
 */
interface FileChunkData {
  files: UploadedFile[];
}


// --- WebSocket Server Implementation ---

// Map to store connected clients, keyed by UUID
const clients: Map<string, WebSocket> = new Map();
// Maps to store orchestrator instances and their abort controllers
const orchestratorInstances: Map<string, Orchestrator> = new Map();
const abortControllers: Map<string, AbortController> = new Map();

// Map to store pending task data before all files are received
const pendingTasks: Map<string, InitialRequestData> = new Map();

function getPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(`Invalid ${name}=${raw}. Using fallback ${fallback}.`);
    return fallback;
  }

  return parsed;
}

const MAX_UPLOADED_FILES = getPositiveIntEnv('MOMOA_MAX_UPLOADED_FILES', 5000);
const MAX_SINGLE_FILE_BYTES = getPositiveIntEnv('MOMOA_MAX_SINGLE_FILE_BYTES', 10 * 1024 * 1024);
const MAX_TOTAL_UPLOAD_BYTES = getPositiveIntEnv('MOMOA_MAX_TOTAL_UPLOAD_BYTES', 100 * 1024 * 1024);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isUploadedFile(value: unknown): value is UploadedFile {
  return isObject(value)
    && typeof value.name === 'string'
    && value.name.length > 0
    && typeof value.content === 'string';
}

function isInitialRequestData(value: unknown): value is InitialRequestData {
  return isObject(value)
    && typeof value.prompt === 'string'
    && typeof value.llmName === 'string';
}

function isFileChunkData(value: unknown): value is FileChunkData {
  return isObject(value)
    && Array.isArray(value.files)
    && value.files.every(isUploadedFile);
}

function base64Bytes(base64Content: string): number {
  return Buffer.byteLength(base64Content, 'base64');
}


/**
 * Initializes the WebSocket server.
 * @param {number} port - The port number to listen on.
 * @param {http.Server} [httpServer=null] - An optional existing HTTP server instance.
 */
function initializeWebSocketServer(port: number, httpServer: http.Server | null = null): void {
  const wss = httpServer ? new WebSocketServer({ server: httpServer }) : new WebSocketServer({ port });

  wss.on('error', (error: Error) => {
    console.error(`WebSocket server error: ${error.message}`);
  });

  wss.on('connection', (ws: WebSocket) => {
    const uuid = uuidv4();
    clients.set(uuid, ws);
    console.log(`Client connected with UUID: ${uuid}`);

    ws.on('message', (message: WebSocket.RawData) => {
      handleIncomingMessage(uuid, message);
    });

    // Handle client disconnection gracefully
    ws.on('close', () => {
      console.log(`Client disconnected with UUID: ${uuid}`);
      // Abort any running orchestrator task for this client
      const controller = abortControllers.get(uuid);
      if (controller) {
        controller.abort();
        console.log(`Aborted orchestrator task for client ${uuid}.`);
      }
      // Clean up all resources associated with the client
      clients.delete(uuid);
      orchestratorInstances.delete(uuid);
      abortControllers.delete(uuid);
      pendingTasks.delete(uuid);
    });

    ws.on('error', (error: Error) => {
      console.error(`WebSocket error for client ${uuid}: ${error.message}`);
      clients.delete(uuid);
      pendingTasks.delete(uuid);
    });
  });

  console.log(`WebSocket server started on port ${port}`);
}

/**
 * Sends a message to a specific client.
 * @param {string} clientUUID - The UUID of the client to send the message to.
 * @param {string} message - The message payload to send.
 */
function sendMessage(clientUUID: string, message: string): void {
  const ws = clients.get(clientUUID);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(message);
  } else {
    console.log(`Client ${clientUUID} not found or connection not open. Ready state: ${ws?.readyState}`);
  }
}

/**
 * Handles incoming messages from clients by parsing and routing them.
 * @param {string} clientUUID - The UUID of the client.
 * @param {WebSocket.RawData} message - The raw message received from the client.
 */
async function handleIncomingMessage(clientUUID: string, message: WebSocket.RawData): Promise<void> {
  try {
    const parsedMessage: WebSocketMessage = JSON.parse(message.toString());
    console.log(`Received message status ${parsedMessage.status} from client ${clientUUID}`);

    switch (parsedMessage.status) {
      case 'INITIAL_REQUEST_PARAMS':
        if (isInitialRequestData(parsedMessage.data)) {
          handleInitialRequestParams(clientUUID, parsedMessage.data);
        } else {
          console.error(`Error: invalid 'data' for INITIAL_REQUEST_PARAMS from client ${clientUUID}`);
        }
        break;

      case 'FILE_CHUNK':
        if (isFileChunkData(parsedMessage.data)) {
          handleFileChunk(clientUUID, parsedMessage.data);
        } else {
          console.error(`Error: invalid 'data' for FILE_CHUNK from client ${clientUUID}`);
        }
        break;

      case 'START_TASK':
        handleStartTask(clientUUID);
        break;

      case 'HITL_RESPONSE':
        if (parsedMessage.answer !== undefined) {
          handleHitlResponse(clientUUID, parsedMessage.answer);
        } else {
          console.error(`Error: 'messageId' or 'answer' is missing for HITL_RESPONSE from client ${clientUUID}`);
        }
        break;
      default:
        console.log(`Unknown message type: ${parsedMessage.status}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error parsing message from client ${clientUUID}: ${errorMessage}`);
  }
}

/**
 * Handles the initial request parameters (without files).
 * Stores the parameters and waits for file chunks.
 */
async function handleInitialRequestParams(clientUUID: string, requestData: InitialRequestData): Promise<void> {
  if (orchestratorInstances.has(clientUUID) || pendingTasks.has(clientUUID)) {
    sendMessage(clientUUID, JSON.stringify({ status: 'ERROR', message: 'A task is already running or pending for this client.' }));
    return;
  }

  try {
    if (!requestData.prompt || !requestData.llmName) {
      sendMessage(clientUUID, JSON.stringify({ status: 'ERROR', message: 'Error: prompt or llmName is missing' }));
      return;
    }

    // Initialize the files array and store the pending task
    requestData.files = [];
    pendingTasks.set(clientUUID, requestData);

    // Send acknowledgment to client
    sendMessage(clientUUID, JSON.stringify({ status: 'PARAMS_RECEIVED', message: 'Parameters received. Ready for files.' }));
    console.log(`Parameters received for client ${clientUUID}. Waiting for files.`);

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error handling initial params from client ${clientUUID}:`, error);
    sendMessage(clientUUID, JSON.stringify({ status: 'ERROR', message: `Parameter handling failed: ${errorMessage}\n` }));
  }
}

/**
 * Handles incoming file chunks and appends them to the pending task.
 */
async function handleFileChunk(clientUUID: string, chunkData: FileChunkData): Promise<void> {
  const task = pendingTasks.get(clientUUID);
  
  if (!task) {
    sendMessage(clientUUID, JSON.stringify({ status: 'ERROR', message: 'Error: No pending task found. Please send INITIAL_REQUEST_PARAMS first.' }));
    return;
  }

  const incomingFiles = chunkData.files;

  const existingFiles = task.files || [];
  if (existingFiles.length + incomingFiles.length > MAX_UPLOADED_FILES) {
    sendMessage(clientUUID, JSON.stringify({
      status: 'ERROR',
      message: `Error: Too many files uploaded. Maximum allowed is ${MAX_UPLOADED_FILES}.`
    }));
    return;
  }

  for (const file of incomingFiles) {
    if (!file.name.trim()) {
      sendMessage(clientUUID, JSON.stringify({ status: 'ERROR', message: 'Error: File name cannot be empty.' }));
      return;
    }
    const fileSize = base64Bytes(file.content);
    if (fileSize > MAX_SINGLE_FILE_BYTES) {
      sendMessage(clientUUID, JSON.stringify({
        status: 'ERROR',
        message: `Error: File ${file.name} exceeds max file size (${MAX_SINGLE_FILE_BYTES} bytes).`
      }));
      return;
    }
  }

  const existingBytes = existingFiles.reduce((sum, file) => sum + base64Bytes(file.content), 0);
  const incomingBytes = incomingFiles.reduce((sum, file) => sum + base64Bytes(file.content), 0);
  if (existingBytes + incomingBytes > MAX_TOTAL_UPLOAD_BYTES) {
    sendMessage(clientUUID, JSON.stringify({
      status: 'ERROR',
      message: `Error: Total upload size exceeds limit (${MAX_TOTAL_UPLOAD_BYTES} bytes).`
    }));
    return;
  }

  // Append received files to the task's file list
  task.files = existingFiles.concat(incomingFiles);
  console.log(`Received ${incomingFiles.length} files from client ${clientUUID}. Total files: ${task.files.length}`);

  // Send chunk acknowledgment
  sendMessage(clientUUID, JSON.stringify({ status: 'CHUNK_RECEIVED' }));
}

/**
 * Handles the signal to start the task after all files are uploaded.
 */
async function handleStartTask(clientUUID: string): Promise<void> {
  const taskData = pendingTasks.get(clientUUID);

  if (!taskData) {
    sendMessage(clientUUID, JSON.stringify({ status: 'ERROR', message: 'Error: No task data found to start.' }));
    return;
  }

  // Task data is complete. Remove it from pending and start the orchestrator.
  pendingTasks.delete(clientUUID);
  console.log(`All files received for client ${clientUUID}. Starting orchestrator...`);

  // Call the original handleInitialRequest function with the now-complete data
  await handleInitialRequest(clientUUID, taskData);
}


async function handleInitialRequest(clientUUID: string, requestData: InitialRequestData): Promise<void> {
  if (orchestratorInstances.has(clientUUID)) {
    sendMessage(clientUUID, JSON.stringify({ status: 'ERROR', message: 'An orchestrator task is already running for this client.' }));
    return;
  }

  try {
    if (!requestData.prompt || !requestData.llmName) {
      sendMessage(clientUUID, JSON.stringify({ status: 'ERROR', message: 'Error: prompt or llmName is missing' }));
      return;
    }

    const {
      prompt,
      image,
      imageMimeType,
      llmName,
      maxTurns,
      assumptions,
      files,
      saveFiles,
      mode,
      projectSpecification: requestProjectSpecification,
      environmentInstructions,
      notWorkingBuild,
      maxDurationMs,
      gracePeriodMs
    } = requestData;

    const projectSpecification = requestProjectSpecification ?? "";

    // 1. Create a new, request-specific Config instance
    const requestConfig = new Config({
      sessionId: randomUUID(),
      debugMode: false,
      model: llmName, 
      maxTurns: maxTurns ?? 20,
      assumptions: assumptions,
      embeddingModel: DEFAULT_GEMINI_EMBEDDING_MODEL,
      cwd: process.cwd(),
      question: '',
      fullContext: false,
    });

    const clientNimKey = requestData.secrets?.nvidiaApiKey?.trim();
    await requestConfig.refreshAuth(
      AuthType.USE_NIM,
      clientNimKey ? { nvidiaApiKey: clientNimKey } : undefined
    );

    const geminiClient = await requestConfig.getGeminiClient();

    const controller = new AbortController();

    const ws = clients.get(clientUUID);
    const progressQueue = ws ? new ProgressQueue(ws, clientUUID) : null;

    const sendMessageCallback = (message: any) => {
      // Route tagged updates (Strings and Promises) to the queue
      if (typeof message === 'object' && message !== null && message.type === 'PROGRESS_UPDATE') {
        if (progressQueue) {
          progressQueue.add(message.message);
        }
      } 
      // Fallback for standard stringified JSON (e.g., updateLog, status updates)
      else if (typeof message === 'string') {
        sendMessage(clientUUID, message);
      }
    };

    const fileMap = new Map<string, string>();
    const binaryFileMap = new Map<string, string>();
    if (files) {
      files.forEach(file => {
        const fileBuffer = Buffer.from(file.content, 'base64');
        
        if (isBinaryFileSync(fileBuffer)) {
          // If binary, store the original base64 content
          binaryFileMap.set(file.name, file.content);
        } else {
          // If text, decode to a UTF-8 string
          fileMap.set(file.name, fileBuffer.toString('utf-8'));
        }
      });
    }

    const secrets: UserSecrets = {
      nvidiaApiKey: requestData.secrets?.nvidiaApiKey?.trim() || process.env.NVIDIA_API_KEY || '',
      julesApiKey: requestData.secrets?.julesApiKey?.trim() || process.env.JULES_API_KEY || '',
      githubToken: requestData.secrets?.githubToken?.trim() || process.env.GITHUB_TOKEN || '',
      stitchApiKey: requestData.secrets?.stitchApiKey?.trim() || process.env.STITCH_API_KEY || '',
      e2BApiKey: requestData.secrets?.e2BApiKey?.trim() || process.env.E2B_API_KEY || '',
      githubScratchPadRepo: requestData.secrets?.githubScratchPadRepo?.trim() || process.env.GITHUB_SCRATCHPAD_REPO || '',
    };

    const orchestrator = new Orchestrator(
      prompt,
      image,
      imageMimeType,
      fileMap,
      binaryFileMap,
      geminiClient,
      sendMessageCallback,
      assumptions ?? '',
      llmName,
      saveFiles ?? false,
      secrets,
      requestConfig,
      'Untitled Session',
      projectSpecification,
      environmentInstructions,
      notWorkingBuild,
      controller.signal,
      mode,
      maxDurationMs,
      gracePeriodMs
    );

    orchestratorInstances.set(clientUUID, orchestrator);
    abortControllers.set(clientUUID, controller);

    console.log(`LOGGING: Invoking orchestrator for client ${clientUUID} using model ${llmName}`);
    sendMessage(clientUUID, JSON.stringify({ status: 'WORK_LOG', message: `# Orchestrator invoked successfully:\n${prompt}\n\n` }));

    // 3. Run the orchestrator asynchronously
    orchestrator.run()
      .catch(error => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`Orchestrator for client ${clientUUID} failed:`, error);
        sendMessage(clientUUID, JSON.stringify({ status: 'ERROR', message: `Orchestrator failed: ${errorMessage}\n` }));
      })
      .finally(() => {
        console.log(`Orchestrator task finished for client ${clientUUID}. Cleaning up.`);
        orchestratorInstances.delete(clientUUID);
        abortControllers.delete(clientUUID);
      });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error handling initial request from client ${clientUUID}:`, error);
    sendMessage(clientUUID, JSON.stringify({ status: 'ERROR', message: `Orchestrator/Analyzer invocation failed: ${errorMessage}\n` }));
  }
}

/**
 * @param {string} clientUUID - The UUID of the client.
 * @param {any} answer - The response data from the user.
 */
async function handleHitlResponse(clientUUID: string, answer: any): Promise<void> {
  const orchestrator = orchestratorInstances.get(clientUUID);

  if (orchestrator) {
    // The orchestrator's internal resolver handles the response.
    const normalizedAnswer = typeof answer === 'string' ? answer : JSON.stringify(answer);
    orchestrator.resolveHitl(normalizedAnswer);
  } else {
    console.error(`No active orchestrator found for client ${clientUUID} to handle HITL response.`);
  }
}

// Export the public functions
export {
  initializeWebSocketServer,
  handleIncomingMessage,
  handleInitialRequestParams,
  handleFileChunk,
  handleStartTask,
  handleInitialRequest,
  handleHitlResponse,
  sendMessage
};