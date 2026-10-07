/**
 * Multi-chat history (on-device). Each analyst conversation is saved as a
 * session holding both the rendered bubbles (display) and the full LLM
 * conversation (convo) so it can be reopened and continued with context intact.
 * A tiny pub/sub keeps the AI Analyst tab and the Profile list in sync; cloud
 * sync of this is part of the backend plan (docs/research/08).
 *
 * Storage model (migrated off plain localStorage to dodge its ~5MB quota):
 *   - IndexedDB holds the full-fidelity history (large tool-result JSON lives here).
 *   - An in-memory cache is the synchronous source of truth during a session, so
 *     the public API stays synchronous and callers are unchanged.
 *   - localStorage keeps a COMPACTED copy only — a fast first paint before IDB
 *     hydrates, and a fallback if IndexedDB is unavailable. Being compacted, it
 *     stays well under quota.
 * On boot the cache hydrates synchronously from the compacted localStorage copy,
 * then asynchronously merges in the full IndexedDB copy (no session is ever lost;
 * newer-by-updatedAt wins, ties favour the fuller IDB copy) and emits so the UI
 * upgrades to full fidelity.
 */
import { compact, mergeChatsById, type ChatSession, type Display } from "./chatsMerge.js";
import type { ChatMessage } from "./agent/llmClient.js";
import { idbAvailable, idbGet, idbSet } from "./idbStore.js";
import { deleteWorkspace, setActiveWorkspace } from "./store.js";

export type { ChatSession, Display };

const KEY = "stratforge.chats";
const ACTIVE_KEY = "stratforge.chats.active";
const IDB_KEY = "chats.v1";

type Listener = () => void;
const listeners = new Set<Listener>();
function emit(): void {
  for (const l of listeners) l();
}
export function subscribeChats(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

let lastStorageWarning: string | null = null;
export function getChatsStorageWarning(): string | null {
  return lastStorageWarning;
}

// --- in-memory cache (synchronous source of truth) ---

function hydrateLocal(): ChatSession[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || "[]") as ChatSession[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

let cache: ChatSession[] = hydrateLocal();

// Asynchronously merge in the durable IndexedDB copy (and migrate the existing
// localStorage history into IDB on first run). Fire-and-forget; emits on change.
void (async () => {
  const idbList = (await idbGet<ChatSession[]>(IDB_KEY)) ?? [];
  if (idbList.length === 0 && cache.length === 0) return;
  const merged = mergeChatsById(idbList, cache);
  cache = merged;
  // Seed/refresh the durable IDB copy (one-time migration from localStorage), then
  // shrink the localStorage copy to its compacted form to reclaim quota.
  void idbSet(IDB_KEY, merged);
  persistLocalFallback(merged);
  emit();
})();

// --- persistence ---

let writeTimer: ReturnType<typeof setTimeout> | null = null;
let pendingWrite: ChatSession[] | null = null;

function scheduleIdbWrite(list: ChatSession[]): void {
  pendingWrite = list;
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    const next = pendingWrite;
    pendingWrite = null;
    if (next) void idbSet(IDB_KEY, next);
  }, 400);
}

/** Flush any debounced IndexedDB write immediately (called on tab hide/unload). */
export function flushChats(): Promise<void> {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  const next = pendingWrite;
  pendingWrite = null;
  return next ? idbSet(IDB_KEY, next).then(() => undefined) : Promise.resolve();
}

function persistLocalFallback(list: ChatSession[]): void {
  // Always store the COMPACTED copy so localStorage stays small. The full copy is
  // in IndexedDB, so if localStorage is full we don't alarm the user — their data
  // is safe in IDB; we only warn when IndexedDB is also unavailable.
  try {
    localStorage.setItem(KEY, JSON.stringify(compact(list)));
    lastStorageWarning = null;
  } catch {
    lastStorageWarning = idbAvailable()
      ? null
      : "Chat history could not be saved (browser storage unavailable or full).";
  }
}

function persist(list: ChatSession[]): void {
  cache = list;
  scheduleIdbWrite(list); // durable, full fidelity
  persistLocalFallback(list); // compacted fast-boot/fallback copy
  emit();
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => void flushChats());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flushChats();
  });
}

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function load(): ChatSession[] {
  return cache;
}

/** All chats, most-recently-updated first. */
export function listChats(): ChatSession[] {
  return [...load()].sort((a, b) => b.updatedAt - a.updatedAt);
}
export function getActiveId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}
function setActiveId(id: string): void {
  try {
    localStorage.setItem(ACTIVE_KEY, id);
  } catch {
    /* ignore */
  }
  setActiveWorkspace(id);
}

/** Create a new empty chat and make it active. */
export function newChat(): ChatSession {
  const now = Date.now();
  const s: ChatSession = { id: uid(), title: "New chat", createdAt: now, updatedAt: now, display: [], convo: [] };
  persist([...load(), s]);
  setActiveId(s.id);
  emit();
  return s;
}

/** The active chat, creating one if none exists yet. */
export function getActiveChat(): ChatSession {
  const id = getActiveId();
  const found = id ? load().find((c) => c.id === id) : undefined;
  return found ?? newChat();
}

export function setActiveChat(id: string): void {
  if (load().some((c) => c.id === id)) {
    setActiveId(id);
    emit();
  }
}

function deriveTitle(display: Display[], fallback: string): string {
  const firstUser = display.find((m) => m.role === "user" && m.text.trim());
  return firstUser ? firstUser.text.trim().slice(0, 60) : fallback;
}

/** Persist a specific chat by id (title auto-derived from the first user line). */
export function saveChat(id: string, display: Display[], convo: ChatMessage[]): void {
  if (!id) return;
  const list = [...load()];
  const i = list.findIndex((c) => c.id === id);
  if (i < 0) return;
  list[i] = { ...list[i], display, convo, updatedAt: Date.now(), title: deriveTitle(display, list[i].title) };
  persist(list);
}

/** Persist the active chat's messages (title auto-derived from the first user line). */
export function saveActive(display: Display[], convo: ChatMessage[]): void {
  const id = getActiveId();
  if (!id) return;
  saveChat(id, display, convo);
}

export function deleteChat(id: string): void {
  const list = load().filter((c) => c.id !== id);
  persist(list);
  deleteWorkspace(id);
  if (getActiveId() === id) {
    if (list.length) setActiveId([...list].sort((a, b) => b.updatedAt - a.updatedAt)[0].id);
    else
      try {
        localStorage.removeItem(ACTIVE_KEY);
      } catch {
        /* ignore */
      }
  }
  emit();
}
