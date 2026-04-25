import { Attachment, Chat, Memory, Message, Reminder } from "../types";

export type ChatMode = "default" | "play" | "helper" | "listening" | "memory";

type ChatAttachmentPayload = {
  data: string;
  mimeType: string;
  name?: string;
};

type ChatResponsePayload = {
  sessionId: string;
  chat: Chat;
  userMessage: Message;
  assistantMessage: Message;
  quickReplies: string[];
  memories: Memory[];
  reminder: Reminder | null;
  intents: string[];
  meta: {
    provider: string;
    model: string;
    mode: ChatMode;
  };
};

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const raw = await response.text();
    try {
      const payload = JSON.parse(raw);
      throw new Error(payload?.error || payload?.message || raw);
    } catch {
      throw new Error(raw || `${response.status} ${response.statusText}`);
    }
  }

  return response.json() as Promise<T>;
}

export async function fileToPayload(file: File): Promise<ChatAttachmentPayload> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve({
        data: result.split(",")[1],
        mimeType: file.type,
        name: file.name,
      });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export async function createChatSession(title = "Neural Session") {
  const response = await fetch("/api/new-chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });

  return readJson<{ chat: Chat }>(response);
}

export async function fetchChatHistory(sessionId?: string) {
  const url = sessionId ? `/api/history?sessionId=${encodeURIComponent(sessionId)}` : "/api/history";
  const response = await fetch(url);
  return readJson<{ chats: Array<Chat & { messages?: Message[]; memories?: Memory[]; reminders?: Reminder[] }> }>(response);
}

export async function sendChatMessage(input: {
  sessionId?: string | null;
  title?: string;
  message: string;
  attachments?: File[];
  provider?: string;
  history?: Array<{ role: "user" | "model"; parts: Array<{ text?: string }> }>;
  memories?: Memory[];
}) {
  const attachments = await Promise.all((input.attachments || []).map(fileToPayload));
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: input.sessionId,
      title: input.title,
      message: input.message,
      provider: input.provider,
      attachments,
      history: input.history,
      memories: input.memories,
    }),
  });

  return readJson<ChatResponsePayload>(response);
}

export async function sendVoiceMessage(input: {
  sessionId?: string | null;
  title?: string;
  transcript: string;
  provider?: string;
  history?: Array<{ role: "user" | "model"; parts: Array<{ text?: string }> }>;
  memories?: Memory[];
}) {
  const response = await fetch("/api/voice", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

  return readJson<ChatResponsePayload>(response);
}

export function mergeUniqueMemories(current: Memory[], next: Memory[]) {
  const map = new Map<string, Memory>();
  [...current, ...next].forEach((memory) => {
    map.set(`${memory.key}:${memory.value}`, memory);
  });
  return Array.from(map.values()).sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
}

export function mergeReminder(current: Reminder[], reminder: Reminder | null) {
  if (!reminder) {
    return current;
  }

  return [...current, reminder].sort((a, b) => (a.dateTime || "") > (b.dateTime || "") ? 1 : -1);
}

export function buildChatPreview(chatId: string, message: string, attachments: Attachment[]) {
  return message || (attachments.length > 0 ? `Sent ${attachments.length} file(s)` : "Neural Session");
}
