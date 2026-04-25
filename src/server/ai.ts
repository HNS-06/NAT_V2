import type { Express, Request, Response } from "express";
import { GoogleGenAI } from "@google/genai";
import { Memory } from "../types";

type AiProvider = "gemini" | "openai" | "anthropic" | "groq";

type ChatHistoryEntry = {
  role: "user" | "model";
  parts: Array<{ text?: string }>;
};

type ChatAttachment = {
  data: string;
  mimeType: string;
  name?: string;
};

export type AssistantHistoryEntry = ChatHistoryEntry;
export type AssistantAttachment = ChatAttachment;

type ProviderRuntime = {
  provider: AiProvider;
  apiKey: string;
  chatModel: string;
  analysisModel: string;
};

const PROVIDER_ENV_KEYS: Record<AiProvider, string> = {
  gemini: "GEMINI_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  groq: "GROQ_API_KEY",
};

const DEFAULT_CHAT_MODELS: Record<AiProvider, string> = {
  gemini: "gemini-2.5-flash",
  openai: "gpt-4.1-mini",
  anthropic: "claude-sonnet-4-20250514",
  groq: "llama-3.3-70b-versatile",
};

const DEFAULT_ANALYSIS_MODELS: Record<AiProvider, string> = {
  gemini: "gemini-2.5-flash",
  openai: "gpt-4.1-mini",
  anthropic: "claude-3-5-haiku-latest",
  groq: "llama-3.3-70b-versatile",
};

const SUPPORTED_MODELS: Record<AiProvider, { chat: string[]; analysis: string[] }> = {
  gemini: {
    chat: ["gemini-2.5-flash", "gemini-2.5-pro"],
    analysis: ["gemini-2.5-flash", "gemini-2.5-pro"],
  },
  openai: {
    chat: ["gpt-4.1-mini", "gpt-4.1"],
    analysis: ["gpt-4.1-mini", "gpt-4.1"],
  },
  anthropic: {
    chat: ["claude-sonnet-4-20250514", "claude-3-7-sonnet-latest"],
    analysis: ["claude-3-5-haiku-latest", "claude-sonnet-4-20250514"],
  },
  groq: {
    chat: ["llama-3.3-70b-versatile", "openai/gpt-oss-120b"],
    analysis: ["llama-3.3-70b-versatile", "openai/gpt-oss-120b"],
  },
};

const SYSTEM_PROMPT = `You are NAT, a next-generation adaptive AI assistant.
PERSONALITY:
- Intelligent, calm, adaptive, and context-aware.
- You are not just a chatbot; you are a digital companion.
- You remember user details and adapt your behavior based on their preferences.

CONTEXT HANDLING:
- You will be provided with user memories. Use them naturally in conversation.
- If the user provides new important information (preferences, goals, habits), acknowledge it.
- You can analyze files when the provider supports them. If a file cannot be directly inspected, be transparent and still help from the metadata that was provided.

RESPONSE STYLE:
- Professional yet warm.
- Concise but helpful.
- For complex visual concepts, describe them vividly.`;

const JSON_TASK_SYSTEM_PROMPT = `You are a backend extraction service for NAT.
Return strict JSON only, with no markdown fences, commentary, or extra prose.`;

function getConfiguredProviders(): AiProvider[] {
  return (Object.keys(PROVIDER_ENV_KEYS) as AiProvider[]).filter((provider) =>
    Boolean(process.env[PROVIDER_ENV_KEYS[provider]]?.trim()),
  );
}

function getProviderOrder(): AiProvider[] {
  const requestedOrder = process.env.AI_FALLBACK_ORDER
    ?.split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean) as AiProvider[] | undefined;

  const normalized = requestedOrder?.filter((provider) => provider in PROVIDER_ENV_KEYS);
  return normalized && normalized.length > 0
    ? normalized
    : ["gemini", "openai", "anthropic", "groq"];
}

function buildRuntimeProvider(provider: AiProvider): ProviderRuntime {
  const apiKey = process.env[PROVIDER_ENV_KEYS[provider]]?.trim();
  if (!apiKey) {
    throw new Error(`Missing API key for provider "${provider}".`);
  }

  return {
    provider,
    apiKey,
    chatModel: process.env.AI_MODEL?.trim() || DEFAULT_CHAT_MODELS[provider],
    analysisModel: process.env.AI_ANALYSIS_MODEL?.trim() || DEFAULT_ANALYSIS_MODELS[provider],
  };
}

function resolveRuntimeProviders(requestedProvider?: unknown): ProviderRuntime[] {
  const configuredProviders = getConfiguredProviders();
  if (configuredProviders.length === 0) {
    throw new Error(
      "No AI provider is configured. Add one of GEMINI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, or GROQ_API_KEY.",
    );
  }

  const requested =
    typeof requestedProvider === "string" && requestedProvider.trim()
      ? requestedProvider.trim().toLowerCase()
      : process.env.AI_PROVIDER?.trim().toLowerCase() || "auto";

  let provider: AiProvider | undefined;
  if (requested !== "auto") {
    if (!(requested in PROVIDER_ENV_KEYS)) {
      throw new Error(`Unsupported AI provider "${requested}".`);
    }
    provider = requested as AiProvider;
    if (!configuredProviders.includes(provider)) {
      throw new Error(
        `AI provider "${provider}" is selected but ${PROVIDER_ENV_KEYS[provider]} is not configured.`,
      );
    }
  } else {
    provider = getProviderOrder().find((candidate) => configuredProviders.includes(candidate));
  }

  if (!provider) {
    throw new Error("Unable to resolve an AI provider from the configured environment.");
  }

  if (requested !== "auto") {
    return [buildRuntimeProvider(provider)];
  }

  return getProviderOrder()
    .filter((candidate) => configuredProviders.includes(candidate))
    .map((candidate) => buildRuntimeProvider(candidate));
}

function buildMemoryContext(memories: Memory[]): string {
  if (!memories.length) {
    return "";
  }

  return `\n\nUSER MEMORIES:\n${memories.map((memory) => `- ${memory.key}: ${memory.value}`).join("\n")}`;
}

function flattenParts(parts: Array<{ text?: string }>): string {
  return parts
    .map((part) => part.text?.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function summarizeAttachments(attachments: ChatAttachment[]): string[] {
  return attachments.map((attachment, index) => {
    const label = attachment.name?.trim() || `Attachment ${index + 1}`;
    return `${label} (${attachment.mimeType || "application/octet-stream"})`;
  });
}

function buildTextWithAttachmentNotes(message: string, attachments: ChatAttachment[]): string {
  const sections: string[] = [];
  if (message.trim()) {
    sections.push(message.trim());
  }

  if (attachments.length > 0) {
    sections.push(`Attachments:\n${summarizeAttachments(attachments).map((item) => `- ${item}`).join("\n")}`);
  }

  return sections.join("\n\n").trim();
}

function toDataUrl(attachment: ChatAttachment): string {
  return `data:${attachment.mimeType};base64,${attachment.data}`;
}

function isImageAttachment(attachment: ChatAttachment): boolean {
  return attachment.mimeType.startsWith("image/");
}

function createOpenAiCompatibleMessages(
  message: string,
  history: ChatHistoryEntry[],
  memories: Memory[],
  attachments: ChatAttachment[],
) {
  const messages: any[] = [
    {
      role: "system",
      content: SYSTEM_PROMPT + buildMemoryContext(memories),
    },
  ];

  for (const entry of history) {
    const content = flattenParts(entry.parts);
    if (!content) {
      continue;
    }

    messages.push({
      role: entry.role === "user" ? "user" : "assistant",
      content,
    });
  }

  const userContent: any[] = [];
  const textContent = buildTextWithAttachmentNotes(message, attachments);
  if (textContent) {
    userContent.push({ type: "text", text: textContent });
  }

  for (const attachment of attachments) {
    if (isImageAttachment(attachment)) {
      userContent.push({
        type: "image_url",
        image_url: {
          url: toDataUrl(attachment),
        },
      });
    }
  }

  if (userContent.length === 0) {
    userContent.push({ type: "text", text: "Continue the conversation." });
  }

  messages.push({
    role: "user",
    content: userContent,
  });

  return messages;
}

function createAnthropicMessages(
  message: string,
  history: ChatHistoryEntry[],
  attachments: ChatAttachment[],
) {
  const messages: any[] = [];

  for (const entry of history) {
    const content = flattenParts(entry.parts);
    if (!content) {
      continue;
    }

    messages.push({
      role: entry.role === "user" ? "user" : "assistant",
      content,
    });
  }

  const userContent: any[] = [];
  const textContent = buildTextWithAttachmentNotes(message, attachments);
  if (textContent) {
    userContent.push({ type: "text", text: textContent });
  }

  for (const attachment of attachments) {
    if (!isImageAttachment(attachment)) {
      continue;
    }

    userContent.push({
      type: "image",
      source: {
        type: "base64",
        media_type: attachment.mimeType,
        data: attachment.data,
      },
    });
  }

  if (userContent.length === 0) {
    userContent.push({ type: "text", text: "Continue the conversation." });
  }

  messages.push({
    role: "user",
    content: userContent,
  });

  return messages;
}

function createGeminiParts(message: string, attachments: ChatAttachment[]) {
  const parts: any[] = [];
  const textContent = buildTextWithAttachmentNotes(message, attachments);
  if (textContent) {
    parts.push({ text: textContent });
  }

  for (const attachment of attachments) {
    parts.push({
      inlineData: {
        data: attachment.data,
        mimeType: attachment.mimeType,
      },
    });
  }

  if (parts.length === 0) {
    parts.push({ text: "Continue the conversation." });
  }

  return parts;
}

async function readErrorResponse(response: globalThis.Response): Promise<string> {
  const text = await response.text();
  if (!text) {
    return `${response.status} ${response.statusText}`;
  }

  try {
    const payload = JSON.parse(text);
    return (
      payload?.error?.message ||
      payload?.message ||
      payload?.error ||
      text
    );
  } catch {
    return text;
  }
}

async function* parseSseStream(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  let dataLines: string[] = [];

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) {
        if (dataLines.length > 0) {
          yield { event: eventName, data: dataLines.join("\n") };
        }
        eventName = "message";
        dataLines = [];
        continue;
      }

      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
        continue;
      }

      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
      }
    }
  }

  if (buffer.trim() && buffer.startsWith("data:")) {
    dataLines.push(buffer.slice(5).trim());
  }

  if (dataLines.length > 0) {
    yield { event: eventName, data: dataLines.join("\n") };
  }
}

function extractOpenAiText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if (part?.type === "text" && typeof part.text === "string") {
        return part.text;
      }
      return "";
    })
    .join("");
}

function extractAnthropicText(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : ""))
    .join("");
}

function sanitizeJsonText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("```")) {
    return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  }
  return trimmed;
}

function parseJsonResponse<T>(text: string, fallback: T): T {
  const sanitized = sanitizeJsonText(text);
  const candidates = [
    sanitized,
    sanitized.match(/\[[\s\S]*\]/)?.[0],
    sanitized.match(/\{[\s\S]*\}/)?.[0],
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      continue;
    }
  }

  return fallback;
}

async function openGeminiResponseStream(
  runtime: ProviderRuntime,
  message: string,
  history: ChatHistoryEntry[],
  memories: Memory[],
  attachments: ChatAttachment[],
) {
  const ai = new GoogleGenAI({ apiKey: runtime.apiKey });
  const chat = ai.chats.create({
    model: runtime.chatModel,
    history,
    config: {
      systemInstruction: SYSTEM_PROMPT + buildMemoryContext(memories),
    },
  });

  const stream = await chat.sendMessageStream({
    message: createGeminiParts(message, attachments),
  });

  return (async function* () {
    for await (const chunk of stream) {
      if (chunk.text) {
        yield chunk.text;
      }
    }
  })();
}

async function openOpenAiCompatibleResponseStream(
  runtime: ProviderRuntime,
  baseUrl: string,
  message: string,
  history: ChatHistoryEntry[],
  memories: Memory[],
  attachments: ChatAttachment[],
) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${runtime.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: runtime.chatModel,
      stream: true,
      temperature: 0.7,
      messages: createOpenAiCompatibleMessages(message, history, memories, attachments),
    }),
  });

  if (!response.ok) {
    throw new Error(await readErrorResponse(response));
  }

  if (!response.body) {
    throw new Error("The AI provider did not return a response stream.");
  }

  return (async function* () {
    for await (const event of parseSseStream(response.body!)) {
      if (!event.data || event.data === "[DONE]") {
        continue;
      }

      const payload = JSON.parse(event.data);
      const delta = payload?.choices?.[0]?.delta?.content;

      if (typeof delta === "string" && delta) {
        yield delta;
        continue;
      }

      if (Array.isArray(delta)) {
        for (const part of delta) {
          if (part?.type === "text" && typeof part.text === "string" && part.text) {
            yield part.text;
          }
        }
      }
    }
  })();
}

async function openAnthropicResponseStream(
  runtime: ProviderRuntime,
  message: string,
  history: ChatHistoryEntry[],
  memories: Memory[],
  attachments: ChatAttachment[],
) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": runtime.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: runtime.chatModel,
      max_tokens: 2048,
      stream: true,
      system: SYSTEM_PROMPT + buildMemoryContext(memories),
      messages: createAnthropicMessages(message, history, attachments),
    }),
  });

  if (!response.ok) {
    throw new Error(await readErrorResponse(response));
  }

  if (!response.body) {
    throw new Error("The AI provider did not return a response stream.");
  }

  return (async function* () {
    for await (const event of parseSseStream(response.body!)) {
      if (!event.data) {
        continue;
      }

      const payload = JSON.parse(event.data);
      if (event.event === "content_block_delta" && payload?.delta?.type === "text_delta" && payload.delta.text) {
        yield payload.delta.text;
      }
    }
  })();
}

async function openChatResponseStream(
  runtime: ProviderRuntime,
  message: string,
  history: ChatHistoryEntry[],
  memories: Memory[],
  attachments: ChatAttachment[],
) {
  switch (runtime.provider) {
    case "gemini":
      return openGeminiResponseStream(runtime, message, history, memories, attachments);
    case "openai":
      return openOpenAiCompatibleResponseStream(
        runtime,
        process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1",
        message,
        history,
        memories,
        attachments,
      );
    case "groq":
      return openOpenAiCompatibleResponseStream(
        runtime,
        "https://api.groq.com/openai/v1",
        message,
        history,
        memories,
        attachments,
      );
    case "anthropic":
      return openAnthropicResponseStream(runtime, message, history, memories, attachments);
  }
}

async function generateGeminiText(
  runtime: ProviderRuntime,
  prompt: string,
  responseMimeType?: string,
) {
  const ai = new GoogleGenAI({ apiKey: runtime.apiKey });
  const response = await ai.models.generateContent({
    model: runtime.analysisModel,
    contents: prompt,
    config: {
      systemInstruction: JSON_TASK_SYSTEM_PROMPT,
      responseMimeType,
    },
  });

  return response.text || "";
}

async function generateOpenAiCompatibleText(
  runtime: ProviderRuntime,
  baseUrl: string,
  prompt: string,
) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${runtime.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: runtime.analysisModel,
      temperature: 0.2,
      messages: [
        { role: "system", content: JSON_TASK_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(await readErrorResponse(response));
  }

  const payload = await response.json();
  return extractOpenAiText(payload?.choices?.[0]?.message?.content);
}

async function generateAnthropicText(runtime: ProviderRuntime, prompt: string) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": runtime.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: runtime.analysisModel,
      max_tokens: 1024,
      system: JSON_TASK_SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    throw new Error(await readErrorResponse(response));
  }

  const payload = await response.json();
  return extractAnthropicText(payload?.content);
}

async function generateText(
  runtime: ProviderRuntime,
  prompt: string,
  responseMimeType?: string,
) {
  switch (runtime.provider) {
    case "gemini":
      return generateGeminiText(runtime, prompt, responseMimeType);
    case "openai":
      return generateOpenAiCompatibleText(
        runtime,
        process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1",
        prompt,
      );
    case "groq":
      return generateOpenAiCompatibleText(runtime, "https://api.groq.com/openai/v1", prompt);
    case "anthropic":
      return generateAnthropicText(runtime, prompt);
  }
}

async function generateTextWithFallback(
  runtimes: ProviderRuntime[],
  prompt: string,
  responseMimeType?: string,
) {
  const errors: string[] = [];

  for (const runtime of runtimes) {
    try {
      return {
        runtime,
        text: await generateText(runtime, prompt, responseMimeType),
      };
    } catch (error) {
      errors.push(`${runtime.provider}: ${error instanceof Error ? error.message : "Unknown provider error."}`);
    }
  }

  throw new Error(errors.join(" | "));
}

async function openChatStreamWithFallback(
  runtimes: ProviderRuntime[],
  message: string,
  history: ChatHistoryEntry[],
  memories: Memory[],
  attachments: ChatAttachment[],
) {
  const errors: string[] = [];

  for (const runtime of runtimes) {
    try {
      return {
        runtime,
        stream: await openChatResponseStream(runtime, message, history, memories, attachments),
      };
    } catch (error) {
      errors.push(`${runtime.provider}: ${error instanceof Error ? error.message : "Unknown provider error."}`);
    }
  }

  throw new Error(errors.join(" | "));
}

function normalizeMemories(value: unknown): Memory[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item) => item && typeof item === "object")
    .map((item: any) => ({
      id: String(item.id || ""),
      key: String(item.key || ""),
      value: String(item.value || ""),
      timestamp: item.timestamp ? new Date(item.timestamp) : new Date(),
    }))
    .filter((item) => item.key && item.value);
}

function normalizeHistory(value: unknown): ChatHistoryEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item) => item && typeof item === "object")
    .map((item: any) => ({
      role: item.role === "user" ? "user" : "model",
      parts: Array.isArray(item.parts)
        ? item.parts
            .filter((part: any) => part && typeof part === "object")
            .map((part: any) => ({ text: typeof part.text === "string" ? part.text : "" }))
            .filter((part) => part.text)
        : [],
    }));
}

function normalizeAttachments(value: unknown): ChatAttachment[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item) => item && typeof item === "object")
    .map((item: any) => ({
      data: typeof item.data === "string" ? item.data : "",
      mimeType: typeof item.mimeType === "string" && item.mimeType ? item.mimeType : "application/octet-stream",
      name: typeof item.name === "string" ? item.name : undefined,
    }))
    .filter((item) => item.data);
}

function sendJsonError(response: Response, error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected server error.";
  response.status(500).json({ error: message });
}

export function getAiRuntimeSummary() {
  const configuredProviders = getConfiguredProviders();

  try {
    const runtimes = resolveRuntimeProviders();
    const runtime = runtimes[0];
    return {
      configuredProviders,
      activeProvider: runtime.provider,
      fallbackOrder: runtimes.map((item) => item.provider),
      activeModels: {
        chat: runtime.chatModel,
        analysis: runtime.analysisModel,
      },
      supportedModels: SUPPORTED_MODELS,
    };
  } catch (error) {
    return {
      configuredProviders,
      activeProvider: null,
      fallbackOrder: [],
      activeModels: null,
      supportedModels: SUPPORTED_MODELS,
      error: error instanceof Error ? error.message : "Unable to resolve AI runtime.",
    };
  }
}

export function registerAiRoutes(app: Express) {
  app.get("/api/ai/models", (_request, response) => {
    response.json(getAiRuntimeSummary());
  });

  app.post("/api/ai/chat", async (request: Request, response: Response) => {
    try {
      const runtimes = resolveRuntimeProviders(request.body?.provider);
      const message = typeof request.body?.message === "string" ? request.body.message : "";
      const history = normalizeHistory(request.body?.history);
      const memories = normalizeMemories(request.body?.memories);
      const attachments = normalizeAttachments(request.body?.attachments);
      const { runtime, stream } = await openChatStreamWithFallback(
        runtimes,
        message,
        history,
        memories,
        attachments,
      );

      response.status(200);
      response.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      response.setHeader("Cache-Control", "no-cache, no-transform");
      response.setHeader("X-AI-Provider", runtime.provider);
      response.setHeader("X-AI-Model", runtime.chatModel);

      for await (const text of stream) {
        if (text) {
          response.write(`${JSON.stringify({ text })}\n`);
        }
      }

      response.end(`${JSON.stringify({ done: true, provider: runtime.provider, model: runtime.chatModel })}\n`);
    } catch (error) {
      if (!response.headersSent) {
        sendJsonError(response, error);
        return;
      }

      const message = error instanceof Error ? error.message : "Unexpected server error.";
      response.end(`${JSON.stringify({ error: message })}\n`);
    }
  });

  app.post("/api/ai/memories", async (request: Request, response: Response) => {
    try {
      const runtimes = resolveRuntimeProviders(request.body?.provider);
      const text = typeof request.body?.text === "string" ? request.body.text : "";
      const prompt = `Extract important user preferences, goals, or habits from the following text.
Return a JSON array of objects with exactly "key" and "value" string fields.
Only include genuinely useful long-lived memory. If none exists, return [].

Text:
${text}`;
      const { text: result } = await generateTextWithFallback(runtimes, prompt, "application/json");
      response.json(parseJsonResponse<Array<{ key: string; value: string }>>(result, []));
    } catch (error) {
      sendJsonError(response, error);
    }
  });

  app.post("/api/ai/intents", async (request: Request, response: Response) => {
    try {
      const runtimes = resolveRuntimeProviders(request.body?.provider);
      const text = typeof request.body?.text === "string" ? request.body.text : "";
      const prompt = `Identify whether the text contains any of these intents:
- CREATE_REMINDER
- SEARCH_WEB
- IMAGE_GEN
- CALCULATE

Return a JSON array of strings using only those labels. If none apply, return [].

Text:
${text}`;
      const { text: result } = await generateTextWithFallback(runtimes, prompt, "application/json");
      response.json(parseJsonResponse<string[]>(result, []));
    } catch (error) {
      sendJsonError(response, error);
    }
  });

  app.post("/api/ai/reminder", async (request: Request, response: Response) => {
    try {
      const runtimes = resolveRuntimeProviders(request.body?.provider);
      const text = typeof request.body?.text === "string" ? request.body.text : "";
      const prompt = `Analyze the text for a reminder intent.
Use ${new Date().toISOString()} as the reference time for relative dates.
Return either:
- null
- or a JSON object with "task" and "dateTime" fields, where "dateTime" is ISO 8601 or null if the time is missing.

Text:
${text}`;
      const { text: result } = await generateTextWithFallback(runtimes, prompt, "application/json");
      const parsed = parseJsonResponse<{ task?: string | null; dateTime?: string | null } | null>(result, null);
      response.json(parsed && parsed.task ? parsed : null);
    } catch (error) {
      sendJsonError(response, error);
    }
  });

  app.post("/api/ai/quick-replies", async (request: Request, response: Response) => {
    try {
      const runtimes = resolveRuntimeProviders(request.body?.provider);
      const history = normalizeHistory(request.body?.history);
      const prompt = `Based on this conversation history, generate exactly 3 short, distinctive quick reply suggestions for the user.
Match NAT's calm, adaptive, digital-companion persona.
Return a JSON array of strings only.

History:
${JSON.stringify(history.slice(-6))}`;
      const { text: result } = await generateTextWithFallback(runtimes, prompt, "application/json");
      const parsed = parseJsonResponse<string[]>(result, []);
      response.json(parsed.slice(0, 3));
    } catch (error) {
      sendJsonError(response, error);
    }
  });
}

export async function runAssistantChat(input: {
  provider?: string;
  message: string;
  history?: ChatHistoryEntry[];
  memories?: Memory[];
  attachments?: ChatAttachment[];
}) {
  const runtimes = resolveRuntimeProviders(input.provider);
  const history = input.history || [];
  const memories = input.memories || [];
  const attachments = input.attachments || [];
  const { runtime, stream } = await openChatStreamWithFallback(
    runtimes,
    input.message,
    history,
    memories,
    attachments,
  );

  let text = "";
  for await (const chunk of stream) {
    text += chunk;
  }

  return {
    text,
    provider: runtime.provider,
    model: runtime.chatModel,
  };
}

export async function runMemoryExtraction(input: { provider?: string; text: string }) {
  const runtimes = resolveRuntimeProviders(input.provider);
  const prompt = `Extract important user preferences, goals, or habits from the following text.
Return a JSON array of objects with exactly "key" and "value" string fields.
Only include genuinely useful long-lived memory. If none exists, return [].

Text:
${input.text}`;
  const { text } = await generateTextWithFallback(runtimes, prompt, "application/json");
  return parseJsonResponse<Array<{ key: string; value: string }>>(text, []);
}

export async function runIntentDetection(input: { provider?: string; text: string }) {
  const runtimes = resolveRuntimeProviders(input.provider);
  const prompt = `Identify whether the text contains any of these intents:
- CREATE_REMINDER
- SEARCH_WEB
- IMAGE_GEN
- CALCULATE
- PLAY_MODE
- LISTENING_MODE
- HELPER_MODE
- MEMORY_MODE

Return a JSON array of strings using only those labels. If none apply, return [].

Text:
${input.text}`;
  const { text } = await generateTextWithFallback(runtimes, prompt, "application/json");
  return parseJsonResponse<string[]>(text, []);
}

export async function runReminderExtraction(input: { provider?: string; text: string }) {
  const runtimes = resolveRuntimeProviders(input.provider);
  const prompt = `Analyze the text for a reminder intent.
Use ${new Date().toISOString()} as the reference time for relative dates.
Return either:
- null
- or a JSON object with "task" and "dateTime" fields, where "dateTime" is ISO 8601 or null if the time is missing.

Text:
${input.text}`;
  const { text } = await generateTextWithFallback(runtimes, prompt, "application/json");
  const parsed = parseJsonResponse<{ task?: string | null; dateTime?: string | null } | null>(text, null);
  return parsed && parsed.task ? parsed : null;
}

export async function runQuickReplies(input: { provider?: string; history: ChatHistoryEntry[] }) {
  const runtimes = resolveRuntimeProviders(input.provider);
  const prompt = `Based on this conversation history, generate exactly 3 short, distinctive quick reply suggestions for the user.
Match NAT's calm, adaptive, digital-companion persona.
Return a JSON array of strings only.

History:
${JSON.stringify(input.history.slice(-6))}`;
  const { text } = await generateTextWithFallback(runtimes, prompt, "application/json");
  return parseJsonResponse<string[]>(text, []).slice(0, 3);
}
