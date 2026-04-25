import { Memory } from "../types";

type ChatHistoryEntry = {
  role: "user" | "model";
  parts: Array<{ text?: string }>;
};

type ChatAttachment = {
  data: string;
  mimeType: string;
  name?: string;
};

type StreamChunk = {
  text: string;
};

async function readError(response: Response): Promise<string> {
  const raw = await response.text();
  if (!raw) {
    return `${response.status} ${response.statusText}`;
  }

  try {
    const payload = JSON.parse(raw);
    return payload?.error || payload?.message || raw;
  } catch {
    return raw;
  }
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(await readError(response));
  }

  return response.json() as Promise<T>;
}

async function* parseNdjsonStream(response: Response): AsyncGenerator<StreamChunk> {
  if (!response.body) {
    throw new Error("The server did not return a stream.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      const payload = JSON.parse(trimmed);
      if (payload.error) {
        throw new Error(payload.error);
      }

      if (typeof payload.text === "string" && payload.text) {
        yield { text: payload.text };
      }
    }
  }

  if (buffer.trim()) {
    const payload = JSON.parse(buffer.trim());
    if (payload.error) {
      throw new Error(payload.error);
    }
    if (typeof payload.text === "string" && payload.text) {
      yield { text: payload.text };
    }
  }
}

export async function generateChatResponse(
  message: string,
  history: ChatHistoryEntry[],
  memories: Memory[],
  attachments: ChatAttachment[] = [],
) {
  const response = await fetch("/api/ai/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message,
      history,
      memories,
      attachments,
    }),
  });

  if (!response.ok) {
    throw new Error(await readError(response));
  }

  return parseNdjsonStream(response);
}

export async function extractMemories(text: string): Promise<Array<{ key: string; value: string }>> {
  return postJson("/api/ai/memories", { text });
}

export async function detectIntent(text: string): Promise<string[]> {
  return postJson("/api/ai/intents", { text });
}

export async function extractReminder(text: string): Promise<{ task: string; dateTime: string | null } | null> {
  return postJson("/api/ai/reminder", { text });
}

export async function generateQuickReplies(history: ChatHistoryEntry[]): Promise<string[]> {
  return postJson("/api/ai/quick-replies", { history });
}
