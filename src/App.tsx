import React, { useState, useEffect, useRef } from "react";
import * as Lucide from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { io, Socket } from "socket.io-client";
import { sendChatMessage, sendVoiceMessage } from "./lib/appApi";
import { loadProfile, loadSettings, saveChats, saveMemories, saveProfile, saveReminders } from "./lib/clientStore";
import { useSettingsState } from "./hooks/useSettingsState";
import { useVoiceState } from "./hooks/useVoiceState";
import { Chat, Message, Memory, Reminder, Attachment } from "./types";

const NAT_AVATAR = "https://lh3.googleusercontent.com/aida-public/AB6AXuBfxJF83ej6uHSK9s_gl7ZywQxQvG3FNUfiMKs6EJt6MWA8fRIq3Bq47ExnyNQKTtLYk8g_UNrWrgWNFp8nc-e9zUdRuhZeYszB__ba9Lm9VG2T9CtqmJkj55AnyJjbOFSfcv1IepdXLLPaQT4bT4mL7W7Nz0QVZAvaJL_PbgQBKQkYw6WVGL_5YFOpcIgge_mGK4YWuT8I4k4s_dqdfKamjC3vrUxtm2YZfbzk20jmlG3IdWg7zffdPrTw883gf3kHiHUY3L8a69M";

// Functional Local DB Mock replacing Firebase (Persists to localStorage)
type User = any;
const auth = { currentUser: null as User | null };
const storage = {};
const MOCK_DB_KEY = "nat_app_db_v3";
const MOCK_AUTH_KEY = "nat_app_auth_v1";
const authListeners = new Set<(user: User | null) => void>();
const readMockDb = () => {
  try {
    const parsed = JSON.parse(localStorage.getItem(MOCK_DB_KEY) || "{}");
    if (parsed && typeof parsed === "object" && parsed.collections && typeof parsed.collections === "object") {
      return parsed as { collections: Record<string, any[]> };
    }
  } catch {}
  return { collections: {} as Record<string, any[]> };
};
const persistedUser = (() => {
  try {
    return JSON.parse(localStorage.getItem(MOCK_AUTH_KEY) || "null");
  } catch {
    return null;
  }
})();
auth.currentUser = persistedUser;
const db = {
  listeners: [] as any[],
  data: readMockDb(),
  save() {
    const settings = loadSettings();
    if (!settings.dataPersistence) {
      localStorage.removeItem(MOCK_DB_KEY);
      return;
    }
    localStorage.setItem(MOCK_DB_KEY, JSON.stringify(this.data));
  },
  ensureCollection(path: string) {
    if (!this.data.collections[path]) this.data.collections[path] = [];
    return this.data.collections[path];
  },
  notify(path: string) {
    this.listeners
      .filter(l => l.path === path)
      .forEach(l => l.cb(createSnapshot(path, l.constraints)));
  }
};
const notifyAuthListeners = () => {
  authListeners.forEach((listener) => listener(auth.currentUser));
};
const signInWithGoogle = async () => {
  const persistedProfile = loadProfile(NAT_AVATAR);
  const user = {
    uid: persistedProfile.uid,
    displayName: persistedProfile.name,
    email: persistedProfile.email,
    photoURL: persistedProfile.avatar,
  };
  auth.currentUser = user;
  localStorage.setItem(MOCK_AUTH_KEY, JSON.stringify(user));
  notifyAuthListeners();
  return user;
};
const onAuthStateChanged = (authInstance: any, cb: any) => {
  authListeners.add(cb);
  cb(authInstance.currentUser ?? null);
  return () => { authListeners.delete(cb); };
};
const collection = (db: any, path: string) => path;
const query = (col: any, ...constraints: any[]) => ({ path: col, constraints });
const orderBy = (field: string, direction: "asc" | "desc" = "asc") => ({ type: "orderBy", field, direction });
const limit = (count: number) => ({ type: "limit", count });
const doc = (db: any, path: string, id?: string) => {
  if (id) {
    return { collectionPath: path, id };
  }
  const segments = path.split("/");
  return {
    collectionPath: segments.slice(0, -1).join("/"),
    id: segments[segments.length - 1]
  };
};
const serverTimestamp = () => new Date().toISOString();
const applyConstraints = (items: any[], constraints: any[] = []) => {
  let result = [...items];
  for (const constraint of constraints) {
    if (!constraint || typeof constraint !== "object") continue;
    if (constraint.type === "orderBy") {
      result.sort((a, b) => {
        const aValue = a?.[constraint.field];
        const bValue = b?.[constraint.field];
        if (aValue === bValue) return 0;
        const comparison = aValue > bValue ? 1 : -1;
        return constraint.direction === "desc" ? -comparison : comparison;
      });
    }
    if (constraint.type === "limit") {
      result = result.slice(0, constraint.count);
    }
  }
  return result;
};
const createSnapshot = (path: string, constraints: any[] = []) => {
  const docs = applyConstraints(db.ensureCollection(path), constraints).map((d: any) => ({
    id: d.id,
    data: () => d,
    ref: { collectionPath: path, id: d.id }
  }));
  return { docs };
};
const onSnapshot = (source: any, cb: any) => {
  const path = typeof source === "string" ? source : source.path;
  const constraints = typeof source === "string" ? [] : source.constraints || [];
  db.ensureCollection(path);
  const listener = { path, constraints, cb };
  db.listeners.push(listener);
  cb(createSnapshot(path, constraints));
  return () => { db.listeners = db.listeners.filter(l => l !== listener); };
};
const addDoc = async (col: any, data: any) => {
  const path = typeof col === "string" ? col : col.path;
  const collectionItems = db.ensureCollection(path);
  const id = "doc_" + Date.now().toString() + Math.random().toString(36).substr(2, 5);
  collectionItems.push({ id, ...data });
  db.save();
  db.notify(path);
  return { id };
};
const updateDoc = async (docRef: any, data: any) => {
  const collectionItems = db.ensureCollection(docRef.collectionPath);
  const idx = collectionItems.findIndex((d: any) => d.id === docRef.id);
  if (idx !== -1) {
    Object.assign(collectionItems[idx], data);
    db.save();
    db.notify(docRef.collectionPath);
  }
};
const deleteDoc = async (docRef: any) => {
  const collectionItems = db.ensureCollection(docRef.collectionPath);
  const nextItems = collectionItems.filter((d: any) => d.id !== docRef.id);
  if (nextItems.length !== collectionItems.length) {
    db.data.collections[docRef.collectionPath] = nextItems;
    db.save();
    db.notify(docRef.collectionPath);
  }
};
const getDocs = async (source: any) => {
  const path = typeof source === "string" ? source : source.path;
  const constraints = typeof source === "string" ? [] : source.constraints || [];
  return createSnapshot(path, constraints);
};
const ref = (st: any, path: string) => ({ path, _mockUrl: '' });
const uploadBytes = async (r: any, file: any) => {
  r._mockUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
};
const getDownloadURL = async (r: any) => r._mockUrl || "https://placeholder.com/file";

export default function App() {
  const { settings, updateSetting } = useSettingsState();
  const [user, setUser] = useState<User | null>(null);
  const [chats, setChats] = useState<Chat[]>([]);
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [inputText, setInputText] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [memoryNotification, setMemoryNotification] = useState<string | null>(null);
  const [isTyping, setIsTyping] = useState(false);
  const [view, setView] = useState<"chronicle" | "transmission" | "nexus" | "vault">("chronicle");
  const [transmissionPrompt, setTransmissionPrompt] = useState("");
  const [isSyncing, setIsSyncing] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isOutputOn, setIsOutputOn] = useState(true);
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const [showSettingsPanel, setShowSettingsPanel] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [transcriptHistory, setTranscriptHistory] = useState<string[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission>(
    typeof Notification !== "undefined" ? Notification.permission : "default",
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputBarRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const socketRef = useRef<Socket | null>(null);
  const reminderTimersRef = useRef<number[]>([]);
  const voiceTranscriptHandlerRef = useRef<(transcript: string) => Promise<void> | void>(() => undefined);
  const profileRef = useRef(loadProfile(NAT_AVATAR));
  const {
    isListening,
    transcript,
    interimTranscript,
    voiceError,
    waveform,
    recordings,
    startListening,
    stopListening,
    setTranscript,
    speak,
  } = useVoiceState({
    voiceEnabled: settings.voiceEnabled && !isMuted,
    outputEnabled: isOutputOn && settings.voiceEnabled,
    onTranscriptFinal: (finalTranscript) => voiceTranscriptHandlerRef.current(finalTranscript),
  });

  const toggleListening = async () => {
    if (isListening) {
      stopListening();
      return;
    }

    if (view !== "nexus") {
      setView("nexus");
    }
    await startListening();
  };

  useEffect(() => {
    const unsubscribeAuth = onAuthStateChanged(auth, (u) => {
      setUser(u);
      if (u) {
        const q = query(collection(db, `users/${u.uid}/chats`), orderBy("updatedAt", "desc"));
        onSnapshot(q, async (snapshot) => {
          const chatList = snapshot.docs.map((doc: any) => ({ id: doc.id, ...doc.data() } as Chat));
          setChats(chatList);
          if (chatList.length > 0 && !currentChatId) {
            setCurrentChatId(chatList[0].id);
          } else if (chatList.length === 0 && !currentChatId) {
            const newChat = await addDoc(collection(db, `users/${u.uid}/chats`), {
              userId: u.uid,
              title: "Neural Session",
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp()
            });
            setCurrentChatId(newChat.id);
          }
        });

        const memQ = query(collection(db, `users/${u.uid}/memories`), orderBy("timestamp", "desc"), limit(20));
        onSnapshot(memQ, (snapshot) => {
          setMemories(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Memory)));
        });

        const remQ = query(collection(db, `users/${u.uid}/reminders`), orderBy("dateTime", "asc"));
        onSnapshot(remQ, (snapshot) => {
          setReminders(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Reminder)));
        });
      }
    });

    socketRef.current = io();
    return () => {
      unsubscribeAuth();
      socketRef.current?.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!socketRef.current || !inputText.trim() || !currentChatId) {
      return;
    }

    const timer = window.setTimeout(() => {
      socketRef.current?.emit("typing", { chatId: currentChatId, active: true });
    }, 250);

    return () => window.clearTimeout(timer);
  }, [currentChatId, inputText]);

  useEffect(() => {
    if (user && currentChatId) {
      const q = query(collection(db, `users/${user.uid}/chats/${currentChatId}/messages`), orderBy("timestamp", "asc"));
      return onSnapshot(q, (snapshot) => {
        setMessages(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Message)));
        setTimeout(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }), 100);
      });
    }
  }, [user, currentChatId]);
  useEffect(() => {
    if (voiceError) {
      setErrorMessage(voiceError);
    }
  }, [voiceError]);

  useEffect(() => {
    if (!user) {
      return;
    }

    profileRef.current = {
      uid: user.uid,
      name: user.displayName || "Local User",
      email: user.email || "local.user@nat.chat",
      avatar: user.photoURL || NAT_AVATAR,
    };
    saveProfile(profileRef.current);
  }, [user]);

  useEffect(() => {
    saveChats(
      chats.map((chat) => ({
        ...chat,
        messages: chat.id === currentChatId ? messages : [],
      })),
      settings.dataPersistence,
    );
  }, [chats, currentChatId, messages, settings.dataPersistence]);

  useEffect(() => {
    saveMemories(memories, settings.dataPersistence);
  }, [memories, settings.dataPersistence]);

  useEffect(() => {
    saveReminders(reminders, settings.dataPersistence);
  }, [reminders, settings.dataPersistence]);

  useEffect(() => {
    if (!settings.notificationsEnabled || typeof Notification === "undefined") {
      return;
    }
    setNotificationPermission(Notification.permission);
  }, [settings.notificationsEnabled]);

  useEffect(() => {
    if (settings.dataPersistence) {
      return;
    }
    localStorage.removeItem(MOCK_DB_KEY);
    localStorage.removeItem("nat_chat_sessions_v1");
    localStorage.removeItem("nat_chat_memories_v1");
    localStorage.removeItem("nat_chat_reminders_v1");
  }, [settings.dataPersistence]);

  useEffect(() => {
    if (!settings.voiceEnabled) {
      stopListening();
      window.speechSynthesis?.cancel();
    }
  }, [settings.voiceEnabled, stopListening]);

  const requestNotifications = async () => {
    if (typeof Notification === "undefined") {
      setErrorMessage("Browser notifications are not supported here.");
      return;
    }
    const permission = await Notification.requestPermission();
    setNotificationPermission(permission);
  };

  const scheduleReminderNotification = (reminder: Reminder | null) => {
    if (!reminder?.dateTime || !settings.notificationsEnabled) {
      return;
    }

    const delay = new Date(reminder.dateTime).getTime() - Date.now();
    if (delay <= 0 || delay > 2147483647) {
      return;
    }

    const timer = window.setTimeout(() => {
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        new Notification("NAT Reminder", {
          body: reminder.task,
        });
      }
    }, delay);
    reminderTimersRef.current.push(timer);
  };

  const ensureChatSession = async () => {
    if (user && currentChatId) {
      return currentChatId;
    }
    const created = await addDoc(collection(db, `users/${user!.uid}/chats`), {
      userId: user!.uid,
      title: "Neural Session",
      lastMessage: "",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    setCurrentChatId(created.id);
    return created.id;
  };

  const persistAssistantArtifacts = async (chatId: string, nextMemories: Memory[], reminder: Reminder | null) => {
    const memoryEntries: Memory[] = [];
    for (const memory of nextMemories) {
      const entry = { ...memory, id: memory.id || `mem_${Date.now()}` };
      memoryEntries.push(entry);
      await addDoc(collection(db, `users/${user!.uid}/memories`), {
        ...entry,
        timestamp: entry.timestamp || serverTimestamp(),
      });
    }

    if (memoryEntries.length > 0) {
      setMemoryNotification(memoryEntries[0].key);
      setTimeout(() => setMemoryNotification(null), 3000);
    }

    if (reminder) {
      await addDoc(collection(db, `users/${user!.uid}/reminders`), reminder);
      scheduleReminderNotification(reminder);
    }
  };

  const processTurn = async (text: string, files: File[], source: "chat" | "voice" = "chat") => {
    if (!user || isSending || (!text.trim() && files.length === 0)) {
      return;
    }

    setErrorMessage(null);
    setIsSending(true);
    setIsTyping(true);
    setSuggestions([]);

    const chatId = await ensureChatSession();
    let uploadedAttachments: Attachment[] = [];

    if (files.length > 0) {
      setUploading(true);
      try {
        uploadedAttachments = await Promise.all(
          files.map(async (file) => {
            const fileRef = ref(storage, `users/${user.uid}/uploads/${Date.now()}_${file.name}`);
            await uploadBytes(fileRef, file);
            const url = await getDownloadURL(fileRef);
            return { url, name: file.name, mimeType: file.type };
          }),
        );
      } finally {
        setUploading(false);
      }
    }

    await addDoc(collection(db, `users/${user.uid}/chats/${chatId}/messages`), {
      role: "user",
      content: text,
      timestamp: serverTimestamp(),
      chatId,
      attachments: uploadedAttachments,
    });

    await updateDoc(doc(db, `users/${user.uid}/chats/${chatId}`), {
      lastMessage: text || (uploadedAttachments.length > 0 ? `Sent ${uploadedAttachments.length} file(s)` : ""),
      updatedAt: serverTimestamp(),
    });

    try {
      const history = messages.map((message) => ({
        role: message.role === "user" ? ("user" as const) : ("model" as const),
        parts: [{ text: message.content }],
      }));
      const payload =
        source === "voice"
          ? await sendVoiceMessage({ sessionId: chatId, title: "Neural Session", transcript: text, history, memories })
          : await sendChatMessage({ sessionId: chatId, title: "Neural Session", message: text, attachments: files, history, memories });

      await addDoc(collection(db, `users/${user.uid}/chats/${chatId}/messages`), {
        ...payload.assistantMessage,
        timestamp: payload.assistantMessage.timestamp || serverTimestamp(),
      });

      await updateDoc(doc(db, `users/${user.uid}/chats/${chatId}`), {
        title: payload.chat.title,
        lastMessage: payload.assistantMessage.content,
        updatedAt: payload.chat.updatedAt,
      });

      setSuggestions(payload.quickReplies);
      await persistAssistantArtifacts(chatId, payload.memories, payload.reminder);
      if (view === "nexus" || source === "voice") {
        speak(payload.assistantMessage.content);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to complete the request.");
    } finally {
      setIsTyping(false);
      setIsSending(false);
      setPendingFiles([]);
      if (source === "chat") {
        setInputText("");
      }
    }
  };

  const handleSendMessage = async (overrideText?: string) => {
    const textToSend = overrideText || inputText;
    const files = [...pendingFiles];
    await processTurn(textToSend, files, "chat");
  };

  voiceTranscriptHandlerRef.current = async (finalTranscript: string) => {
    setTranscriptHistory((current) => [finalTranscript, ...current].slice(0, 6));
    await processTurn(finalTranscript, [], "voice");
    setTranscript("");
  };

  const handleTransmissionAction = (actionText: string) => {
    setView("chronicle");
    handleSendMessage(actionText);
  };

  const handleSystemSync = () => {
    setIsSyncing(true);
    setMemoryNotification("SYSTEM_SYNC_ACTIVE");
    setTimeout(() => {
      setIsSyncing(false);
      setMemoryNotification("SYNC_COMPLETE");
      setTimeout(() => setMemoryNotification(null), 3000);
    }, 1500);
  };

  const createNewChat = async () => {
    if (!user) return;
    stopListening();
    window.speechSynthesis?.cancel();
    setPendingFiles([]);
    setInputText("");
    setSuggestions([]);
    setMessages([]);
    setTranscript("");
    setTranscriptHistory([]);
    setView("chronicle");
    setIsTyping(false);
    setErrorMessage(null);
    const newChatRef = await addDoc(collection(db, `users/${user.uid}/chats`), {
      userId: user.uid,
      title: "New Transmission",
      lastMessage: "",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    setCurrentChatId(newChatRef.id);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setPendingFiles(prev => [...prev, ...Array.from(e.target.files!)]);
    }
  };

  const removeFile = (index: number) => {
    setPendingFiles(prev => prev.filter((_, i) => i !== index));
  };

  const wipeMemory = async () => {
    if (!user) return;
    const q = query(collection(db, `users/${user.uid}/memories`));
    const snapshot = await getDocs(q);
    snapshot.docs.forEach(async (d) => {
        await deleteDoc(d.ref);
    });
    alert("MEMORY_WIPED");
  };

  const deleteChat = async (chatId: string) => {
    if (!user) return;
    // Delete all messages inside the chat first
    const msgSnap = await getDocs(collection(db, `users/${user.uid}/chats/${chatId}/messages`));
    for (const msgDoc of msgSnap.docs) {
      await deleteDoc(msgDoc.ref);
    }
    // Delete the chat document itself
    await deleteDoc(doc(db, `users/${user.uid}/chats`, chatId));
    // If we deleted the active chat, reset or pick next
    if (currentChatId === chatId) {
      setMessages([]);
      setCurrentChatId(null);
    }
  };

  const deleteAllHistory = async () => {
    if (!user) return;
    const chatSnap = await getDocs(collection(db, `users/${user.uid}/chats`));
    for (const chatDoc of chatSnap.docs) {
      const msgSnap = await getDocs(collection(db, `users/${user.uid}/chats/${chatDoc.id}/messages`));
      for (const msgDoc of msgSnap.docs) await deleteDoc(msgDoc.ref);
      await deleteDoc(chatDoc.ref);
    }
    setMessages([]);
    setCurrentChatId(null);
  };

  if (!user) {
    return (
      <div className="h-screen flex items-center justify-center bg-background halftone-overlay">
        <div className="text-center p-12 bg-surface-container border-4 border-black ink-stroke kinetic-tilt relative">
          <div className="absolute -top-6 -left-6 bg-tertiary text-black font-black px-4 py-1 rotate-[-5deg] border-2 border-black shadow-[4px_4px_0_black]">AUTH_REQUIRED</div>
          <Lucide.Cpu className="w-20 h-20 text-primary mx-auto mb-8 animate-pulse" />
          <h1 className="text-4xl font-black italic text-primary mb-8 tracking-tighter drop-shadow-[2px_2px_0_#ff6b98]">NAT_CHAT ACCESS</h1>
          <button 
            onClick={async () => {
              const result = await signInWithGoogle();
              // Make sure to set user locally since auth listener is disabled
              setUser(result);
            }}
            className="w-full py-4 bg-primary text-background font-black border-4 border-black shadow-[4px_4px_0_black] hover:scale-105 active:scale-95 transition-all text-sm tracking-widest uppercase"
          >
            Authenticate Link
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex bg-background font-body text-on-surface selection:bg-tertiary selection:text-on-tertiary overflow-hidden">
      {/* Top Navigation */}
      <header className="fixed top-0 left-0 right-0 z-50 flex justify-between items-center px-6 py-4 w-full bg-ink/80 backdrop-blur-xl border-b-2 border-primary shadow-[4px_4px_0px_0px_#000000]">
        <div className="flex items-center gap-4">
          <h1 className="text-2xl font-black italic text-primary drop-shadow-[2px_2px_0px_#ff6b98] uppercase tracking-tighter -rotate-1 kinetic-tilt transition-all duration-200">
            NAT_CHAT
          </h1>
        </div>
        <nav className="hidden lg:flex gap-8 items-center">
          {["chronicle", "transmission", "nexus"].map((v) => (
            <button
              key={v}
              onClick={() => setView(v as any)}
              className={`font-black uppercase tracking-tighter transition-all hover:scale-110 hover:text-tertiary ${
                view === v ? "text-primary border-b-2 border-primary pb-1 -rotate-1" : "text-primary/60"
              }`}
            >
              {v}
            </button>
          ))}
        </nav>
        <div className="flex items-center gap-4">
          <button 
            onClick={createNewChat}
            className="flex items-center gap-2 bg-tertiary text-background px-4 md:px-6 py-2.5 font-black text-sm uppercase shadow-[6px_6px_0px_black] border-4 border-black hover:scale-105 active:scale-95 transition-all kinetic-tilt"
          >
            <Lucide.PlusCircle className="w-5 h-5 shrink-0" />
            <span className="hidden sm:inline">New Chat</span>
          </button>
          <div className="relative">
            <button onClick={() => { setShowProfileMenu((current) => !current); setShowSettingsPanel(false); }}>
              <Lucide.User className="text-primary hover:scale-110 transition-transform cursor-pointer" />
            </button>
            <AnimatePresence>
              {showProfileMenu && (
                <motion.div
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  className="absolute right-0 mt-3 w-72 bg-surface-container border-4 border-black p-4 shadow-[6px_6px_0px_black] z-[70]"
                >
                  <div className="flex items-center gap-4">
                    <img src={profileRef.current.avatar} alt={profileRef.current.name} className="w-14 h-14 rounded-full border-2 border-black object-cover" />
                    <div className="min-w-0">
                      <p className="font-black text-primary uppercase truncate">{profileRef.current.name}</p>
                      <p className="text-xs text-on-surface-variant truncate">{profileRef.current.email}</p>
                    </div>
                  </div>
                  <div className="mt-4 border-t-2 border-black pt-3 text-xs font-black uppercase tracking-widest text-secondary">
                    Session ID: {currentChatId?.slice(0, 8) || "unlinked"}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          <button onClick={() => { setShowSettingsPanel((current) => !current); setShowProfileMenu(false); }}>
            <Lucide.Settings className="text-primary hover:scale-110 transition-transform cursor-pointer" />
          </button>
        </div>
      </header>

      {/* Memory Notification */}
      <AnimatePresence>
        {memoryNotification && (
          <motion.div 
            initial={{ opacity: 0, y: -20, x: "-50%" }}
            animate={{ opacity: 1, y: 80 }}
            exit={{ opacity: 0, y: -20 }}
            className="fixed top-0 left-1/2 z-[60] bg-secondary text-ink px-6 py-3 border-4 border-black font-black uppercase text-xs tracking-[0.2em] shadow-[8px_8px_0px_black] kinetic-tilt"
          >
            NAT Synchronized: {memoryNotification}
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {errorMessage && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 140 }}
            exit={{ opacity: 0, y: -10 }}
            className="fixed top-0 left-1/2 -translate-x-1/2 z-[60] bg-error text-background px-5 py-3 border-4 border-black font-black uppercase text-xs tracking-[0.2em] shadow-[8px_8px_0px_black]"
          >
            {errorMessage}
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showSettingsPanel && (
          <motion.aside
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 24 }}
            className="fixed top-24 right-6 z-[65] w-[min(24rem,calc(100vw-3rem))] bg-surface-container border-4 border-black p-6 shadow-[8px_8px_0px_black]"
          >
            <div className="flex items-center justify-between mb-6">
              <h3 className="font-black uppercase tracking-widest text-primary">Settings</h3>
              <button onClick={() => setShowSettingsPanel(false)}>
                <Lucide.X className="w-5 h-5 text-on-surface" />
              </button>
            </div>
            <div className="space-y-4">
              <SettingRow
                label="Dark Theme"
                checked={settings.theme === "dark"}
                onChange={(checked) => updateSetting("theme", checked ? "dark" : "light")}
              />
              <SettingRow
                label="Voice Output"
                checked={settings.voiceEnabled}
                onChange={(checked) => updateSetting("voiceEnabled", checked)}
              />
              <SettingRow
                label="Notifications"
                checked={settings.notificationsEnabled}
                onChange={async (checked) => {
                  updateSetting("notificationsEnabled", checked);
                  if (checked) {
                    await requestNotifications();
                  }
                }}
                meta={notificationPermission}
              />
              <SettingRow
                label="Data Persistence"
                checked={settings.dataPersistence}
                onChange={(checked) => updateSetting("dataPersistence", checked)}
              />
            </div>
          </motion.aside>
        )}
      </AnimatePresence>

      {/* Sidebar (Chronicle View) */}
      <aside className={`fixed left-0 top-0 h-screen flex flex-col pt-24 bg-ink border-r-4 border-black w-72 z-40 halftone-overlay transition-transform duration-500 shadow-[8px_0px_0px_0px_rgba(0,0,0,0.5)] ${view === "chronicle" ? "translate-x-0" : "-translate-x-full"}`}>
        <div className="p-6">
          <div className="flex items-center gap-3 mb-10">
            <div className="w-12 h-12 bg-gradient-to-br from-primary to-secondary rounded-full flex items-center justify-center border-2 border-black shadow-[3px_3px_0px_black]">
              <Lucide.Brain className="text-ink" />
            </div>
            <div className={view === "chronicle" ? "" : "md:hidden"}>
              <h2 className="text-primary font-black italic text-sm tracking-widest">NAT_CORE</h2>
              <p className="text-[10px] text-primary/50 font-black">V.2.0-HYPER-NEON</p>
            </div>
          </div>
          
          <nav className="space-y-4">
            <SidebarItem icon={<Lucide.Zap />} label="Neural Feed" active={view === "chronicle"} onClick={() => setView("chronicle")} collapsed={view !== "chronicle"} />
            <SidebarItem icon={<Lucide.Database />} label="Memory Vault" active={view === "vault"} onClick={() => setView("vault")} collapsed={view !== "chronicle"} />
            <SidebarItem icon={<Lucide.BookOpen />} label="Ink Archive" active={view === "transmission"} onClick={() => setView("transmission")} collapsed={view !== "chronicle"} />
            <SidebarItem icon={<Lucide.RefreshCcw className={isSyncing ? "animate-spin" : ""} />} label="System Sync" collapsed={view !== "chronicle"} onClick={handleSystemSync} />
          </nav>
        </div>

        <div className={`flex-1 overflow-hidden flex flex-col px-6 pb-2 ${view === "chronicle" ? "flex" : "hidden"}`}>
          <div className="flex-1 min-h-0 flex flex-col mb-6">
            <div className="flex items-center justify-between mb-2 shrink-0">
              <h3 className="text-[10px] font-black text-primary/70 uppercase tracking-[0.2em] flex items-center gap-2">
                <Lucide.MessageSquare className="w-3 h-3" /> Previous Conversations
              </h3>
              {chats.length > 0 && (
                <button
                  onClick={deleteAllHistory}
                  title="Clear all history"
                  className="text-[9px] font-black text-error/60 hover:text-error uppercase tracking-widest transition-colors flex items-center gap-1"
                >
                  <Lucide.Trash2 className="w-3 h-3" /> All
                </button>
              )}
            </div>
            <div className="overflow-y-auto scrollbar-none space-y-1 pr-2 flex-1 min-h-0">
              {chats.length === 0 && (
                <p className="text-[10px] text-on-surface-variant/50 uppercase italic py-1">No history</p>
              )}
              {chats.map(chat => (
                <div key={chat.id} className="group flex items-center">
                  <button
                    onClick={() => { setCurrentChatId(chat.id); setView("chronicle"); }}
                    className={`flex-1 text-left truncate text-xs p-2 font-bold transition-all border-l-2 ${currentChatId === chat.id ? "bg-primary/20 text-primary border-primary" : "text-on-surface hover:bg-surface-container-high border-transparent"}`}
                  >
                    {chat.title || "Neural Session"}
                  </button>
                  <button
                    onClick={() => deleteChat(chat.id)}
                    title="Delete chat"
                    className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity p-1 text-error/60 hover:text-error"
                  >
                    <Lucide.Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="shrink-0 max-h-48 flex flex-col min-h-0">
            <h3 className="text-[10px] font-black text-tertiary/70 uppercase tracking-[0.2em] mb-2 flex items-center gap-2 shrink-0">
              <Lucide.Bell className="w-3 h-3" /> Scheduled Reminders
            </h3>
            <div className="overflow-y-auto scrollbar-none space-y-1 pr-2 min-h-0">
              {reminders.length === 0 && (
                <p className="text-[10px] text-on-surface-variant/50 uppercase italic py-1">No reminders</p>
              )}
              {reminders.map((r) => (
                <div key={r.id} className="w-full text-left truncate text-[10px] p-2 font-bold text-on-surface border-l-2 border-tertiary/30 bg-surface-container-low mb-1 group flex items-start justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="uppercase truncate text-white">{r.task}</div>
                    <div className="text-[8px] text-tertiary/70 mt-1">
                      {r.dateTime ? new Date(r.dateTime).toLocaleString() : "Date-Pending"}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-auto p-6 space-y-4">
          <button 
            onClick={wipeMemory}
            className="w-full border-2 border-error text-error p-3 font-black text-xs tracking-widest hover:bg-error/10 transition-colors uppercase"
          >
            Wipe Memory
          </button>
          <button onClick={() => alert("Support Channel Opening...")} className="flex items-center gap-4 text-primary p-3 w-full hover:bg-primary/10 font-bold text-xs cursor-pointer">
            <Lucide.HelpCircle className="w-5 shrink-0" />
            <span className={view === "chronicle" ? "uppercase tracking-widest text-left" : "hidden"}>Support</span>
          </button>
        </div>
      </aside>

      {/* Transmission View Overlay Sidebar (Mini state) */}
      {view !== "chronicle" && (
        <aside className="fixed left-0 top-0 h-screen flex flex-col pt-24 bg-ink border-r-4 border-black w-20 z-40 halftone-overlay ">
            <div className="flex flex-col items-center gap-8 px-2">
                <div className={`p-3 transition-transform hover:skew-x-1 cursor-pointer ${view === "chronicle" ? "bg-secondary text-ink rotate-1 shadow-[4px_4px_0px_#000000]" : "text-primary hover:bg-primary/10"}`} onClick={() => setView("chronicle")}>
                    <Lucide.MessageSquare className="w-6 h-6" />
                </div>
                <div className={`p-3 transition-transform hover:skew-x-1 cursor-pointer ${view === "vault" ? "bg-secondary text-ink rotate-1 shadow-[4px_4px_0px_#000000]" : "text-primary hover:bg-primary/10"}`} onClick={() => setView("vault")}>
                    <Lucide.Database className="w-6 h-6" />
                </div>
                <div className={`p-3 transition-transform hover:skew-x-1 cursor-pointer ${view === "transmission" ? "bg-secondary text-ink rotate-1 shadow-[4px_4px_0px_#000000]" : "text-primary hover:bg-primary/10"}`} onClick={() => setView("transmission")}>
                    <Lucide.BookOpen className="w-6 h-6" />
                </div>
                <div className={`p-3 transition-transform hover:skew-x-1 cursor-pointer ${view === "nexus" ? "bg-secondary text-ink rotate-1 shadow-[4px_4px_0px_#000000]" : "text-primary hover:bg-primary/10"}`} onClick={() => setView("nexus")}>
                    <Lucide.Mic className="w-6 h-6" />
                </div>
                <div className="mt-auto mb-10 p-3 text-primary hover:bg-primary/10 transition-transform cursor-pointer">
                    <Lucide.HelpCircle className="w-6 h-6" />
                </div>
            </div>
        </aside>
      )}

      {/* Main Container */}
      <main className={`flex-1 transition-all duration-500 ${view === "chronicle" ? "ml-72" : "ml-20"} h-screen relative flex flex-col overflow-hidden pt-20 max-w-full`}>
        <AnimatePresence mode="wait">
          {view === "chronicle" && (
            <motion.div 
              key="chronicle"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="w-full h-full min-h-0 flex flex-col bg-background halftone-overlay"
            >
              <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto p-6 md:p-12 space-y-12 scrollbar-none pb-64">
                <div className="flex justify-center">
                  <span className="bg-surface-container-high border-2 border-black text-secondary px-4 py-1 font-black text-xs tracking-[0.2em] uppercase kinetic-tilt shadow-[4px_4px_0px_black]">
                    Epoch: Transmission_{currentChatId?.slice(0, 3) || "001"}
                  </span>
                </div>
                {messages.length === 0 && (
                  <MessageBubble
                    message={{
                      id: "default-greeting",
                      role: "assistant",
                      content: "NAT online. I can help with tasks, reminders, brainstorming, memory capture, and voice conversations.",
                      timestamp: serverTimestamp(),
                      chatId: currentChatId || "default",
                    }}
                  />
                )}
                {messages.map((m) => (
                  // @ts-ignore
                  <MessageBubble key={m.id} message={m} />
                ))}
                {isTyping && (
                  <div className="flex items-center gap-4">
                    <div className="w-12 h-12 rounded-full bg-surface-container-highest border-2 border-black flex items-center justify-center">
                      <Lucide.Zap className="text-primary animate-pulse" />
                    </div>
                    <div className="bg-surface-container border-2 border-black px-6 py-3 rounded-full flex gap-2 items-center shadow-[4px_4px_0px_black]">
                      <div className="w-2 h-2 bg-primary rounded-full animate-pulse" />
                      <div className="w-2 h-2 bg-primary rounded-full animate-pulse delay-75" />
                      <div className="w-2 h-2 bg-primary rounded-full animate-pulse delay-150" />
                      <span className="text-xs font-black uppercase text-secondary ml-2">Nat is sketching...</span>
                    </div>
                  </div>
                )}
              </div>
              <div ref={inputBarRef} className="sticky bottom-0 left-0 z-20 w-full p-6 md:p-10 bg-gradient-to-t from-background/60 via-background/30 to-transparent">
                <div className="max-w-4xl mx-auto w-full relative">
                  {/* Suggestions Area */}
                  <AnimatePresence>
                    {suggestions.length > 0 && (
                      <motion.div 
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 10 }}
                        className="flex flex-wrap gap-3 mb-4 px-4 overflow-hidden"
                      >
                        {suggestions.map((s, i) => (
                          <button
                            key={i}
                            onClick={() => handleSendMessage(s)}
                            disabled={isSending}
                            className={`bg-surface-container-high border-2 border-black px-4 py-2 font-black text-[10px] tracking-widest uppercase ink-stroke hover:bg-primary hover:text-ink transition-all cursor-pointer ${i % 2 === 0 ? "kinetic-tilt" : "kinetic-tilt-alt"}`}
                          >
                            {s}
                          </button>
                        ))}
                      </motion.div>
                    )}
                  </AnimatePresence>

                  <div className="border-4 border-black p-2 rounded-full flex items-center gap-2 group focus-within:ring-4 ring-primary/20" style={{background:'rgba(0,0,0,0.25)',backdropFilter:'blur(12px)',WebkitBackdropFilter:'blur(12px)',border:'1px solid rgba(255,255,255,0.08)',boxShadow:'0 8px 30px rgba(0,0,0,0.25)'}}>
                    <input 
                      type="file" 
                      ref={fileInputRef} 
                      onChange={handleFileChange} 
                      className="hidden" 
                      multiple 
                      accept="image/*,.pdf"
                    />
                    <button 
                      onClick={() => fileInputRef.current?.click()} 
                      className="ml-4 text-on-surface-variant hover:text-primary transition-colors p-1"
                    >
                      <Lucide.Paperclip className="w-5 h-5" />
                    </button>
                    
                    <div className="flex-1 flex flex-col gap-2 min-w-0">
                      {pendingFiles.length > 0 && (
                        <div className="flex gap-2 overflow-x-auto p-2 scrollbar-none">
                          {pendingFiles.map((file, i) => (
                            <div key={i} className="relative shrink-0 bg-ink border-2 border-black p-1 kinetic-tilt">
                              <div className="text-[8px] font-black text-primary truncate max-w-[60px] uppercase">{file.name}</div>
                              {file.type.startsWith("image/") ? (
                                <img src={URL.createObjectURL(file)} className="w-10 h-10 object-cover mt-1" />
                              ) : (
                                <Lucide.FileText className="w-10 h-10 text-tertiary mt-1" />
                              )}
                              <button 
                                onClick={() => removeFile(i)}
                                className="absolute -top-1 -right-1 bg-error text-background rounded-full w-4 h-4 flex items-center justify-center border border-black"
                              >
                                <Lucide.X className="w-2 h-2" />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                      
                      <input 
                        value={inputText}
                        onChange={(e) => setInputText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            handleSendMessage();
                          }
                        }}
                        className="bg-transparent border-none focus:ring-0 text-on-surface font-black uppercase tracking-widest placeholder:text-outline-variant/50 py-2 px-4 text-sm" 
                        placeholder={uploading ? "UPLOADING PROTOCOLS..." : isSending ? "NAT IS RESPONDING..." : "WRITE YOUR STORY..."} 
                        disabled={uploading || isSending}
                      />
                    </div>

                    <button 
                      onClick={() => handleSendMessage()} 
                      disabled={uploading || isSending}
                      className="bg-tertiary text-background w-14 h-14 rounded-full flex items-center justify-center border-4 border-black shadow-[4px_4px_0px_black] active:translate-x-1 active:translate-y-1 active:shadow-none transition-all hover:scale-110 disabled:grayscale disabled:opacity-50"
                    >
                      {uploading || isSending ? <Lucide.Loader2 className="w-7 h-7 animate-spin" /> : <Lucide.Send className="w-7 h-7" />}
                    </button>
                  </div>
                </div>
              </div>
            </motion.div>
          )}

          {view === "transmission" && (
            <motion.div 
              key="transmission"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className={`${view === "chronicle" ? "hidden" : "flex"} w-full h-full p-8 flex-col relative overflow-y-auto scrollbar-none bg-gradient-to-br from-background via-[#1a0b2e] to-background`}
            >
              <div className="absolute top-20 right-40 w-4 h-4 rounded-full bg-primary glow-particle" />
              <div className="absolute bottom-40 left-20 w-3 h-3 rounded-full bg-tertiary glow-particle" />
              <div className="absolute top-1/2 left-1/2 w-6 h-6 rounded-full bg-secondary glow-particle" />

              <div className="max-w-4xl mx-auto flex-1 flex flex-col items-center gap-12 relative z-10 pt-12">
                <div className="relative group">
                  <div className="absolute inset-0 bg-gradient-to-tr from-primary via-secondary to-tertiary rounded-full blur-2xl opacity-40 group-hover:opacity-70 transition-opacity" />
                  <div className="relative w-48 h-48 rounded-full border-4 border-black bg-surface-bright flex items-center justify-center overflow-hidden ink-stroke">
                    <div className="absolute inset-0 bg-gradient-to-br from-primary via-secondary to-tertiary animate-pulse opacity-50" />
                    <div className="relative z-10 flex gap-4">
                      <div className="w-8 h-3 bg-background rounded-full rotate-[-15deg]" />
                      <div className="w-8 h-3 bg-background rounded-full rotate-[15deg]" />
                    </div>
                    <div className="absolute bottom-6 font-black text-[10px] tracking-widest text-background uppercase">Hyper-Mode Active</div>
                  </div>
                </div>

                <div className="text-center">
                  <h2 className="text-5xl font-black italic text-on-surface uppercase tracking-tighter kinetic-tilt-alt drop-shadow-[4px_4px_0px_#000000]">
                    Creative Burst <span className="text-primary">Engaged</span>
                  </h2>
                  <p className="mt-4 text-secondary font-bold uppercase tracking-widest text-sm">Select an action to disrupt reality</p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-8 w-full mt-8">
                  <ActionCard onClick={() => handleTransmissionAction("Brainstorm a chaotic torrent of divergent thoughts and radical concepts.")} icon={<Lucide.Zap />} title="Brainstorm" color="bg-primary-container" accent="text-primary" desc="Unleash a chaotic torrent of divergent thoughts and radical concepts." />
                  <ActionCard onClick={() => handleTransmissionAction("Project mental constructs into vivid digital manifestations.")} icon={<Lucide.Layers />} title="Visualize" color="bg-secondary-container" accent="text-secondary" desc="Project mental constructs into vivid digital manifestations." />
                  <ActionCard onClick={() => handleTransmissionAction("Distill complexity into sharp, impactful graphic novel fidelity.")} icon={<Lucide.Brush />} title="Refine" color="bg-tertiary-container" accent="text-tertiary" desc="Distill complexity into sharp, impactful graphic novel fidelity." />
                </div>

                <div className="w-full max-w-2xl mt-12 mb-20">
                  <div className="relative group">
                    <div className="absolute -inset-1 bg-gradient-to-r from-primary to-secondary rounded-xl blur opacity-25" />
                    <div className="relative flex items-center bg-surface-container-lowest border-4 border-black ink-stroke p-2">
                      <input 
                        value={transmissionPrompt}
                        onChange={(e) => setTransmissionPrompt(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && transmissionPrompt.trim()) {
                            handleTransmissionAction(transmissionPrompt);
                            setTransmissionPrompt("");
                          }
                        }}
                        className="bg-transparent border-none focus:ring-0 w-full font-bold text-on-surface px-4 py-3 placeholder:text-outline/50 uppercase tracking-wide" 
                        placeholder="Prompt NAT for a creative explosion..." 
                      />
                      <button 
                        onClick={() => {
                          if (transmissionPrompt.trim()) {
                            handleTransmissionAction(transmissionPrompt);
                            setTransmissionPrompt("");
                          }
                        }}
                        className="bg-primary text-background font-black p-3 hover:scale-110 shadow-[2px_2px_0px_#000000]"
                      >
                        <Lucide.Rocket className="w-6 h-6" />
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              <aside className="fixed right-0 top-0 h-screen w-72 bg-surface-container border-l-4 border-black pt-24 pb-8 px-6 z-30 halftone-overlay hidden xl:block">
                <div className="flex items-center gap-2 mb-8">
                  <Lucide.PenTool className="text-tertiary w-5" />
                  <h4 className="font-black text-sm uppercase tracking-widest text-primary">Ink Archive</h4>
                </div>
                <div className="space-y-6">
                  <ArchiveNode title="Neo-Tokyo Sketch" subtitle="V.2.4-REFINE" img="https://picsum.photos/seed/neo/400/300" color="bg-secondary" />
                  <ArchiveNode title="Particle Flow" subtitle="IDEATION-BRAIN" img="https://picsum.photos/seed/particle/400/300" color="bg-primary" tilt="kinetic-tilt-alt" />
                  <div className="relative group opacity-50 pl-4 border-l-2 border-tertiary">
                    <p className="text-xs font-black uppercase text-tertiary">Mecha-Structure</p>
                    <p className="text-[10px] text-on-surface-variant uppercase tracking-tighter">PENDING-VISUAL</p>
                    <div className="mt-2 text-on-surface-variant/30 flex items-center justify-center border-2 border-dashed border-outline/30 h-20 uppercase font-black text-[10px]">Extracting Concept...</div>
                  </div>
                </div>
                <div className="mt-12">
                  <button 
                    onClick={() => handleTransmissionAction("Generate a comprehensive creative burst encompassing Brainstorming, Visualization, and Refinement.")}
                    className="w-full py-4 bg-tertiary border-2 border-black font-black uppercase tracking-widest text-sm shadow-[4px_4px_0px_#000000] active:translate-x-1 active:translate-y-1 transition-all"
                  >
                    Generate All
                  </button>
                </div>
              </aside>
            </motion.div>
          )}

          {view === "nexus" && (
            <motion.div 
              key="nexus"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="w-full h-full overflow-y-auto scrollbar-none relative bg-background speed-lines"
            >
              <div className="absolute inset-0 bg-radial-gradient from-surface-container-high/20 to-background pointer-events-none" />
              <div className="relative z-10 flex flex-col items-center gap-12 w-full max-w-4xl mx-auto px-6 py-12 min-h-full justify-center">
                <div className="relative shrink-0">
                  <div className="absolute inset-0 bg-primary/20 blur-[80px] rounded-full scale-150 animate-pulse" />
                  <div className="w-64 h-64 md:w-80 md:h-80 bg-gradient-to-br from-primary to-primary-dim rounded-full flex items-center justify-center border-4 border-black ink-stroke kinetic-tilt relative overflow-hidden group">
                    <div className="absolute inset-0 opacity-10 halftone-overlay pointer-events-none" />
                    <div className="flex gap-5 relative z-20 items-end">
                      {waveform.map((level, index) => (
                        <motion.div
                          key={index}
                          animate={{ height: `${Math.max(18, Math.round(level * 120))}px` }}
                          transition={{ duration: 0.18, ease: "easeOut" }}
                          className="w-6 bg-background rounded-full border-4 border-black origin-center"
                        />
                      ))}
                    </div>
                  </div>
                  <div className="absolute -top-4 -right-8 bg-tertiary text-on-tertiary px-4 py-2 font-black italic rounded-none border-2 border-black rotate-6 ink-stroke">
                    {isListening ? "LISTENING..." : "CONNECTED"}
                  </div>
                </div>

                <div className="w-full h-32 relative flex items-center justify-center">
                  <div className="w-full h-full bg-secondary zig-zag-wave opacity-80 border-y-4 border-black shadow-[0_0_20px_rgba(196,127,255,0.5)]" />
                  <div className="absolute w-full h-1/2 bg-primary zig-zag-wave opacity-50 -mt-2 animate-pulse" />
                  <div className="absolute font-black tracking-widest text-primary-container mix-blend-difference text-xl md:text-2xl uppercase">Vibrancy Level: Critical</div>
                </div>

                <div className="flex flex-wrap justify-center gap-8 md:gap-16 mt-8">
                  <NexusButton 
                    icon={isMuted ? <Lucide.MicOff /> : <Lucide.Mic />} 
                    label={isMuted ? "Unmute" : "Mute"} 
                    color={isMuted ? "bg-primary" : "bg-secondary"} 
                    shadow="shadow-[0px_8px_0px_#500086]" 
                    onClick={() => {
                        const nextMuted = !isMuted;
                        setIsMuted(nextMuted);
                        if (nextMuted && isListening) stopListening();
                        if (!nextMuted && view === "nexus" && !isListening) toggleListening();
                    }} 
                  />
                  <NexusButton 
                    icon={<Lucide.PhoneOff />} 
                    label="End Link" 
                    color="bg-error" 
                    shadow="shadow-[0px_8px_0px_#9f0519]" 
                    onClick={() => { stopListening(); setTranscript(""); setView("chronicle"); }}
                    large 
                  />
                  <NexusButton 
                    icon={isOutputOn ? <Lucide.Volume2 /> : <Lucide.VolumeX />} 
                    label={isOutputOn ? "Quiet" : "Output"} 
                    color={isOutputOn ? "bg-primary" : "bg-secondary"} 
                    shadow="shadow-[0px_8px_0px_#006264]" 
                    onClick={() => setIsOutputOn(!isOutputOn)} 
                  />
                </div>

                <div className="max-w-xl w-full px-6 mt-16">
                  <div className="bg-surface-container-high border-2 border-primary p-6 ink-stroke relative -rotate-1">
                    <div className="absolute -top-3 left-8 bg-primary text-background font-black text-xs px-2 py-1 uppercase tracking-tighter">Real-time Transcripts</div>
                    <p className="text-on-surface text-lg font-medium leading-tight">
                      {(transcript || interimTranscript) ? `${transcript} ${interimTranscript}`.trim() : isListening ? "NAT listening to your neural constructs..." : "Neural link established. Awaiting input."}
                    </p>
                    <div className="absolute -bottom-4 left-10 w-0 h-0 border-l-[15px] border-l-transparent border-t-[15px] border-t-primary border-r-[15px] border-r-transparent" />
                  </div>
                  {transcriptHistory.length > 0 && (
                    <div className="mt-6 bg-surface-container-low border-2 border-black p-4 space-y-2">
                      {transcriptHistory.slice(0, 3).map((entry, index) => (
                        <p key={`${entry}-${index}`} className="text-xs uppercase tracking-wide text-on-surface-variant">{entry}</p>
                      ))}
                    </div>
                  )}
                  {recordings.length > 0 && (
                    <div className="mt-6 space-y-2">
                      {recordings.slice(0, 2).map((recording) => (
                        <audio key={recording.id} controls className="w-full">
                          <source src={recording.url} />
                        </audio>
                      ))}
                    </div>
                  )}
                  {!isListening && (
                    <button
                      onClick={toggleListening}
                      className="mt-6 w-full bg-tertiary text-background border-4 border-black py-3 font-black uppercase tracking-widest shadow-[4px_4px_0px_black]"
                    >
                      Start Link
                    </button>
                  )}
                </div>
              </div>
            </motion.div>
          )}

          {view === "vault" && (
            <motion.div 
              key="vault"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="w-full h-full flex flex-col p-8 md:p-12 hover-scroll halftone-overlay bg-background overflow-y-auto scrollbar-none"
            >
              <div className="max-w-5xl mx-auto w-full space-y-12">
                <header className="flex flex-col md:flex-row md:items-end justify-between gap-6 border-b-4 border-black pb-8">
                  <div>
                    <h2 className="text-5xl font-black italic text-primary uppercase tracking-tighter kinetic-tilt -rotate-1 drop-shadow-[4px_4px_0_#000000]">
                      Neural Vault
                    </h2>
                    <p className="text-secondary font-bold uppercase tracking-[0.3em] text-sm mt-4">Syncing persistent user constructs</p>
                  </div>
                  <div className="flex gap-4">
                    <div className="bg-surface-container border-2 border-black p-4 ink-stroke kinetic-tilt-alt">
                      <p className="text-[10px] font-black uppercase text-outline">Stored Nodes</p>
                      <p className="text-2xl font-black text-primary">{memories.length + reminders.length}</p>
                    </div>
                  </div>
                </header>

                <section className="space-y-6">
                  <h3 className="text-2xl font-black italic text-white uppercase flex items-center gap-3">
                    <Lucide.Bell className="text-tertiary" /> Scheduled Reminders
                  </h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {reminders.length === 0 && (
                      <div className="col-span-full border-4 border-dashed border-surface-container p-12 text-center">
                        <p className="text-on-surface-variant font-black uppercase tracking-widest opacity-20">No active links detected</p>
                      </div>
                    )}
                    {reminders.map((r, i) => (
                      <div key={r.id} className={`bg-surface-container-high border-4 border-black p-6 ink-stroke relative group ${i % 2 === 0 ? 'kinetic-tilt' : 'kinetic-tilt-alt'}`}>
                        <div className="absolute -top-3 -right-3 bg-tertiary text-background font-black text-[10px] px-2 py-1 rotate-12 border-2 border-black shadow-[2px_2px_0_black]">REMINDER</div>
                        <div className="flex items-start justify-between mb-4">
                          <Lucide.Calendar className="text-primary w-6 h-6" />
                          <button onClick={() => deleteDoc(doc(db, `users/${user.uid}/reminders`, r.id))} className="text-error opacity-0 group-hover:opacity-100 transition-opacity">
                            <Lucide.Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                        <h4 className="text-xl font-black text-white uppercase mb-2 leading-tight">{r.task}</h4>
                        <p className="text-secondary font-bold text-xs tracking-widest">
                          {r.dateTime ? new Date(r.dateTime).toLocaleString() : "Date-Pending"}
                        </p>
                      </div>
                    ))}
                  </div>
                </section>

                <section className="space-y-6">
                  <h3 className="text-2xl font-black italic text-white uppercase flex items-center gap-3">
                    <Lucide.Brain className="text-secondary" /> Neural Fragments
                  </h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {memories.map((m) => (
                      <div key={m.id} className="bg-surface-container-low border-2 border-outline-variant p-4 flex gap-4 items-center group">
                        <div className="w-10 h-10 bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
                          <Lucide.Brain className="text-primary w-5" />
                        </div>
                        <div className="flex-1">
                          <p className="text-[10px] font-black uppercase text-secondary tracking-widest mb-1">{m.key}</p>
                          <p className="font-bold text-sm text-on-surface">{m.value}</p>
                        </div>
                        <button onClick={() => deleteDoc(doc(db, `users/${user.uid}/memories`, m.id))} className="text-error opacity-0 group-hover:opacity-100 transition-opacity">
                            <Lucide.XCircle className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}

function SidebarItem({ icon, label, active = false, onClick, collapsed = false }: any) {
  return (
    <button 
      onClick={onClick}
      className={`w-full flex items-center gap-4 ${active ? "bg-secondary text-ink rotate-1 shadow-[4px_4px_0px_#000000]" : "text-primary hover:bg-primary/10"} p-3 transition-transform font-bold text-sm tracking-widest hover:skew-x-1 hover:translate-x-1`}
    >
      <span className="shrink-0">{icon}</span>
      <span className={collapsed ? "hidden" : "block"}>{label}</span>
    </button>
  );
}

function SettingRow({
  label,
  checked,
  onChange,
  meta,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void | Promise<void>;
  meta?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-2 border-black bg-surface-container-high p-3">
      <div>
        <p className="font-black uppercase tracking-widest text-sm text-primary">{label}</p>
        {meta ? <p className="text-[10px] uppercase tracking-[0.2em] text-on-surface-variant mt-1">{meta}</p> : null}
      </div>
      <button
        onClick={() => onChange(!checked)}
        className={`w-14 h-8 border-2 border-black flex items-center px-1 transition-colors ${checked ? "bg-primary" : "bg-surface-container-low"}`}
      >
        <div className={`w-5 h-5 bg-black transition-transform ${checked ? "translate-x-6" : "translate-x-0"}`} />
      </button>
    </div>
  );
}

function ActionCard({ icon, title, desc, color, accent, tilt = "kinetic-tilt", onClick }: any) {
  return (
    <div onClick={onClick} className={`bg-surface-container-high border-4 border-black p-6 ink-stroke ${tilt} cursor-pointer hover:scale-105 transition-all group`}>
      <div className={`w-16 h-16 ${color} border-2 border-black rounded-lg mb-4 flex items-center justify-center shadow-[4px_4px_0px_#000000]`}>
        {React.cloneElement(icon as React.ReactElement, { className: "w-8 h-8 text-background" })}
      </div>
      <h3 className={`font-black text-2xl ${accent} uppercase mb-2`}>{title}</h3>
      <p className="text-on-surface-variant font-medium leading-tight text-sm">{desc}</p>
      <div className="mt-6 flex justify-end">
        <Lucide.ArrowRight className="text-tertiary group-hover:translate-x-2 transition-transform" />
      </div>
    </div>
  );
}

function ArchiveNode({ title, subtitle, img, color, tilt = "kinetic-tilt" }: any) {
  return (
    <div className="relative group cursor-pointer pl-4">
      <div className={`absolute -left-2 top-0 bottom-0 w-1 ${color} rounded-full group-hover:w-2 transition-all`} />
      <div className={`w-full h-32 rounded-lg bg-surface-container-highest border-2 border-black overflow-hidden mb-2 ink-stroke ${tilt} group-hover:rotate-0 transition-transform`}>
        <img src={img} className="w-full h-full object-cover" />
      </div>
      <p className={`text-xs font-black uppercase ${color.replace('bg-', 'text-')}`}>{title}</p>
      <p className="text-[10px] text-on-surface-variant uppercase tracking-tighter">{subtitle}</p>
    </div>
  );
}

function NexusButton({ icon, label, color, shadow, onClick, large = false }: any) {
  return (
    <button onClick={onClick} className="group flex flex-col items-center gap-2">
      <div className={`${large ? 'w-24 h-24' : 'w-20 h-20'} ${color} rounded-full border-4 border-black ${shadow} active:translate-y-1 active:shadow-none transition-all flex items-center justify-center hover:scale-105`}>
        {React.cloneElement(icon as React.ReactElement, { className: `${large ? 'w-10 h-10' : 'w-8 h-8'} text-background font-bold` })}
      </div>
      <span className={`font-black uppercase tracking-widest text-xs ${color.replace('bg-', 'text-')}`}>{label}</span>
    </button>
  );
}

function MessageBubble({ message }: { message: Message }) {
  const isAi = message.role === "assistant";
  
  const renderAttachments = () => {
    if (!message.attachments || message.attachments.length === 0) return null;
    return (
      <div className="flex flex-wrap gap-2 mt-2">
        {message.attachments.map((att, idx) => (
          <div key={idx} className="relative group">
            <a 
              href={att.url} 
              target="_blank" 
              rel="noopener noreferrer"
              className="block bg-ink border-2 border-primary/30 p-1 hover:border-primary transition-colors kinetic-tilt"
            >
              {att.mimeType.startsWith("image/") ? (
                <img src={att.url} alt={att.name} className="max-w-[200px] max-h-[200px] object-contain" />
              ) : (
                <div className="flex items-center gap-2 p-3 bg-ink">
                  <Lucide.FileText className="text-secondary w-8 h-8" />
                  <div className="text-[10px] font-black text-primary uppercase max-w-[120px] truncate">{att.name}</div>
                </div>
              )}
            </a>
          </div>
        ))}
      </div>
    );
  };

  if (!isAi) {
    return (
      <div className="flex flex-col items-end gap-4">
        <div className="relative bg-on-background text-background border-4 border-black p-6 rounded-3xl rounded-br-none -rotate-1 kinetic-tilt-alt shadow-[6px_6px_0px_rgba(196,127,255,0.5)] max-w-lg">
          <p className="text-lg font-extrabold tracking-tight">{message.content}</p>
          {renderAttachments()}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 max-w-2xl">
      <div className="flex items-end gap-4">
        <div className="relative group">
          <div className="w-16 h-16 rounded-full bg-gradient-to-tr from-primary to-secondary border-4 border-black shadow-[4px_4px_0px_black] relative flex items-center justify-center shrink-0">
            <img src={NAT_AVATAR} className="w-full h-full object-cover rounded-full" />
            <div className="absolute -top-1 -right-1 w-5 h-5 bg-tertiary rounded-full border-2 border-black animate-pulse" />
          </div>
        </div>
        <div className="relative bg-surface-container-high border-4 border-primary p-6 rounded-3xl rounded-bl-none kinetic-tilt shadow-[6px_6px_0px_black] group">
          <div className="absolute inset-0 halftone opacity-10 rounded-2xl pointer-events-none" />
          <p className="relative text-lg font-bold leading-relaxed text-primary">
            {message.content}
          </p>
          {renderAttachments()}
        </div>
      </div>
    </div>
  );
}
