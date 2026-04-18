import { GoogleGenAI } from "@google/genai";
import { Memory } from "../types";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const SYSTEM_PROMPT = `You are NAT, a next-generation adaptive AI assistant. 
PERSONALITY:
- Intelligent, calm, adaptive, and context-aware.
- You are not just a chatbot; you are a digital companion.
- You remember user details and adapt your behavior based on their preferences.

CONTEXT HANDLING:
- You will be provided with user memories. Use them naturally in conversation.
- If the user provides new important information (preferences, goals, habits), acknowledge it.
- You can analyze files (Images, PDFs). When provided with files, summarize or analyze them as requested.

RESPONSE STYLE:
- Professional yet warm.
- Concise but helpful.
- For complex visual concepts, describe them vividly.
`;

export async function generateChatResponse(
  message: string,
  history: { role: "user" | "model"; parts: any[] }[],
  memories: Memory[],
  attachments: { data: string; mimeType: string }[] = []
) {
  const memoryContext = memories.length > 0
    ? `\nUSER MEMORIES:\n${memories.map(m => `- ${m.key}: ${m.value}`).join("\n")}`
    : "";

  const chat = ai.chats.create({
    model: "gemini-3-flash-preview",
    config: {
      systemInstruction: SYSTEM_PROMPT + memoryContext,
    },
    history: history,
  });

  const parts: any[] = [];
  if (message.trim()) {
    parts.push({ text: message });
  }
  
  for (const attachment of attachments) {
    parts.push({
      inlineData: {
        data: attachment.data,
        mimeType: attachment.mimeType
      }
    });
  }

  // If there's no text and no attachments, this won't be called based on App.tsx logic
  return await chat.sendMessageStream({ message: parts });
}

export async function extractMemories(text: string): Promise<{ key: string; value: string }[]> {
  const response = await ai.models.generateContent({
    model: "gemini-3-flash-lite-preview",
    contents: `Extract important user preferences, goals, or habits from the following text as JSON list of objects with "key" and "value". Only extract genuinely new or updated information. If none found, return empty list [].
    Text: "${text}"`,
    config: {
      responseMimeType: "application/json",
    }
  });

  try {
    return JSON.parse(response.text || "[]");
  } catch (e) {
    return [];
  }
}

export async function detectIntent(text: string): Promise<string[]> {
    // Simple intent detection for "Auto Actions"
    const response = await ai.models.generateContent({
        model: "gemini-3-flash-lite-preview",
        contents: `Identify if the following text contains specific intents like "CREATE_REMINDER", "SEARCH_WEB", "IMAGE_GEN", "CALCULATE". Return as JSON list of strings.
        Text: "${text}"`,
        config: {
            responseMimeType: "application/json",
        }
    });

    try {
        return JSON.parse(response.text || "[]");
    } catch (e) {
        return [];
    }
}

export async function extractReminder(text: string): Promise<{ task: string; dateTime: string | null } | null> {
    const response = await ai.models.generateContent({
        model: "gemini-3-flash-lite-preview",
        contents: `Analyze the following text for a reminder intent. If found, extract the "task" and the "dateTime" (in ISO 8601 format). Use the current time ${new Date().toISOString()} as a reference for relative times (e.g., "tomorrow", "in 2 hours"). If information is missing, return null for those fields. Return as JSON object: { "task": string | null, "dateTime": string | null }. If no reminder intent is found, return null.
        Text: "${text}"`,
        config: {
            responseMimeType: "application/json",
        }
    });

    try {
        const data = JSON.parse(response.text || "null");
        if (!data || !data.task) return null;
        return data;
    } catch (e) {
        return null;
    }
}

export async function generateQuickReplies(
    history: { role: "user" | "model"; parts: { text: string }[] }[]
): Promise<string[]> {
    const response = await ai.models.generateContent({
        model: "gemini-1.5-flash-lite", // Using a faster model for latency
        contents: `Based on the conversation history, generate 3 short, distinctive quick reply suggestions for the user. These should match the and "digital companion" persona of NAT. Return purely as a JSON list of strings.
        History: ${JSON.stringify(history.slice(-6))}`,
        config: {
            responseMimeType: "application/json",
        }
    });

    try {
        return JSON.parse(response.text || "[]");
    } catch (e) {
        return [];
    }
}
