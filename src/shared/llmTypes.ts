/**
 * Local type definitions replacing @google/genai SDK types.
 * These mirror the shapes used throughout the codebase so no
 * call-sites outside of contentGenerator / geminiClient need to change.
 */

export interface Part {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { role: string; name: string; response: string };
  thought?: boolean;
}

export interface Content {
  role: string;
  parts: Part[];
}

export enum FinishReason {
  FINISH_REASON_UNSPECIFIED = 'FINISH_REASON_UNSPECIFIED',
  STOP = 'STOP',
  MAX_TOKENS = 'MAX_TOKENS',
  SAFETY = 'SAFETY',
  RECITATION = 'RECITATION',
  OTHER = 'OTHER',
}

export enum BlockedReason {
  BLOCKED_REASON_UNSPECIFIED = 'BLOCKED_REASON_UNSPECIFIED',
}

export interface Candidate {
  content?: Content;
  finishReason?: FinishReason;
  index?: number;
  safetyRatings?: unknown[];
}

export interface GenerateContentResponse {
  candidates?: Candidate[];
  promptFeedback?: {
    blockReason?: BlockedReason;
    safetyRatings?: unknown[];
  };
  text?: string;
  data?: string;
  functionCalls?: unknown[];
  executableCode?: string;
  codeExecutionResult?: string;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    cachedContentTokenCount?: number;
  };
}

export interface GenerateContentConfig {
  temperature?: number;
  tools?: Tool[];
  responseMimeType?: string;
  thinkingConfig?: { includeThoughts?: boolean };
  systemInstruction?: Content;
}

export interface GenerateContentParameters {
  model: string;
  contents: Content[];
  config?: GenerateContentConfig;
}

export interface CountTokensResponse {
  totalTokens?: number;
}

export interface CountTokensParameters {
  model: string;
  contents: Content[];
}

export interface EmbedContentResponse {
  embeddings?: Array<{ values: number[] }>;
}

export interface EmbedContentParameters {
  model: string;
  contents: Content[];
}

export interface GetModelParameters {
  model: string;
}

export interface Model {
  inputTokenLimit?: number;
  outputTokenLimit?: number;
}

export interface FunctionDeclaration {
  name: string;
  description?: string;
  parameters?: unknown;
}

export interface Tool {
  functionDeclarations?: FunctionDeclaration[];
  /** Ignored on NIM — kept for structural compatibility */
  googleSearch?: Record<string, never>;
}

/** Type enum for function parameter schemas (OpenAI-compatible lowercase values). */
export enum Type {
  OBJECT = 'object',
  STRING = 'string',
  NUMBER = 'number',
  INTEGER = 'integer',
  BOOLEAN = 'boolean',
  ARRAY = 'array',
}
