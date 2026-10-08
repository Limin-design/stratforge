import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { runAgent, type ChatMessage, type ProviderConfig } from "../agent/llmClient.js";
import { getAgentConfig, setAgentConfig, subscribeAgentConfig } from "../agent/config.js";
import { SYSTEM_PROMPT } from "../agent/persona.js";
import { executeTool, TOOL_DEFS } from "../agent/tools.js";
import { marketSnapshot } from "../agent/marketSnapshot.js";
import { getLiveStatus, onCandleClose, onLiveStatus, type LiveStatus } from "./live.js";
import {
  clearVault,
  decryptJson,
  encryptJson,
  hasVault,
  loadVaultBlob,
  saveVaultBlob,
  subscribeVault,
} from "../agent/vault.js";
import {
  getActiveChat,
  getActiveId,
  listChats,
  newChat,
  saveActive,
  saveChat,
  setActiveChat,
  subscribeChats,
  type ChatSession,
  type Display,
} from "../chats.js";
import { DEFAULT_WORKSPACE_ID, setActiveWorkspace } from "../store.js";

// Any OpenAI-compatible provider works — these are just shortcuts. The base URL
// stays editable, so a provider not listed here works by pasting its URL.
const PRESETS: Record<string, string> = {
  OpenRouter: "https://openrouter.ai/api/v1",
  OpenAI: "https://api.openai.com/v1",
  Anthropic: "https://api.anthropic.com/v1",
  "Google Gemini": "https://generativelanguage.googleapis.com/v1beta/openai",
  NVIDIA: "https://integrate.api.nvidia.com/v1",
  "Azure OpenAI": "https://YOUR-RESOURCE.openai.azure.com/openai/deployments/YOUR-DEPLOYMENT",
  Groq: "https://api.groq.com/openai/v1",
  DeepSeek: "https://api.deepseek.com/v1",
  Mistral: "https://api.mistral.ai/v1",
  Together: "https://api.together.xyz/v1",
  Fireworks: "https://api.fireworks.ai/inference/v1",
  xAI: "https://api.x.ai/v1",
  Ollama: "http://localhost:11434/v1",
  "LM Studio": "http://localhost:1234/v1",
};

const GREETING: Display = {
  role: "agent",
  text: "Analyst online. Load a dataset, then describe a strategy or a factor idea — I'll build it, backtest it with realistic costs, and tell you honestly whether the edge is real or overfit. Configure your model/key below first (bring your own).",
};
const SYSTEM_MSG: ChatMessage = { role: "system", content: SYSTEM_PROMPT };

export function AgentPanel() {
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [config, setConfig] = useState<ProviderConfig>(() => {
    const workspaceId = getActiveId() ?? DEFAULT_WORKSPACE_ID;
    const saved = getAgentConfig(workspaceId);
    return { baseUrl: saved.baseUrl, apiKey: "", model: saved.model };
  });
  // Start folded when a local server (no key needed) is already configured; otherwise show the setup.
  const [showSettings, setShowSettings] = useState(() => {
    const saved = getAgentConfig(getActiveId() ?? DEFAULT_WORKSPACE_ID);
    return !(saved.model && /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(saved.baseUrl.trim()));
  });
  const [passphrase, setPassphrase] = useState("");
  const [locked, setLocked] = useState(() => hasVault(getActiveId() ?? DEFAULT_WORKSPACE_ID));
  const [vaultMsg, setVaultMsg] = useState<string | null>(() =>
    hasVault(getActiveId() ?? DEFAULT_WORKSPACE_ID) ? "encrypted key found — enter your passphrase and unlock" : null
  );
  const [messages, setMessages] = useState<Display[]>([GREETING]);
  const messagesRef = useRef<Display[]>([GREETING]);
  const [chats, setChats] = useState<ChatSession[]>(() => listChats());
  const [chatId, setChatId] = useState<string>(() => getActiveId() ?? "");
  const chatIdRef = useRef<string>("");
  const [input, setInput] = useState("");
  const [busyChatId, setBusyChatId] = useState<string | null>(null);
  const runSeqRef = useRef(0);
  const inflightRunRef = useRef<{ chatId: string; seq: number } | null>(null);
  const convoRef = useRef<ChatMessage[]>([SYSTEM_MSG]);
  const apiKeyRef = useRef("");

  // Connected = a model is named and there is a key, or the endpoint is a local server that needs none.
  const isLocalEndpoint = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(config.baseUrl.trim());
  const connected = Boolean(config.model.trim()) && (Boolean(config.apiKey) || isLocalEndpoint);
  const endpointHost = (() => {
    try {
      return new URL(config.baseUrl).host;
    } catch {
      return config.baseUrl;
    }
  })();

  const busy = busyChatId === chatId;
  const anyBusy = busyChatId !== null;

  const currentWorkspaceId = () => chatIdRef.current || getActiveId() || DEFAULT_WORKSPACE_ID;

  useEffect(() => {
    apiKeyRef.current = config.apiKey;
  }, [config.apiKey]);

  const applyMessages = (next: Display[]) => {
    messagesRef.current = next;
    setMessages(next);
  };
  const add = (m: Display) => applyMessages([...messagesRef.current, m]);
  const loadSession = (s: ChatSession) => {
    applyMessages(s.display.length ? s.display : [GREETING]);
    convoRef.current = s.convo.length ? s.convo : [SYSTEM_MSG];
    chatIdRef.current = s.id;
    setChatId(s.id);
    setActiveWorkspace(s.id);
    applyWorkspaceAgentConfig(s.id);
    const scopedVault = hasVault(s.id);
    setLocked(scopedVault);
    setVaultMsg(scopedVault ? "encrypted key found — enter your passphrase and unlock" : null);
    setConfig((prev) => ({ ...prev, apiKey: "" }));
  };

  const applyWorkspaceAgentConfig = (workspaceId: string) => {
    const saved = getAgentConfig(workspaceId);
    setConfig((prev) => ({ ...prev, baseUrl: saved.baseUrl, model: saved.model }));
  };

  const updateWorkspaceAgentConfig = (patch: Partial<ProviderConfig>) => {
    const workspaceId = chatIdRef.current || getActiveId() || DEFAULT_WORKSPACE_ID;
    setConfig((prev) => {
      const next = { ...prev, ...patch };
      setAgentConfig(workspaceId, { baseUrl: next.baseUrl, model: next.model });
      return next;
    });
  };

  // Load the active chat on mount and keep the picker in sync. Switching the
  // active chat (e.g. from the Profile tab) swaps the conversation here live.
  useEffect(() => {
    const s = getActiveChat();
    loadSession(s);
    if (s.display.length === 0) saveActive([GREETING], [SYSTEM_MSG]);
    setChats(listChats());
    return subscribeChats(() => {
      setChats(listChats());
      const aid = getActiveId();
      if (aid && aid !== chatIdRef.current) {
        const ns = listChats().find((c) => c.id === aid);
        if (ns) loadSession(ns);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() =>
    subscribeAgentConfig((workspaceId, nextCfg) => {
      if (workspaceId !== currentWorkspaceId()) return;
      setConfig((prev) => ({ ...prev, baseUrl: nextCfg.baseUrl, model: nextCfg.model }));
    }), []);

  useEffect(() =>
    subscribeVault((workspaceId, hasEncryptedBlob) => {
      if (workspaceId !== currentWorkspaceId()) return;
      setLocked(hasEncryptedBlob && !apiKeyRef.current);
      if (!hasEncryptedBlob) {
        setConfig((prev) => ({ ...prev, apiKey: "" }));
        setVaultMsg(null);
      }
    }), []);

  const unlock = async () => {
    const workspaceId = currentWorkspaceId();
    const blob = loadVaultBlob(workspaceId);
    if (!blob) return;
    try {
      const cfg = await decryptJson<Partial<ProviderConfig>>(blob, passphrase);
      const workspaceId = currentWorkspaceId();
      setConfig((prev) => {
        const next: ProviderConfig = {
          ...prev,
          apiKey: typeof cfg.apiKey === "string" ? cfg.apiKey : prev.apiKey,
          baseUrl: typeof cfg.baseUrl === "string" && cfg.baseUrl.trim() ? cfg.baseUrl : prev.baseUrl,
          model: typeof cfg.model === "string" ? cfg.model : prev.model,
        };
        setAgentConfig(workspaceId, { baseUrl: next.baseUrl, model: next.model });
        return next;
      });
      setLocked(false);
      setVaultMsg("unlocked — key decrypted in memory");
      setShowSettings(false);
    } catch {
      setVaultMsg("wrong passphrase");
    }
  };

  const saveKey = async () => {
    if (!passphrase) {
      setVaultMsg("enter a passphrase to encrypt the key");
      return;
    }
    const workspaceId = currentWorkspaceId();
    const blob = await encryptJson({ apiKey: config.apiKey }, passphrase);
    saveVaultBlob(blob, workspaceId);
    setLocked(false);
    setVaultMsg("saved — encrypted on this device only (passphrase never stored)");
    if (config.model.trim()) setShowSettings(false);
  };

  const forget = () => {
    const workspaceId = currentWorkspaceId();
    clearVault(workspaceId);
    setConfig((prev) => ({ ...prev, apiKey: "" }));
    setLocked(false);
    setVaultMsg("vault cleared for this workspace");
  };

  const clearChat = () => {
    const cleared: Display[] = [{ role: "agent", text: "Cleared. Describe a strategy or a factor idea to analyze." }];
    applyMessages(cleared);
    convoRef.current = [SYSTEM_MSG];
    saveActive(cleared, convoRef.current);
  };
  const startNewChat = () => {
    const s = newChat();
    loadSession(s);
    saveActive([GREETING], [SYSTEM_MSG]);
  };

  const send = async (autoText?: string) => {
    const text = (autoText ?? input).trim();
    if (!text || anyBusy) return;
    if (!config.model) {
      setShowSettings(true);
      add({ role: "error", text: "set a model name in settings first (and an API key unless using a local server)." });
      return;
    }

    const runChatId = chatIdRef.current;
    const runSeq = ++runSeqRef.current;
    inflightRunRef.current = { chatId: runChatId, seq: runSeq };
    setBusyChatId(runChatId);

    if (autoText === undefined) setInput("");
    // The analyst always sees the current chart: attach a compact snapshot to the model's copy of the message.
    const snap = marketSnapshot(runChatId, 20);
    const content = snap
      ? `${text}

[Chart snapshot, attached automatically; current data, not written by the user]
${JSON.stringify(snap)}`
      : text;
    let runDisplay = [...messagesRef.current, { role: "user", text: autoText ? "⟳ auto: new candle closed, analysing the chart" : text } as Display];
    let runConvo = [...convoRef.current, { role: "user", content } as ChatMessage];
    applyMessages(runDisplay);
    convoRef.current = runConvo;
    saveChat(runChatId, runDisplay, runConvo);

    const sameRun = () => inflightRunRef.current?.chatId === runChatId && inflightRunRef.current?.seq === runSeq;
    const append = (m: Display) => {
      if (!sameRun()) return;
      runDisplay = [...runDisplay, m];
      if (chatIdRef.current === runChatId) applyMessages(runDisplay);
      saveChat(runChatId, runDisplay, runConvo);
    };

    let hadError = false;
    try {
      const nextConvo = await runAgent(
        config,
        runConvo,
        TOOL_DEFS,
        (name, args) => executeTool(name, args, { workspaceId: runChatId }),
        (e) => {
          if (e.type === "assistant") append({ role: "agent", text: e.text });
          else if (e.type === "tool_call") append({ role: "tool", text: `⚙ ${e.name}` });
          else if (e.type === "error") {
            hadError = true;
            append({ role: "error", text: e.text });
          }
        }
      );
      // The model answered, so the provider setup works: fold the settings away.
      if (!hadError) setShowSettings(false);
      if (sameRun()) {
        runConvo = nextConvo;
        saveChat(runChatId, runDisplay, runConvo);
        if (chatIdRef.current === runChatId) {
          convoRef.current = runConvo;
          applyMessages(runDisplay);
        }
      }
    } catch (e) {
      append({ role: "error", text: `error: ${e instanceof Error ? e.message : e}` });
    } finally {
      if (sameRun()) {
        inflightRunRef.current = null;
        setBusyChatId(null);
      }
    }
  };

  // Watch mode: when live data closes a bar, the analyst gets a turn on its own.
  const [watch, setWatch] = useState(false);
  const [live, setLive] = useState<LiveStatus>(getLiveStatus());
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => onLiveStatus(setLive), []);
  useEffect(() => {
    if (!watch) return;
    return onCandleClose((c) => {
      if (c.workspaceId !== chatIdRef.current) return;
      void sendRef.current(
        `A new candle just closed on ${c.dataset}. In two or three short lines: what changed (trend, momentum, volatility), and would the current strategy's trigger fire now? No trade advice.`
      );
    });
  }, [watch]);

  const onPanelKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      inputRef.current?.focus();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      onMouseDown={() => rootRef.current?.focus()}
      onKeyDown={onPanelKeyDown}
      className="cli-panel cli-panel-focusable"
      style={{ outline: "none" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="cli-prompt" style={{ flex: 1 }}>
          the analyst {busy ? "— thinking…" : anyBusy ? "— another chat is running…" : ""} <span className="cli-shortcuts" style={{ marginLeft: 6 }}>Ctrl/Cmd+K focus · Ctrl/Cmd+Enter send</span>
        </span>
        <select
          className="cli-select"
          value={chatId}
          onChange={(e) => setActiveChat(e.target.value)}
          title="switch chat"
          style={{ maxWidth: 150, fontSize: 11, padding: "3px 6px" }}
        >
          {chats.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title || "New chat"}
            </option>
          ))}
        </select>
        <button className="cli-btn" style={{ padding: "3px 8px" }} onClick={startNewChat} title="start a new chat" disabled={anyBusy}>
          ＋ new
        </button>
        <button className="cli-btn" style={{ padding: "3px 8px", background: "var(--bg-3)", color: "var(--text)", border: "1px solid var(--border)" }} onClick={clearChat} title="clear this conversation" disabled={anyBusy}>
          clear
        </button>
        <button className="cli-btn" style={{ padding: "3px 8px" }} onClick={() => setShowSettings((s) => !s)}>
          {showSettings ? "hide" : "model"}
        </button>
      </div>

      {!showSettings && (
        <div className="cli-hint" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
          <span style={{ color: connected ? "#3fb27f" : "var(--text-dim)" }}>●</span>
          <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {connected ? `${config.model} · ${endpointHost}` : locked ? "key saved on this device: unlock it to connect" : "no model connected"}
          </span>
          <button className="cli-btn" style={{ padding: "1px 8px", fontSize: 11 }} onClick={() => setShowSettings(true)}>
            {connected ? "change" : "connect"}
          </button>
        </div>
      )}

      {showSettings && (
        <div className="cli-box" style={{ gap: 6 }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {Object.entries(PRESETS).map(([name, url]) => (
              <button
                key={name}
                className="cli-btn"
                style={{ padding: "2px 7px", fontSize: 11 }}
                onClick={() => updateWorkspaceAgentConfig({ baseUrl: url })}
              >
                {name}
              </button>
            ))}
          </div>
          <input
            className="cli-input"
            placeholder="base URL"
            value={config.baseUrl}
            onChange={(e) => updateWorkspaceAgentConfig({ baseUrl: e.target.value })}
          />
          <input
            className="cli-input"
            placeholder="model (e.g. anthropic/claude-sonnet-4.6, gpt-4o, llama3.1)"
            value={config.model}
            onChange={(e) => updateWorkspaceAgentConfig({ model: e.target.value })}
          />
          <input
            className="cli-input"
            type="password"
            placeholder="API key (blank for local servers)"
            value={config.apiKey}
            onChange={(e) => setConfig((c) => ({ ...c, apiKey: e.target.value }))}
          />
          <div style={{ display: "flex", gap: 6 }}>
            <input
              className="cli-input"
              style={{ flex: 1 }}
              type="password"
              placeholder="vault passphrase (to save/unlock the key on this device)"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
            />
            {locked ? (
              <button className="cli-btn" onClick={unlock}>
                unlock
              </button>
            ) : (
              <button className="cli-btn" onClick={saveKey}>
                save
              </button>
            )}
            {hasVault(currentWorkspaceId()) && (
              <button className="cli-btn" onClick={forget}>
                forget
              </button>
            )}
          </div>
          <span className="cli-hint">
            {vaultMsg ??
              "key stays in memory unless you save it — saving encrypts it with your passphrase (zero-knowledge, on-device). Browser CORS varies by provider; OpenRouter and local servers work today."}
          </span>
        </div>
      )}

      <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
        {messages.map((m, i) =>
          m.role === "tool" ? (
            <div key={i} style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
              {m.text}
            </div>
          ) : m.role === "error" ? (
            <div key={i} className="cli-error">
              {m.text}
            </div>
          ) : (
            <div key={i} className={`cli-msg ${m.role}`}>
              {m.text}
            </div>
          )
        )}
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <input
          ref={inputRef}
          className="cli-input"
          style={{ flex: 1 }}
          value={input}
          disabled={anyBusy}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void send()}
          placeholder="❯ describe a strategy or a factor idea…"
        />
        <button className="cli-btn" onClick={() => void send()} disabled={anyBusy}>
          send
        </button>
      </div>
      <label className="cli-hint" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
        <input type="checkbox" checked={watch} onChange={(e) => setWatch(e.target.checked)} />
        watch the chart: comment on every closed candle (uses your model credits)
        {watch && live.state === "off" && <span style={{ color: "var(--text-dim)" }}>· turn on live above the chart</span>}
      </label>
    </div>
  );
}
