/**
 * Pure, DOM-free helpers for chat persistence — split out of `chats.ts` so the
 * data-integrity-critical logic (merge-without-loss, quota compaction) is
 * unit-testable in the node smoke harness without IndexedDB/localStorage.
 *
 * Type-only imports are erased at runtime, so importing this module never pulls
 * in the browser-only `chats.ts`/`llmClient.ts` runtime code.
 */
import type { ChatMessage } from "./agent/llmClient.js";

/** A rendered chat bubble — mirrors what the AI Analyst panel shows. */
export interface Display {
  role: "user" | "agent" | "tool" | "error";
  text: string;
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  display: Display[];
  convo: ChatMessage[];
}

/**
 * Merge two chat lists by id without losing a session. For a shared id the more
 * recently-updated session wins; on a tie `primary` wins (used to prefer the
 * full-fidelity IndexedDB copy over the compacted localStorage fast-boot copy).
 * Result is sorted most-recently-updated first. Neither input is mutated.
 */
export function mergeChatsById(primary: ChatSession[], secondary: ChatSession[]): ChatSession[] {
  const byId = new Map<string, ChatSession>();
  for (const c of secondary) byId.set(c.id, c);
  for (const c of primary) {
    const existing = byId.get(c.id);
    if (!existing || c.updatedAt >= existing.updatedAt) byId.set(c.id, c);
  }
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Bound a chat list for the localStorage fast-boot/fallback copy: keep recent
 * sessions richer, trim older ones, and cap per-message text. Full fidelity
 * lives in IndexedDB; this only needs to stay small enough to never hit quota.
 */
export function compact(list: ChatSession[]): ChatSession[] {
  return [...list]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((chat, index) => {
      const keepDisplay = index < 3 ? 280 : 120;
      const keepConvo = index < 3 ? 140 : 60;
      return {
        ...chat,
        display: chat.display.slice(-keepDisplay).map((m) => ({ ...m, text: m.text.slice(0, 8000) })),
        convo: chat.convo.slice(-keepConvo),
      };
    });
}
