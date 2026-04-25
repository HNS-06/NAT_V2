export type Role = "user" | "assistant";

export interface Attachment {
  url: string;
  name: string;
  mimeType: string;
}

export interface Message {
  id: string;
  role: Role;
  content: string;
  timestamp: any; // Firestore timestamp
  chatId: string;
  attachments?: Attachment[];
}

export interface Chat {
  id: string;
  userId: string;
  title: string;
  lastMessage?: string;
  updatedAt: any; // Firestore timestamp
  createdAt: any; // Firestore timestamp
}

export interface Memory {
  id: string;
  key: string;
  value: string;
  timestamp: Date;
}

export interface Reminder {
  id: string;
  userId: string;
  task: string;
  dateTime: any; // Firestore timestamp or ISO string
  status: "pending" | "completed";
  createdAt: any;
}

export interface UserPreferences {
  theme?: string;
  voiceEnabled?: boolean;
  notificationsEnabled?: boolean;
  dataPersistence?: boolean;
  [key: string]: any;
}

export interface UserProfile {
  userId: string;
  email: string;
  name?: string;
  avatar?: string;
  preferences?: UserPreferences;
}
