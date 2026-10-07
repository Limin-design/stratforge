import type { StrategySpec } from "@stratforge/dsl";
import type { BacktestResult, Candle } from "@stratforge/engine";
import type { OptimizationSummary } from "./panels/strategyOptimize.js";

/**
 * Workspace-scoped pub/sub store.
 *
 * Each chat/workspace gets an isolated state snapshot (dataset, result, spec,
 * custom stats). Panels always read/write the *active* workspace unless an
 * explicit workspace id is provided.
 */
export interface AppState {
  candles: Candle[];
  datasetName: string;
  result: BacktestResult | null;
  /** The strategy behind `result` — shown/edited in the Strategy tab and drawn on the chart. */
  spec?: StrategySpec | null;
  /** Custom test results the AI analyst posts to the Stats tab. */
  customStats?: { name: string; value: string }[];
  /** Latest walk-forward optimization result — shown in the Strategy tab. */
  optimization?: OptimizationSummary | null;
}

export const DEFAULT_WORKSPACE_ID = "default";

export type WorkspaceId = string;

type Listener = (s: AppState, workspaceId: WorkspaceId) => void;

const listeners = new Set<Listener>();

const EMPTY_STATE = (): AppState => ({
  candles: [],
  datasetName: "(no dataset)",
  result: null,
  spec: null,
  customStats: [],
  optimization: null,
});

const workspaces = new Map<WorkspaceId, AppState>([[DEFAULT_WORKSPACE_ID, EMPTY_STATE()]]);
let activeWorkspaceId: WorkspaceId = DEFAULT_WORKSPACE_ID;

function ensureWorkspace(id: WorkspaceId): AppState {
  const ws = workspaces.get(id);
  if (ws) return ws;
  const fresh = EMPTY_STATE();
  workspaces.set(id, fresh);
  return fresh;
}

function emitActive(): void {
  const active = ensureWorkspace(activeWorkspaceId);
  for (const l of listeners) l(active, activeWorkspaceId);
}

export function getActiveWorkspaceId(): WorkspaceId {
  return activeWorkspaceId;
}

export function setActiveWorkspace(id: WorkspaceId): void {
  if (!id || id === activeWorkspaceId) return;
  ensureWorkspace(id);
  activeWorkspaceId = id;
  emitActive();
}

export function hasWorkspace(id: WorkspaceId): boolean {
  return workspaces.has(id);
}

export function deleteWorkspace(id: WorkspaceId): void {
  if (!workspaces.has(id) || id === DEFAULT_WORKSPACE_ID) return;
  workspaces.delete(id);
  if (activeWorkspaceId === id) {
    activeWorkspaceId = DEFAULT_WORKSPACE_ID;
    emitActive();
  }
}

export function getState(workspaceId?: WorkspaceId): AppState {
  return ensureWorkspace(workspaceId ?? activeWorkspaceId);
}

export function setState(patch: Partial<AppState>, workspaceId?: WorkspaceId): void {
  const id = workspaceId ?? activeWorkspaceId;
  const prev = ensureWorkspace(id);
  const next = { ...prev, ...patch };
  workspaces.set(id, next);
  if (id === activeWorkspaceId) emitActive();
}

/** Append a named custom stat (used by the agent's add_stat tool). */
export function addCustomStat(name: string, value: string, workspaceId?: WorkspaceId): void {
  const s = getState(workspaceId);
  setState({ customStats: [...(s.customStats ?? []), { name, value }] }, workspaceId);
}

export function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
