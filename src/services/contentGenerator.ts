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

import OpenAI from "openai";
import {
  Content,
  Part,
  GenerateContentResponse,
  GenerateContentParameters,
  CountTokensParameters,
  CountTokensResponse,
  EmbedContentParameters,
  EmbedContentResponse,
  GetModelParameters,
  Model,
  FinishReason,
  BlockedReason,
  Tool,
} from "../shared/llmTypes.js";
import { DEFAULT_GEMINI_MODEL } from "../config/models.js";

/** NVIDIA NIM OpenAI-compatible base URL. */
const NIM_BASE_URL = "https://integrate.api.nvidia.com/v1";

/** Rough token estimate: 4 characters ≈ 1 token. */
function estimateTokens(contents: Content[]): number {
  let chars = 0;
  for (const c of contents) {
    for (const p of c.parts) {
      if (p.text) chars += p.text.length;
    }
  }
  return Math.ceil(chars / 4);
}

/** Convert internal Content[] to OpenAI chat messages. */
function contentsToMessages(contents: Content[]): OpenAI.ChatCompletionMessageParam[] {
  return contents.map((c) => {
    const role =
      c.role === "model" ? "assistant" : c.role === "user" ? "user" : "system";
    const text = c.parts
      .filter((p) => p.text !== undefined)
      .map((p) => p.text!)
      .join("");
    return { role, content: text } as OpenAI.ChatCompletionMessageParam;
  });
}

/** Convert an OpenAI ChatCompletion into our internal GenerateContentResponse shape. */
function chatCompletionToResponse(
  completion: OpenAI.ChatCompletion
): GenerateContentResponse {
  const choice = completion.choices[0];
  const message = choice?.message;

  const parts: Part[] = [];
  if (message?.content) {
    parts.push({ text: message.content });
  }
  if (message?.tool_calls) {
    for (const tc of message.tool_calls) {
      if (tc.type === "function") {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
        } catch {
          args = { raw: tc.function.arguments };
        }
        parts.push({ functionCall: { name: tc.function.name, args } });
      }
    }
  }

  const textContent = parts
    .filter((p) => p.text)
    .map((p) => p.text!)
    .join("");
  const stopReason = choice?.finish_reason;
  const finishReason =
    stopReason === "stop"
      ? FinishReason.STOP
      : stopReason === "length"
        ? FinishReason.MAX_TOKENS
        : FinishReason.FINISH_REASON_UNSPECIFIED;

  return {
    candidates: [
      {
        content: { role: "model", parts },
        finishReason,
        index: 0,
        safetyRatings: [],
      },
    ],
    promptFeedback: {
      blockReason: BlockedReason.BLOCKED_REASON_UNSPECIFIED,
      safetyRatings: [],
    },
    text: textContent,
    data: "",
    functionCalls:
      message?.tool_calls?.map((tc) => ({
        name: tc.type === "function" ? tc.function.name : "",
        args:
          tc.type === "function"
            ? (JSON.parse(tc.function.arguments || "{}") as unknown)
            : {},
      })) ?? [],
    executableCode: "",
    codeExecutionResult: "",
    usageMetadata: {
      promptTokenCount: completion.usage?.prompt_tokens,
      candidatesTokenCount: completion.usage?.completion_tokens,
      totalTokenCount: completion.usage?.total_tokens,
    },
  };
}

/** NIM-reported (or estimated) context limits by model prefix. */
const NIM_CONTEXT_LIMITS: Array<[string, number]> = [
  ["minimax/minimax-2", 1_000_000],
  ["minimax/minimax", 1_000_000],
  ["meta/llama", 128_000],
];

function getContextLimit(model: string): number {
  for (const [prefix, limit] of NIM_CONTEXT_LIMITS) {
    if (model.toLowerCase().startsWith(prefix)) return limit;
  }
  return 128_000;
}

/**
 * Interface abstracting the core functionalities for generating content and counting tokens.
 */
export interface ContentGenerator {
  generateContent(
    request: GenerateContentParameters
  ): Promise<GenerateContentResponse>;

  generateContentStream(
    request: GenerateContentParameters
  ): Promise<AsyncGenerator<GenerateContentResponse>>;

  countTokens(request: CountTokensParameters): Promise<CountTokensResponse>;

  embedContent(request: EmbedContentParameters): Promise<EmbedContentResponse>;

  get(params: GetModelParameters): Promise<Model>;
}

export enum AuthType {
  LOGIN_WITH_GOOGLE = "oauth-personal",
  /** Legacy alias kept for structural compatibility. */
  USE_GEMINI = "nvidia-nim-api-key",
  USE_NIM = "nvidia-nim-api-key",
  USE_VERTEX_AI = "vertex-ai",
  CLOUD_SHELL = "cloud-shell",
}

export type ContentGeneratorConfig = {
  model: string;
  apiKey?: string;
  authType?: AuthType | undefined;
};

export async function createContentGeneratorConfig(
  model: string | undefined,
  authType: AuthType | undefined,
  options?: Record<string, string>
): Promise<ContentGeneratorConfig> {
  const nvidiaApiKey = options?.nvidiaApiKey || process.env.NVIDIA_API_KEY;
  const effectiveModel = model || DEFAULT_GEMINI_MODEL;

  const contentGeneratorConfig: ContentGeneratorConfig = {
    model: effectiveModel,
    authType,
  };

  if (nvidiaApiKey) {
    contentGeneratorConfig.apiKey = nvidiaApiKey;
  }

  return contentGeneratorConfig;
}

class NimContentGenerator implements ContentGenerator {
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new OpenAI({ apiKey, baseURL: NIM_BASE_URL });
    this.model = model;
  }

  async generateContent(
    request: GenerateContentParameters
  ): Promise<GenerateContentResponse> {
    const messages = contentsToMessages(request.contents);
    const params: OpenAI.ChatCompletionCreateParamsNonStreaming = {
      model: request.model || this.model,
      messages,
      temperature: request.config?.temperature ?? 0.7,
      stream: false,
    };

    const tools: Tool[] = request.config?.tools ?? [];
    const funcDecls = tools.flatMap((t) => t.functionDeclarations ?? []);
    if (funcDecls.length > 0) {
      params.tools = funcDecls.map((fd) => ({
        type: "function" as const,
        function: {
          name: fd.name,
          description: fd.description ?? "",
          parameters: (fd.parameters ?? { type: "object", properties: {} }) as Record<string, unknown>,
        },
      })) as OpenAI.ChatCompletionTool[];
    }

    const completion = await this.client.chat.completions.create(params);
    return chatCompletionToResponse(completion);
  }

  async generateContentStream(
    request: GenerateContentParameters
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const messages = contentsToMessages(request.contents);
    const model = request.model || this.model;
    const temperature = request.config?.temperature ?? 0.7;
    const client = this.client;

    async function* gen(): AsyncGenerator<GenerateContentResponse> {
      const stream = await client.chat.completions.create({
        model,
        messages,
        temperature,
        stream: true,
      });
      let accumulated = "";
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content ?? "";
        if (delta) {
          accumulated += delta;
          yield {
            candidates: [
              {
                content: { role: "model", parts: [{ text: accumulated }] },
                finishReason: FinishReason.FINISH_REASON_UNSPECIFIED,
                index: 0,
              },
            ],
            text: accumulated,
            data: "",
            functionCalls: [],
            executableCode: "",
            codeExecutionResult: "",
          };
        }
      }
    }

    return gen();
  }

  async countTokens(
    request: CountTokensParameters
  ): Promise<CountTokensResponse> {
    // NIM has no dedicated token-count endpoint; estimate from character count.
    return { totalTokens: estimateTokens(request.contents) };
  }

  async embedContent(
    request: EmbedContentParameters
  ): Promise<EmbedContentResponse> {
    try {
      const texts = request.contents.flatMap((c) =>
        c.parts.filter((p) => p.text).map((p) => p.text!)
      );
      const response = await this.client.embeddings.create({
        model: "nvidia/nv-embedqa-e5-v5",
        input: texts,
      });
      return {
        embeddings: response.data.map((d) => ({ values: d.embedding })),
      };
    } catch {
      return { embeddings: [] };
    }
  }

  async get(params: GetModelParameters): Promise<Model> {
    return {
      inputTokenLimit: getContextLimit(params.model),
      outputTokenLimit: 65_536,
    };
  }
}

export async function createContentGenerator(
  config: ContentGeneratorConfig
): Promise<ContentGenerator> {
  if (!config.apiKey) {
    throw new Error(
      "NVIDIA API key is required. Set NVIDIA_API_KEY in your .env file."
    );
  }
  return new NimContentGenerator(config.apiKey, config.model);
}

/**
 * Resolves the API Key for a specific model based on environment variables.
 * Naming convention: NVIDIA_API_KEY_{MODEL_NAME_SANITIZED}
 * Example: minimax/MiniMax-M2.7 -> NVIDIA_API_KEY_MINIMAX_MINIMAX_M2_7
 * Falls back to defaultApiKey if no specific env var is found.
 */
export function resolveApiKeyForModel(
  model: string,
  defaultApiKey?: string
): string | undefined {
  if (!model) return defaultApiKey;
  const sanitizedModel = model.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const envVarName = `NVIDIA_API_KEY_${sanitizedModel}`;
  return process.env[envVarName] ?? defaultApiKey;
}
