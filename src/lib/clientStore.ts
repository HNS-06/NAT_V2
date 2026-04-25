import { Chat, Memory, Message, Reminder } from "../types";

export type AppSettings = {
  theme: "dark" | "light";
  voiceEnabled: boolean;
  notificationsEnabled: boolean;
  dataPersistence: boolean;
};

export type AppProfile = {
  uid: string;
  name: string;
  email: string;
  avatar: string;
};

const CHAT_KEY = "nat_chat_sessions_v1";
const MEMORY_KEY = "nat_chat_memories_v1";
const REMINDER_KEY = "nat_chat_reminders_v1";
const SETTINGS_KEY = "nat_chat_settings_v1";
const PROFILE_KEY = "nat_chat_profile_v1";

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "dark",
  voiceEnabled: true,
  notificationsEnabled: true,
  dataPersistence: true,
};

export function readStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeStorage<T>(key: string, value: T, persist = true) {
  if (!persist) {
    localStorage.removeItem(key);
    return;
  }
  localStorage.setItem(key, JSON.stringify(value));
}

export function loadSettings() {
  return readStorage<AppSettings>(SETTINGS_KEY, DEFAULT_SETTINGS);
}

export function saveSettings(settings: AppSettings) {
  writeStorage(SETTINGS_KEY, settings, true);
}

export function loadProfile(defaultAvatar: string): AppProfile {
  return readStorage<AppProfile>(PROFILE_KEY, {
    uid: "local_mock",
    name: "Local User",
    email: "local.user@nat.chat",
    avatar: defaultAvatar,
  });
}

export function saveProfile(profile: AppProfile) {
  writeStorage(PROFILE_KEY, profile, true);
}

export function loadChats() {
  return readStorage<Array<Chat & { messages: Message[] }>>(CHAT_KEY, []);
}

export function saveChats(chats: Array<Chat & { messages: Message[] }>, persist: boolean) {
  writeStorage(CHAT_KEY, chats, persist);
}

export function loadMemories() {
  return readStorage<Memory[]>(MEMORY_KEY, []);
}

export function saveMemories(memories: Memory[], persist: boolean) {
  writeStorage(MEMORY_KEY, memories, persist);
}

export function loadReminders() {
  return readStorage<Reminder[]>(REMINDER_KEY, []);
}

export function saveReminders(reminders: Reminder[], persist: boolean) {
  writeStorage(REMINDER_KEY, reminders, persist);
}
