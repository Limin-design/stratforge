/**
 * Profile — account, configured resources (AI/data key tags), and a usage
 * dashboard (tokens spent, data processed). Conversation history + cross-device
 * sync arrive with the cloud backend (docs/research/08).
 */
import { useEffect, useState } from "react";
import { getAgentConfig, subscribeAgentConfig } from "../agent/config.js";
import { hasVault, subscribeVault } from "../agent/vault.js";
import {
  deleteChat,
  getChatsStorageWarning,
  listChats,
  setActiveChat,
  subscribeChats,
  type ChatSession,
} from "../chats.js";
import { getSession } from "../cloud/supabase.js";
import { getActiveWorkspaceId, subscribe } from "../store.js";
import { clearErrors, getRecentErrors, subscribeErrors, type TrackedError } from "../telemetry/errorTracker.js";
import { getUsage, resetUsage } from "../usage.js";

function providerName(url: string): string {
  const map: [RegExp, string][] = [
    [/openrouter/i, "OpenRouter"], [/openai\.azure|azure/i, "Azure OpenAI"], [/openai/i, "OpenAI"],
    [/anthropic/i, "Anthropic"], [/nvidia/i, "NVIDIA"], [/groq/i, "Groq"], [/deepseek/i, "DeepSeek"],
    [/mistral/i, "Mistral"], [/together/i, "Together"], [/fireworks/i, "Fireworks"], [/x\.ai/i, "xAI"],
    [/googleapis|gemini/i, "Google Gemini"], [/11434/, "Ollama"], [/1234/, "LM Studio"],
  ];
  for (const [re, name] of map) if (re.test(url)) return name;
  return "Custom";
}

const tag = { fontSize: 11, padding: "4px 10px", borderRadius: 20, background: "var(--bg-1)", border: "1px solid var(--border)", color: "var(--text)" } as const;
const ghost = { background: "var(--bg-3)", color: "var(--text)", border: "1px solid var(--border)" } as const;

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ flex: "1 1 110px", background: "var(--bg-1)", border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px" }}>
      <div style={{ color: "var(--white)", fontWeight: 700, fontSize: 18 }}>{value}</div>
      <div className="cli-hint" style={{ fontSize: 11 }}>{label}</div>
    </div>
  );
}

function relTime(ts: number): string {
  const s = Math.max(0, Date.now() - ts) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function msgCount(c: ChatSession): number {
  return c.display.filter((d) => d.role === "user" || d.role === "agent").length;
}

export function ProfilePanel() {
  const [, force] = useState(0);
  const [chats, setChats] = useState<ChatSession[]>(() => listChats());
  const [storageWarning, setStorageWarning] = useState<string | null>(() => getChatsStorageWarning());
  const [activeWorkspaceId, setActiveWorkspaceId] = useState(() => getActiveWorkspaceId());
  const [errors, setErrors] = useState<TrackedError[]>(() => getRecentErrors());
  const [, forceCfg] = useState(0);
  const [, forceVault] = useState(0);
  useEffect(
    () =>
      subscribeChats(() => {
        setChats(listChats());
        setStorageWarning(getChatsStorageWarning());
      }),
    []
  );
  useEffect(() => subscribe((_, workspaceId) => setActiveWorkspaceId(workspaceId)), []);
  useEffect(() => subscribeAgentConfig(() => forceCfg((n) => n + 1)), []);
  useEffect(() => subscribeVault(() => forceVault((n) => n + 1)), []);
  useEffect(() => subscribeErrors(() => setErrors(getRecentErrors())), []);
  const session = getSession();
  const usage = getUsage();
  const cfg = getAgentConfig(activeWorkspaceId);
  const aiProvider = cfg.baseUrl ? providerName(cfg.baseUrl) : "—";

  return (
    <div className="cli-panel" style={{ overflowY: "auto" }}>
      <span className="cli-prompt">profile</span>

      <div className="cli-box">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 44, height: 44, borderRadius: "50%", background: "linear-gradient(160deg,#3c4453,#21252d)", display: "grid", placeItems: "center", color: "#fff", fontWeight: 800, fontSize: 18 }}>
            {(session?.user.email?.[0] ?? "U").toUpperCase()}
          </div>
          <div>
            <div style={{ color: "var(--white)", fontWeight: 700 }}>{session?.user.email ?? "Local user"}</div>
            <div className="cli-hint">{session ? "signed in" : "not signed in — use the Cloud tab to sync across devices"}</div>
          </div>
        </div>
      </div>

      <div className="cli-box">
        <strong>Resources</strong>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          <span style={tag}>AI ({activeWorkspaceId.slice(0, 6)}) · {aiProvider}{cfg.model ? ` · ${cfg.model}` : ""}</span>
          <span style={tag}>{hasVault(activeWorkspaceId) ? "🔒 AI key saved" : "AI key not saved"}</span>
          <span style={tag}>Data · {usage.datasets} dataset{usage.datasets === 1 ? "" : "s"} loaded</span>
        </div>
        <span className="cli-hint">AI keys live in the AI Analyst tab, exchange keys in Data Hub — stored encrypted, never shown. Only the source name is displayed.</span>
      </div>

      <div className="cli-box">
        <strong>Usage</strong>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <Stat label="AI tokens" value={usage.tokens.toLocaleString()} />
          <Stat label="AI requests" value={usage.requests.toLocaleString()} />
          <Stat label="Datasets" value={usage.datasets.toLocaleString()} />
          <Stat label="Bars processed" value={usage.bars.toLocaleString()} />
        </div>
        {usage.estimatedTokens > 0 && (
          <span className="cli-hint" style={{ fontSize: 11 }}>
            ~{usage.estimatedTokens.toLocaleString()} of these tokens are estimated — that provider
            didn't report usage, so the count is approximate.
          </span>
        )}
        <button className="cli-btn" style={{ ...ghost, alignSelf: "flex-start", fontSize: 11, padding: "5px 10px" }} onClick={() => { resetUsage(); force((n) => n + 1); }}>
          Reset counters
        </button>
      </div>

      <div className="cli-box">
        <strong>
          Diagnostics <span className="cli-hint" style={{ fontWeight: 400 }}>({errors.length})</span>
        </strong>
        <span className="cli-hint" style={{ fontSize: 11 }}>
          Recent app errors, captured on-device with secrets and personal data scrubbed out. Nothing
          is sent anywhere.
        </span>
        {errors.length === 0 ? (
          <span className="cli-hint">No errors recorded — good sign.</span>
        ) : (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
              {errors.slice(0, 8).map((e) => (
                <div key={e.id} style={{ padding: "6px 8px", background: "var(--bg-1)", border: "1px solid var(--border)", borderRadius: 6 }}>
                  <div style={{ color: "var(--white)", fontSize: 12, wordBreak: "break-word" }}>
                    <span className="cli-hint" style={{ fontSize: 11 }}>{e.kind}</span> · {e.name}: {e.message.slice(0, 200)}
                  </div>
                  <div className="cli-hint" style={{ fontSize: 11 }}>{relTime(e.ts)}</div>
                </div>
              ))}
            </div>
            <button className="cli-btn" style={{ ...ghost, alignSelf: "flex-start", fontSize: 11, padding: "5px 10px", marginTop: 6 }} onClick={() => clearErrors()}>
              Clear diagnostics
            </button>
          </>
        )}
      </div>

      <div className="cli-box">
        <strong>
          Conversations <span className="cli-hint" style={{ fontWeight: 400 }}>({chats.length})</span>
        </strong>
        {storageWarning && (
          <div
            style={{
              marginTop: 8,
              marginBottom: 8,
              padding: "8px 10px",
              borderRadius: 8,
              border: "1px solid #5a4a2d",
              background: "rgba(160,120,40,0.16)",
              color: "#f1d79b",
              fontSize: 12,
            }}
          >
            {storageWarning}
          </div>
        )}
        {chats.length === 0 ? (
          <span className="cli-hint">No saved chats yet — talk to the AI Analyst and they'll appear here.</span>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {chats.map((c) => (
              <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", background: "var(--bg-1)", border: "1px solid var(--border)", borderRadius: 6 }}>
                <button
                  onClick={() => setActiveChat(c.id)}
                  title="open in the AI Analyst tab"
                  style={{ flex: 1, textAlign: "left", background: "none", border: "none", color: "var(--text)", cursor: "pointer", font: "inherit", padding: 0 }}
                >
                  <div style={{ color: "var(--white)", fontSize: 13 }}>{c.title || "Untitled chat"}</div>
                  <div className="cli-hint" style={{ fontSize: 11 }}>{relTime(c.updatedAt)} · {msgCount(c)} messages</div>
                </button>
                <button onClick={() => deleteChat(c.id)} title="delete chat" style={{ ...ghost, padding: "2px 9px", fontSize: 12, cursor: "pointer", borderRadius: 6 }}>
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
        <span className="cli-hint">Click a chat to open it in the AI Analyst tab. History is stored on this device; account sync is the cloud follow-up.</span>
      </div>
    </div>
  );
}
