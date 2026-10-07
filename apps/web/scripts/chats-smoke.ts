/**
 * Chat persistence logic smoke — covers the data-integrity-critical parts of the
 * localStorage→IndexedDB migration without needing a real IndexedDB:
 *   - mergeChatsById never loses a session, newer-by-updatedAt wins, ties favour
 *     the fuller (IDB/primary) copy
 *   - compact bounds the localStorage fallback copy (message counts + text length)
 *
 * Run: node --experimental-strip-types scripts/chats-smoke.ts
 */
import { compact, mergeChatsById, type ChatSession } from "../src/chatsMerge.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function chat(id: string, updatedAt: number, msgs: number): ChatSession {
  return {
    id,
    title: id,
    createdAt: 0,
    updatedAt,
    display: Array.from({ length: msgs }, (_, i) => ({ role: "user" as const, text: `m${i}` })),
    convo: Array.from({ length: msgs }, (_, i) => ({ role: "user" as const, content: `m${i}` })),
  };
}

// 1. union without loss: ids present in either list survive.
{
  const idb = [chat("a", 100, 1), chat("b", 100, 1)];
  const local = [chat("b", 100, 1), chat("c", 100, 1)];
  const merged = mergeChatsById(idb, local);
  const ids = merged.map((c) => c.id).sort();
  assert(ids.join(",") === "a,b,c", "merge must keep every session id (no loss)");
}

// 2. newer updatedAt wins (a post-boot localStorage write beats the older IDB copy).
{
  const idb = [chat("a", 100, 5)];
  const local = [chat("a", 200, 2)]; // newer but compacted
  const merged = mergeChatsById(idb, local);
  assert(merged.length === 1 && merged[0].updatedAt === 200, "newer-by-updatedAt must win");
  assert(merged[0].display.length === 2, "the newer (local) session content must be used");
}

// 3. tie favours primary (the fuller IDB copy) over the compacted localStorage copy.
{
  const idbFull = [chat("a", 100, 50)];
  const localCompact = [chat("a", 100, 3)];
  const merged = mergeChatsById(idbFull, localCompact);
  assert(merged[0].display.length === 50, "on a tie the fuller primary (IDB) copy must win");
}

// 4. sorted most-recently-updated first.
{
  const merged = mergeChatsById([chat("old", 1, 1), chat("new", 9, 1)], []);
  assert(merged[0].id === "new" && merged[1].id === "old", "result must be sorted newest-first");
}

// 5. compact bounds the fallback copy.
{
  const big = chat("a", 100, 1000);
  big.display = big.display.map((m) => ({ ...m, text: "x".repeat(20000) }));
  const [c] = compact([big]);
  assert(c.display.length === 280, "recent chat display must be capped at 280");
  assert(c.convo.length === 140, "recent chat convo must be capped at 140");
  assert(c.display[0].text.length === 8000, "per-message text must be capped at 8000 chars");
}

// 6. compact is harsher on older (index >= 3) chats.
{
  const list = Array.from({ length: 5 }, (_, i) => chat(`c${i}`, 100 - i, 1000));
  const out = compact(list);
  assert(out[0].display.length === 280 && out[3].display.length === 120, "older chats trimmed harder (120)");
}

// 7. purity: inputs are not mutated.
{
  const a = [chat("a", 100, 3)];
  const b = [chat("b", 100, 3)];
  mergeChatsById(a, b);
  compact(a);
  assert(a.length === 1 && a[0].display.length === 3, "mergeChatsById/compact must not mutate inputs");
}

console.log("chats-smoke: OK (no-loss merge, newer-wins, tie-favours-fuller, sort, compaction bounds, purity)");
