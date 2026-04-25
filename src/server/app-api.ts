import type { Express, Request, Response } from "express";
import { randomUUID } from "crypto";
import {
  runAssistantChat,
  runIntentDetection,
  runMemoryExtraction,
  runQuickReplies,
  runReminderExtraction,
  type AssistantAttachment,
  type AssistantHistoryEntry,
} from "./ai";

type SessionMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  chatId: string;
  attachments?: Array<{ url: string; name: string; mimeType: string }>;
};

type SessionMemory = {
  id: string;
  key: string;
  value: string;
  timestamp: string;
};

type SessionReminder = {
  id: string;
  userId: string;
  task: string;
  dateTime: string | null;
  status: "pending" | "completed";
  createdAt: string;
};

type SessionRecord = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: SessionMessage[];
  memories: SessionMemory[];
  reminders: SessionReminder[];
  mode: "default" | "play" | "helper" | "listening" | "memory";
};

const sessions = new Map<string, SessionRecord>();

function getIsoNow() {
  return new Date().toISOString();
}

function createSession(title = "Neural Session"): SessionRecord {
  const now = getIsoNow();
  const session: SessionRecord = {
    id: randomUUID(),
    title,
    createdAt: now,
    updatedAt: now,
    messages: [],
    memories: [],
    reminders: [],
    mode: "default",
  };
  sessions.set(session.id, session);
  return session;
}

function getOrCreateSession(sessionId?: string, title?: string) {
  if (sessionId && sessions.has(sessionId)) {
    return sessions.get(sessionId)!;
  }

  const fallback = createSession(title);
  if (sessionId && fallback.id !== sessionId) {
    sessions.set(sessionId, { ...fallback, id: sessionId });
    sessions.delete(fallback.id);
    return sessions.get(sessionId)!;
  }
  return fallback;
}

function inferMode(message: string): SessionRecord["mode"] {
  const normalized = message.toLowerCase();
  if (normalized.includes("quiz") || normalized.includes("riddle") || normalized.includes("play mode")) {
    return "play";
  }
  if (normalized.includes("helper mode") || normalized.includes("plan my") || normalized.includes("productivity")) {
    return "helper";
  }
  if (normalized.includes("listening mode") || normalized.includes("passively listen")) {
    return "listening";
  }
  if (normalized.includes("memory mode") || normalized.includes("remember this")) {
    return "memory";
  }
  return "default";
}

function buildModeInstruction(mode: SessionRecord["mode"]) {
  switch (mode) {
    case "play":
      return "Active mode: play. Keep the reply interactive and game-like, suitable for quiz or riddle play.";
    case "helper":
      return "Active mode: helper. Prioritize structured productivity suggestions and actionable next steps.";
    case "listening":
      return "Active mode: listening. Respond as a calm real-time listener and confirm what you heard before helping.";
    case "memory":
      return "Active mode: memory. Focus on extracting and reinforcing important long-lived user notes.";
    default:
      return "";
  }
}

function toHistory(messages: SessionMessage[]): AssistantHistoryEntry[] {
  return messages.map((message) => ({
    role: message.role === "user" ? "user" : "model",
    parts: [{ text: message.content }],
  }));
}

function normalizeAttachments(value: unknown): AssistantAttachment[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item) => item && typeof item === "object")
    .map((item: any) => ({
      data: typeof item.data === "string" ? item.data : "",
      mimeType: typeof item.mimeType === "string" ? item.mimeType : "application/octet-stream",
      name: typeof item.name === "string" ? item.name : undefined,
    }))
    .filter((item) => item.data);
}

function normalizeHistory(value: unknown): AssistantHistoryEntry[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  return value.map((entry: any) => ({
    role: entry?.role === "user" ? "user" : "model",
    parts: Array.isArray(entry?.parts)
      ? entry.parts.map((part: any) => ({ text: typeof part?.text === "string" ? part.text : "" })).filter((part: any) => part.text)
      : [],
  }));
}

function normalizeMemories(value: unknown): Array<{ id: string; key: string; value: string; timestamp: Date }> | null {
  if (!Array.isArray(value)) {
    return null;
  }

  return value
    .map((memory: any) => ({
      id: String(memory?.id || randomUUID()),
      key: String(memory?.key || ""),
      value: String(memory?.value || ""),
      timestamp: memory?.timestamp ? new Date(memory.timestamp) : new Date(),
    }))
    .filter((memory) => memory.key && memory.value);
}

function attachmentPreviews(attachments: AssistantAttachment[]) {
  return attachments.map((attachment, index) => ({
    url: `data:${attachment.mimeType};base64,${attachment.data}`,
    name: attachment.name || `attachment-${index + 1}`,
    mimeType: attachment.mimeType,
  }));
}

function sendError(response: Response, error: unknown) {
  response.status(500).json({
    error: error instanceof Error ? error.message : "Unexpected server error.",
  });
}

async function processAssistantTurn(body: any) {
  const userMessage =
    typeof body?.message === "string" && body.message.trim()
      ? body.message.trim()
      : "";
  if (!userMessage && !Array.isArray(body?.attachments)) {
    throw new Error("A message or attachment is required.");
  }

  const session = getOrCreateSession(body?.sessionId, body?.title);
  const mode = inferMode(userMessage);
  if (mode !== "default") {
    session.mode = mode;
  }

  const attachments = normalizeAttachments(body?.attachments);
  const userAttachments = attachmentPreviews(attachments);
  const timestamp = getIsoNow();

  const userEntry: SessionMessage = {
    id: randomUUID(),
    role: "user",
    content: userMessage,
    timestamp,
    chatId: session.id,
    attachments: userAttachments,
  };
  session.messages.push(userEntry);
  session.updatedAt = timestamp;

  const chatMessage = `${buildModeInstruction(session.mode)}\n\n${userMessage}`.trim();
  const assistant = await runAssistantChat({
    provider: body?.provider,
    message: chatMessage,
    history: normalizeHistory(body?.history) || toHistory(session.messages.slice(0, -1)),
    memories:
      normalizeMemories(body?.memories) ||
      session.memories.map((memory) => ({
        id: memory.id,
        key: memory.key,
        value: memory.value,
        timestamp: new Date(memory.timestamp),
      })),
    attachments,
  });

  const assistantTimestamp = getIsoNow();
  const assistantEntry: SessionMessage = {
    id: randomUUID(),
    role: "assistant",
    content: assistant.text,
    timestamp: assistantTimestamp,
    chatId: session.id,
  };
  session.messages.push(assistantEntry);
  session.updatedAt = assistantTimestamp;

  const combinedText = `${userMessage}\n${assistant.text}`.trim();
  const [memories, reminder, quickReplies, intents] = await Promise.all([
    runMemoryExtraction({ provider: body?.provider, text: combinedText }),
    runReminderExtraction({ provider: body?.provider, text: combinedText }),
    runQuickReplies({
      provider: body?.provider,
      history: toHistory(session.messages),
    }),
    runIntentDetection({ provider: body?.provider, text: combinedText }),
  ]);

  const memoryEntries = memories.map((memory) => ({
    id: randomUUID(),
    key: memory.key,
    value: memory.value,
    timestamp: getIsoNow(),
  }));
  session.memories.push(...memoryEntries);

  let reminderEntry: SessionReminder | null = null;
  if (reminder?.task) {
    reminderEntry = {
      id: randomUUID(),
      userId: "local_mock",
      task: reminder.task,
      dateTime: reminder.dateTime ?? null,
      status: "pending",
      createdAt: getIsoNow(),
    };
    session.reminders.push(reminderEntry);
  }

  return {
    sessionId: session.id,
    chat: {
      id: session.id,
      title: session.title,
      updatedAt: session.updatedAt,
      createdAt: session.createdAt,
    },
    userMessage: userEntry,
    assistantMessage: assistantEntry,
    quickReplies,
    memories: memoryEntries,
    reminder: reminderEntry,
    intents,
    meta: {
      provider: assistant.provider,
      model: assistant.model,
      mode: session.mode,
    },
  };
}

export function registerAppApiRoutes(app: Express) {
  app.get("/api/history", (request: Request, response: Response) => {
    const sessionId = typeof request.query.sessionId === "string" ? request.query.sessionId : "";

    if (sessionId) {
      const session = sessions.get(sessionId);
      response.json({
        chats: session ? [session] : [],
      });
      return;
    }

    response.json({
      chats: Array.from(sessions.values()).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)),
    });
  });

  app.post("/api/new-chat", (request: Request, response: Response) => {
    const title =
      typeof request.body?.title === "string" && request.body.title.trim()
        ? request.body.title.trim()
        : "Neural Session";
    const session = createSession(title);
    response.json({
      chat: {
        id: session.id,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      },
    });
  });

  app.post("/api/chat", async (request: Request, response: Response) => {
    try {
      response.json(await processAssistantTurn(request.body));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/voice", async (request: Request, response: Response) => {
    try {
      const transcript =
        typeof request.body?.transcript === "string" && request.body.transcript.trim()
          ? request.body.transcript.trim()
          : "";
      if (!transcript) {
        response.status(400).json({ error: "Transcript is required." });
        return;
      }

      response.json(await processAssistantTurn({ ...request.body, message: transcript }));
    } catch (error) {
      sendError(response, error);
    }
  });
}
