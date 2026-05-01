const MAX_PAYLOAD_SIZE = 25 * 1024 * 1024;
const EXCLUDED_SEGMENTS = ['/.git/', '/node_modules/', '/dist/', '/bin/', '/obj/'];
const SETTINGS_KEY = 'momoa_settings';
const DEFAULT_SERVER_URL = 'ws://localhost:3007';

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function settingsAreComplete() {
  const s = loadSettings();
  return Boolean(s.serverUrl && s.nimApiKey);
}

const state = {
  sessions: [],
  activeSessionId: null,
};

const elements = {
  form: document.querySelector('#launch-form'),
  settingsOverlay: document.querySelector('#settings-overlay'),
  settingsForm: document.querySelector('#settings-form'),
  settingsServerUrl: document.querySelector('#settings-server-url'),
  settingsNimKey: document.querySelector('#settings-nim-key'),
  settingsSave: document.querySelector('#settings-save'),
  settingsCancel: document.querySelector('#settings-cancel'),
  openSettings: document.querySelector('#open-settings'),
  settingsServerDisplay: document.querySelector('#settings-server-display'),
  prompt: document.querySelector('#prompt'),
  mode: document.querySelector('#mode'),
  maxTurns: document.querySelector('#max-turns'),
  assumptions: document.querySelector('#assumptions'),
  spec: document.querySelector('#spec'),
  envInstructions: document.querySelector('#env-instructions'),
  fileInput: document.querySelector('#file-input'),
  directoryInput: document.querySelector('#directory-input'),
  saveFiles: document.querySelector('#save-files'),
  launchButton: document.querySelector('#launch-button'),
  selectionSummary: document.querySelector('#selection-summary'),
  sessionList: document.querySelector('#session-list'),
  sessionTitle: document.querySelector('#session-title'),
  sessionStatus: document.querySelector('#session-status'),
  sessionFiles: document.querySelector('#session-files'),
  sessionBytes: document.querySelector('#session-bytes'),
  sessionUpdates: document.querySelector('#session-updates'),
  progressStream: document.querySelector('#progress-stream'),
  resultOutput: document.querySelector('#result-output'),
  downloads: document.querySelector('#downloads'),
  questionPanel: document.querySelector('#question-panel'),
  questionText: document.querySelector('#question-text'),
  questionAnswer: document.querySelector('#question-answer'),
  submitAnswer: document.querySelector('#submit-answer'),
  copyLog: document.querySelector('#copy-log'),
  clearSessions: document.querySelector('#clear-sessions'),
  sessionItemTemplate: document.querySelector('#session-item-template'),
};

function createSession({ title, files, totalBytes }) {
  return {
    id: crypto.randomUUID(),
    title,
    files,
    totalBytes,
    status: 'connecting',
    updates: [],
    result: '',
    downloads: [],
    ws: null,
    chunks: [],
    queueIndex: 0,
    pendingQuestion: null,
    createdAt: new Date(),
  };
}

function getActiveSession() {
  return state.sessions.find((session) => session.id === state.activeSessionId) ?? null;
}

function setActiveSession(sessionId) {
  state.activeSessionId = sessionId;
  renderSessions();
  renderActiveSession();
}

function addUpdate(session, text, kind = 'info') {
  session.updates.push({
    id: crypto.randomUUID(),
    text,
    kind,
    at: new Date(),
  });
  if (state.activeSessionId === session.id) {
    renderActiveSession();
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatTimestamp(date) {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

function sanitizeRelativePath(file) {
  const path = (file.webkitRelativePath || file.name || '').replaceAll('\\', '/');
  const normalized = path.startsWith('/') ? path : `/${path}`;
  if (EXCLUDED_SEGMENTS.some((segment) => normalized.includes(segment))) {
    return null;
  }
  return path || file.name;
}

async function fileToBase64(file) {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

async function collectSelectedFiles() {
  const chosen = new Map();
  for (const file of [...elements.fileInput.files, ...elements.directoryInput.files]) {
    const relativePath = sanitizeRelativePath(file);
    if (!relativePath) continue;
    chosen.set(relativePath, file);
  }

  const entries = [];
  for (const [name, file] of chosen.entries()) {
    entries.push({
      name,
      content: await fileToBase64(file),
      size: file.size,
    });
  }
  return entries;
}

function buildFileChunks(files) {
  const chunks = [];
  let currentChunk = [];
  let currentSize = 0;

  for (const file of files) {
    const estimatedSize = new TextEncoder().encode(file.name).length + new TextEncoder().encode(file.content).length;
    if (currentChunk.length > 0 && currentSize + estimatedSize > MAX_PAYLOAD_SIZE) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentSize = 0;
    }
    currentChunk.push(file);
    currentSize += estimatedSize;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

function decodeBase64ToBlob(base64Content) {
  const binary = atob(base64Content);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes]);
}

function addDownloadFile(session, file) {
  const existing = session.downloads.find((entry) => entry.name === file.name);
  const blob = decodeBase64ToBlob(file.content);
  const objectUrl = URL.createObjectURL(blob);

  if (existing?.objectUrl) {
    URL.revokeObjectURL(existing.objectUrl);
  }

  const record = { name: file.name, objectUrl };
  if (existing) {
    existing.objectUrl = objectUrl;
  } else {
    session.downloads.unshift(record);
  }
}

function handleIncomingMessage(session, payload) {
  const data = JSON.parse(payload.data);
  switch (data.status) {
    case 'PARAMS_RECEIVED': {
      session.status = 'uploading';
      addUpdate(session, 'Server acknowledged parameters. Uploading files.');
      sendNextChunk(session);
      break;
    }
    case 'CHUNK_RECEIVED': {
      sendNextChunk(session);
      break;
    }
    case 'PROGRESS_UPDATES': {
      session.status = 'running';
      const completed = data.completed_status_message;
      const current = data.current_status_message;
      if (completed) addUpdate(session, completed, 'progress');
      if (current) addUpdate(session, current, 'progress');
      break;
    }
    case 'WORK_LOG': {
      if (data.message) addUpdate(session, data.message, 'worklog');
      break;
    }
    case 'APPLY_FILE_CHANGE': {
      const change = data.data;
      if (change?.filename && change?.content) {
        addDownloadFile(session, { name: change.filename, content: change.content });
        addUpdate(session, `Updated file: ${change.filename}`, 'file');
      }
      break;
    }
    case 'HITL_QUESTION': {
      session.pendingQuestion = data.message ?? 'The agent asked a question.';
      addUpdate(session, `Agent question: ${session.pendingQuestion}`, 'question');
      break;
    }
    case 'COMPLETE_RESULT': {
      session.status = 'complete';
      session.result = data.data?.result ?? data.result ?? 'No result text received.';
      const filesPayload = data.data?.files;
      if (filesPayload) {
        try {
          const receivedFiles = JSON.parse(filesPayload);
          for (const file of receivedFiles) {
            if (file?.name && typeof file.content === 'string') {
              addDownloadFile(session, file);
            }
          }
        } catch {
          addUpdate(session, 'Could not decode returned files payload.', 'error');
        }
      }
      addUpdate(session, 'Project completed.', 'complete');
      session.ws?.close();
      break;
    }
    case 'ERROR': {
      session.status = 'error';
      addUpdate(session, data.message ?? 'Unknown server error.', 'error');
      break;
    }
    default: {
      addUpdate(session, `Unhandled message: ${data.status}`, 'info');
      break;
    }
  }

  if (state.activeSessionId === session.id) {
    renderActiveSession();
  }
  renderSessions();
}

function sendNextChunk(session) {
  if (!session.ws) return;
  const chunks = session.chunks;
  if (session.queueIndex < chunks.length) {
    const chunk = chunks[session.queueIndex];
    session.ws.send(JSON.stringify({
      status: 'FILE_CHUNK',
      data: { files: chunk },
    }));
    addUpdate(session, `Uploading chunk ${session.queueIndex + 1} of ${chunks.length} (${chunk.length} files).`);
    session.queueIndex += 1;
    return;
  }

  session.status = 'running';
  session.ws.send(JSON.stringify({ status: 'START_TASK', data: {} }));
  addUpdate(session, 'All files uploaded. Task started.');
}

function createWebSocketUrl() {
  const saved = loadSettings().serverUrl;
  if (saved && saved.trim()) return saved.trim();
  return DEFAULT_SERVER_URL;
}

function applySettingsToUI() {
  const s = loadSettings();
  const display = elements.settingsServerDisplay;
  if (display) {
    const endpoint = s.serverUrl || DEFAULT_SERVER_URL;
    display.textContent = `MoMoA WS: ${endpoint}`;
  }
}

function openSettingsOverlay() {
  const s = loadSettings();
  elements.settingsServerUrl.value = s.serverUrl || DEFAULT_SERVER_URL;
  elements.settingsNimKey.value = s.nimApiKey || '';
  elements.settingsOverlay.classList.remove('hidden');
  elements.settingsServerUrl.focus();
}

function closeSettingsOverlay() {
  elements.settingsOverlay.classList.add('hidden');
}

function launchSession(session, requestPayload) {
  const ws = new WebSocket(createWebSocketUrl());
  session.ws = ws;

  ws.addEventListener('open', () => {
    session.status = 'awaiting-ack';
    addUpdate(session, 'Connected to server. Sending initial parameters.');
    ws.send(JSON.stringify({
      status: 'INITIAL_REQUEST_PARAMS',
      data: requestPayload,
    }));
    renderSessions();
    renderActiveSession();
  });

  ws.addEventListener('message', (payload) => handleIncomingMessage(session, payload));

  ws.addEventListener('close', () => {
    if (session.status !== 'complete' && session.status !== 'error') {
      session.status = 'closed';
      addUpdate(session, 'Connection closed.', 'info');
      renderSessions();
      renderActiveSession();
    }
  });

  ws.addEventListener('error', () => {
    session.status = 'error';
    addUpdate(session, 'WebSocket error while communicating with the server.', 'error');
    renderSessions();
    renderActiveSession();
  });
}

function renderSessions() {
  elements.sessionList.innerHTML = '';
  for (const session of [...state.sessions].reverse()) {
    const fragment = elements.sessionItemTemplate.content.cloneNode(true);
    const button = fragment.querySelector('.session-item');
    const title = fragment.querySelector('.session-item-title');
    const meta = fragment.querySelector('.session-item-meta');
    title.textContent = session.title;
    meta.textContent = `${session.status} • ${formatTimestamp(session.createdAt)}`;
    if (session.id === state.activeSessionId) {
      button.classList.add('active');
    }
    button.addEventListener('click', () => setActiveSession(session.id));
    elements.sessionList.appendChild(fragment);
  }
}

function renderDownloads(session) {
  elements.downloads.innerHTML = '';
  if (session.downloads.length === 0) {
    elements.downloads.textContent = 'No returned files yet.';
    return;
  }

  for (const file of session.downloads) {
    const item = document.createElement('div');
    item.className = 'download-item';
    const label = document.createElement('code');
    label.textContent = file.name;
    const link = document.createElement('a');
    link.href = file.objectUrl;
    link.download = file.name.split('/').at(-1) ?? file.name;
    link.textContent = 'Download';
    link.className = 'ghost-button';
    item.append(label, link);
    elements.downloads.appendChild(item);
  }
}

function renderProgress(session) {
  elements.progressStream.innerHTML = '';
  if (session.updates.length === 0) {
    elements.progressStream.textContent = 'No updates yet.';
    return;
  }

  for (const entry of session.updates) {
    const container = document.createElement('div');
    container.className = 'stream-entry';
    const time = document.createElement('time');
    time.textContent = formatTimestamp(entry.at);
    const body = document.createElement('div');
    body.textContent = entry.text;
    container.append(time, body);
    elements.progressStream.appendChild(container);
  }
  elements.progressStream.scrollTop = elements.progressStream.scrollHeight;
}

function renderActiveSession() {
  const session = getActiveSession();
  if (!session) {
    elements.sessionTitle.textContent = 'No session selected';
    elements.sessionStatus.textContent = 'Idle';
    elements.sessionStatus.className = 'status-chip idle';
    elements.sessionFiles.textContent = '0';
    elements.sessionBytes.textContent = '0 B';
    elements.sessionUpdates.textContent = '0';
    elements.progressStream.textContent = 'Launch a project to start monitoring.';
    elements.resultOutput.textContent = '';
    elements.downloads.textContent = 'No returned files yet.';
    elements.questionPanel.classList.add('hidden');
    return;
  }

  elements.sessionTitle.textContent = session.title;
  elements.sessionStatus.textContent = session.status;
  elements.sessionStatus.className = `status-chip ${session.status}`;
  elements.sessionFiles.textContent = String(session.files.length);
  elements.sessionBytes.textContent = formatBytes(session.totalBytes);
  elements.sessionUpdates.textContent = String(session.updates.length);
  elements.resultOutput.textContent = session.result;
  renderProgress(session);
  renderDownloads(session);

  if (session.pendingQuestion) {
    elements.questionPanel.classList.remove('hidden');
    elements.questionText.textContent = session.pendingQuestion;
  } else {
    elements.questionPanel.classList.add('hidden');
    elements.questionText.textContent = '';
  }
}

function updateSelectionSummary() {
  const files = [...elements.fileInput.files, ...elements.directoryInput.files]
    .map((file) => ({ file, path: sanitizeRelativePath(file) }))
    .filter((entry) => Boolean(entry.path));
  const totalBytes = files.reduce((sum, entry) => sum + entry.file.size, 0);
  elements.selectionSummary.textContent = files.length === 0
    ? 'No files selected.'
    : `${files.length} files selected • ${formatBytes(totalBytes)}`;
}

elements.fileInput.addEventListener('change', updateSelectionSummary);
elements.directoryInput.addEventListener('change', updateSelectionSummary);

elements.form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const prompt = elements.prompt.value.trim();
  if (!prompt) {
    window.alert('Prompt is required.');
    return;
  }

  elements.launchButton.disabled = true;
  elements.launchButton.textContent = 'Preparing Files...';

  try {
    const files = await collectSelectedFiles();
    const totalBytes = files.reduce((sum, file) => sum + (file.size ?? 0), 0);
    const session = createSession({
      title: prompt.slice(0, 64),
      files,
      totalBytes,
    });

    session.chunks = buildFileChunks(files);
    state.sessions.push(session);
    setActiveSession(session.id);
    addUpdate(session, `Prepared ${files.length} files for upload.`);

    const { nimApiKey } = loadSettings();
    const requestPayload = {
      prompt,
      image: '',
      imageMimeType: '',
      llmName: 'Unused',
      maxTurns: Number.parseInt(elements.maxTurns.value, 10) || 15,
      assumptions: elements.assumptions.value,
      clientUUID: session.id,
      projectSpecification: elements.spec.value,
      environmentInstructions: elements.envInstructions.value,
      saveFiles: elements.saveFiles.checked,
      mode: elements.mode.value,
      secrets: {
        nvidiaApiKey: nimApiKey || '',
      },
    };

    launchSession(session, requestPayload);
  } catch (error) {
    window.alert(error instanceof Error ? error.message : String(error));
  } finally {
    elements.launchButton.disabled = false;
    elements.launchButton.textContent = 'Launch Project';
  }
});

elements.submitAnswer.addEventListener('click', () => {
  const session = getActiveSession();
  if (!session?.ws || !session.pendingQuestion) return;
  session.ws.send(JSON.stringify({
    status: 'HITL_RESPONSE',
    answer: elements.questionAnswer.value,
  }));
  addUpdate(session, `Answered HITL prompt: ${elements.questionAnswer.value || '(empty answer)'}`);
  session.pendingQuestion = null;
  elements.questionAnswer.value = '';
  renderActiveSession();
});

elements.copyLog.addEventListener('click', async () => {
  const session = getActiveSession();
  if (!session) return;
  const text = session.updates.map((entry) => `[${formatTimestamp(entry.at)}] ${entry.text}`).join('\n\n');
  await navigator.clipboard.writeText(text);
});

elements.clearSessions.addEventListener('click', () => {
  for (const session of state.sessions) {
    session.ws?.close();
    for (const file of session.downloads) {
      URL.revokeObjectURL(file.objectUrl);
    }
  }
  state.sessions = [];
  state.activeSessionId = null;
  renderSessions();
  renderActiveSession();
});

// ── Settings overlay wiring ────────────────────────────────────────────────

elements.settingsForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const serverUrl = elements.settingsServerUrl.value.trim();
  const nimApiKey = elements.settingsNimKey.value.trim();
  if (!serverUrl) {
    window.alert('Server URL is required.');
    return;
  }
  if (!/^wss?:\/\//i.test(serverUrl)) {
    window.alert('Server URL must start with ws:// or wss://');
    return;
  }
  if (serverUrl.toLowerCase().includes('integrate.api.nvidia.com')) {
    window.alert('Use your MoMoA WebSocket server URL here, not the NVIDIA REST API URL.');
    return;
  }
  if (!nimApiKey) {
    window.alert('NVIDIA NIM API key is required.');
    return;
  }
  saveSettings({ serverUrl, nimApiKey });
  applySettingsToUI();
  closeSettingsOverlay();
});

elements.settingsCancel.addEventListener('click', () => {
  if (settingsAreComplete()) {
    closeSettingsOverlay();
  } else {
    window.alert('Please configure your server URL and API key before continuing.');
  }
});

elements.openSettings.addEventListener('click', () => openSettingsOverlay());

// Show overlay on first load if settings are missing
if (!settingsAreComplete()) {
  openSettingsOverlay();
}

applySettingsToUI();

// ── Initial render ──────────────────────────────────────────────────────────

renderSessions();
renderActiveSession();
