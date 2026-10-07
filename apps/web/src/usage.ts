/**
 * Local usage meter (on-device). Tracks tokens spent on the AI analyst and the
 * volume of market data processed, for the Profile dashboard. Cloud sync of
 * these is part of the backend plan (docs/research/08).
 */
const KEY = "stratforge.usage";

export interface Usage {
  tokens: number;
  /** Portion of `tokens` that is a local estimate because the provider returned no `usage` block. */
  estimatedTokens: number;
  requests: number;
  datasets: number;
  bars: number;
}
const ZERO: Usage = { tokens: 0, estimatedTokens: 0, requests: 0, datasets: 0, bars: 0 };

export function getUsage(): Usage {
  try {
    return { ...ZERO, ...(JSON.parse(localStorage.getItem(KEY) || "{}") as Partial<Usage>) };
  } catch {
    return { ...ZERO };
  }
}
let warned = false;
function save(u: Usage): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(u));
    warned = false;
  } catch {
    if (!warned) {
      warned = true;
      console.warn("[usage] unable to persist usage counters (storage unavailable/full)");
    }
  }
}
/**
 * Record one AI request. Always counts the request; adds `n` tokens. When the
 * provider returned no usage block the caller passes a local estimate with
 * `estimated = true`, so the meter never silently under-reports cost (and stays
 * honest about which part is estimated vs reported).
 */
export function recordTokens(n: number, estimated = false): void {
  const u = getUsage();
  const tokens = Number.isFinite(n) ? Math.max(0, n) : 0;
  u.tokens += tokens;
  if (estimated) u.estimatedTokens += tokens;
  u.requests += 1;
  save(u);
}
export function recordDataset(bars: number): void {
  const u = getUsage();
  u.datasets += 1;
  u.bars += Number.isFinite(bars) ? bars : 0;
  save(u);
}
export function resetUsage(): void {
  save({ ...ZERO });
}
