import { DEFAULT_WORKSPACE_ID, type WorkspaceId } from "../store.js";

export interface AgentWorkspaceConfig {
  baseUrl: string;
  model: string;
}

const LEGACY_KEY = "stratforge.agentcfg";
const WORKSPACE_KEY = "stratforge.agentcfg.workspaces";
const DEFAULT_CFG: AgentWorkspaceConfig = {
  baseUrl: "https://openrouter.ai/api/v1",
  model: "",
};

type Listener = (workspaceId: WorkspaceId, config: AgentWorkspaceConfig) => void;
const listeners = new Set<Listener>();
let storageBridgeInstalled = false;

function emit(workspaceId: WorkspaceId, config: AgentWorkspaceConfig): void {
  for (const l of listeners) l(workspaceId, config);
}

function normalize(raw: unknown): AgentWorkspaceConfig {
  const obj = (raw && typeof raw === "object" ? raw : {}) as { baseUrl?: unknown; model?: unknown };
  const baseUrl = typeof obj.baseUrl === "string" && obj.baseUrl.trim() ? obj.baseUrl.trim() : DEFAULT_CFG.baseUrl;
  const model = typeof obj.model === "string" ? obj.model : DEFAULT_CFG.model;
  return { baseUrl, model };
}

function readAll(): Record<string, AgentWorkspaceConfig> {
  try {
    const parsed = JSON.parse(localStorage.getItem(WORKSPACE_KEY) || "{}") as Record<string, unknown>;
    const out: Record<string, AgentWorkspaceConfig> = {};
    for (const [id, cfg] of Object.entries(parsed)) out[id] = normalize(cfg);
    return out;
  } catch {
    return {};
  }
}

function writeAll(next: Record<string, AgentWorkspaceConfig>): void {
  try {
    localStorage.setItem(WORKSPACE_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

function readLegacy(): AgentWorkspaceConfig | null {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return null;
    return normalize(JSON.parse(raw));
  } catch {
    return null;
  }
}

function clearLegacy(): void {
  try {
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* ignore */
  }
}

function migrateLegacyFor(workspaceId: WorkspaceId): AgentWorkspaceConfig {
  const all = readAll();
  if (all[workspaceId]) return all[workspaceId];

  const legacy = readLegacy();
  const next = legacy ?? DEFAULT_CFG;
  all[workspaceId] = next;
  writeAll(all);
  if (legacy) clearLegacy();
  return next;
}

function installStorageBridge(): void {
  if (storageBridgeInstalled || typeof window === "undefined") return;
  storageBridgeInstalled = true;

  window.addEventListener("storage", (event) => {
    if (event.storageArea !== localStorage) return;
    if (event.key !== WORKSPACE_KEY && event.key !== LEGACY_KEY) return;

    const all = readAll();
    if (Object.keys(all).length === 0) {
      emit(DEFAULT_WORKSPACE_ID, getAgentConfig(DEFAULT_WORKSPACE_ID));
      return;
    }
    for (const [workspaceId, cfg] of Object.entries(all)) {
      emit(workspaceId, cfg);
    }
  });
}

export function getAgentConfig(workspaceId?: WorkspaceId): AgentWorkspaceConfig {
  const id = workspaceId || DEFAULT_WORKSPACE_ID;
  return migrateLegacyFor(id);
}

export function setAgentConfig(workspaceId: WorkspaceId, patch: Partial<AgentWorkspaceConfig>): AgentWorkspaceConfig {
  const id = workspaceId || DEFAULT_WORKSPACE_ID;
  const all = readAll();
  const prev = all[id] ?? getAgentConfig(id);
  const next = normalize({ ...prev, ...patch });
  all[id] = next;
  writeAll(all);
  emit(id, next);
  return next;
}

export function subscribeAgentConfig(listener: Listener): () => void {
  installStorageBridge();
  listeners.add(listener);
  return () => listeners.delete(listener);
}
