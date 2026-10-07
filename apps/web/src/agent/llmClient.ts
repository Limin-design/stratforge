/**
 * Minimal, dependency-free, multi-provider LLM client.
 *
 * Speaks the OpenAI-compatible /chat/completions API with tool calling, so a
 * single implementation covers OpenAI, OpenRouter, LiteLLM, local servers
 * (Ollama/LM Studio), and Anthropic's OpenAI-compatible endpoint — just point
 * `baseUrl` at the provider and supply the user's own key. No SDK needed.
 *
 * Note: browser CORS varies by provider. OpenRouter and local servers work from
 * the browser; some hosted APIs don't. In the Tauri desktop build this is a
 * non-issue. Secure key storage is the follow-up (docs/research/03).
 */
import type { ToolDef } from "./tools.js";
import { recordTokens } from "../usage.js";

export interface ProviderConfig {
  baseUrl: string; // e.g. https://openrouter.ai/api/v1
  apiKey: string;
  model: string;
}

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: Role;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

/**
 * Rough token estimate (~4 chars/token) over message text + tool-call payloads.
 * Used only when a provider omits a `usage` block, so the usage meter approximates
 * cost instead of recording zero. Deliberately conservative-simple, not exact.
 */
function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === "string") chars += m.content.length;
    if (m.name) chars += m.name.length;
    for (const tc of m.tool_calls ?? []) {
      chars += (tc.function.name?.length ?? 0) + (tc.function.arguments?.length ?? 0);
    }
  }
  return Math.ceil(chars / 4);
}

export type AgentEvent =
  | { type: "assistant"; text: string }
  | { type: "tool_call"; name: string; args: unknown }
  | { type: "tool_result"; name: string; result: unknown }
  | { type: "error"; text: string };

/**
 * Pick the HTTP transport. In the Tauri desktop app we route through the Rust
 * side (tauri-plugin-http), which is NOT subject to browser CORS — so providers
 * that don't send CORS headers (Azure OpenAI, OpenAI, Anthropic) work. In a
 * plain browser (the `pnpm dev` web build) we fall back to window.fetch, which
 * works for CORS-friendly providers (OpenRouter, local servers).
 */
async function pickFetch(): Promise<typeof fetch> {
  const w = globalThis as unknown as { __TAURI_INTERNALS__?: unknown };
  if (w.__TAURI_INTERNALS__) {
    try {
      const mod = await import("@tauri-apps/plugin-http");
      return mod.fetch as unknown as typeof fetch;
    } catch {
      /* plugin unavailable — fall back to browser fetch */
    }
  }
  return fetch.bind(globalThis);
}

/**
 * Resolve the chat-completions URL and whether the endpoint is Azure, from the
 * user's base URL. Azure is the non-standard one: it authenticates with an
 * `api-key` header (not Bearer) and needs an `api-version` query parameter, across
 * THREE surfaces:
 *   - classic Azure OpenAI       (.../openai/deployments/<name>) → api-version=2024-10-21
 *   - new Azure OpenAI v1        (.../openai/v1)                 → api-version=preview
 *   - Azure AI Foundry inference (.../models/chat/completions)   → api-version=2024-05-01-preview
 * An explicit `?api-version=...` in the URL always wins, and we never double-append
 * `/chat/completions` when the URL already targets it.
 */
export function resolveChatEndpoint(baseUrl: string): { url: string; isAzure: boolean } {
  const isAzure = /\.openai\.azure\.com|\.services\.ai\.azure\.com/i.test(baseUrl);
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (!isAzure) return { url: `${trimmed}/chat/completions`, isAzure };

  const [rawPath, query] = trimmed.split("?");
  const base = rawPath.replace(/\/+$/, "");
  const path = /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`;
  const root = base.replace(/\/chat\/completions$/i, "");
  const fallback = /\/openai\/v1$/i.test(root)
    ? "api-version=preview"
    : /\/models$/i.test(root)
      ? "api-version=2024-05-01-preview"
      : "api-version=2024-10-21";
  const version = query && query.includes("api-version=") ? query : fallback;
  return { url: `${path}?${version}`, isAzure };
}

/**
 * Run the agentic loop: send the conversation, execute any tool calls the model
 * makes, feed the results back, and repeat until it produces a final answer (or
 * hits `maxSteps`). Returns the full updated conversation for the next turn.
 */
const REQUEST_TIMEOUT_MS = 60_000;

export async function runAgent(
  config: ProviderConfig,
  messages: ChatMessage[],
  tools: ToolDef[],
  execute: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  onEvent: (e: AgentEvent) => void,
  maxSteps = 6
): Promise<ChatMessage[]> {
  const convo = [...messages];
  const { url, isAzure } = resolveChatEndpoint(config.baseUrl);

  const httpFetch = await pickFetch();

  for (let step = 0; step < maxSteps; step++) {
    let res: Response;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      res = await httpFetch(url, {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "Content-Type": "application/json",
          ...(config.apiKey
            ? isAzure
              ? { "api-key": config.apiKey }
              : { Authorization: `Bearer ${config.apiKey}` }
            : {}),
        },
        body: JSON.stringify({ model: config.model, messages: convo, tools, tool_choice: "auto" }),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const timedOut = /abort|timeout/i.test(msg);
      onEvent({ type: "error", text: timedOut ? `request timed out after ${REQUEST_TIMEOUT_MS / 1000}s` : `network error: ${msg}` });
      return convo;
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      onEvent({ type: "error", text: `${res.status} ${res.statusText} — ${body.slice(0, 300)}` });
      return convo;
    }

    const data = await res.json().catch(() => null);
    const msg: ChatMessage | undefined = data?.choices?.[0]?.message;
    if (!msg) {
      onEvent({ type: "error", text: "malformed response (no message)" });
      return convo;
    }
    // Meter the request. Prefer the provider's reported total; otherwise estimate
    // (prompt = the convo we sent this step + the completion we got back) so the
    // meter still counts the request and an approximate cost instead of zero.
    const used = (data as { usage?: { total_tokens?: number } } | null)?.usage?.total_tokens;
    if (typeof used === "number") recordTokens(used, false);
    else recordTokens(estimateTokens(convo) + estimateTokens([msg]), true);
    convo.push(msg);

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      for (const tc of msg.tool_calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments || "{}");
        } catch {
          args = {};
        }
        onEvent({ type: "tool_call", name: tc.function.name, args });
        let result: unknown;
        try {
          result = await execute(tc.function.name, args);
        } catch (e) {
          result = { error: e instanceof Error ? e.message : String(e) };
        }
        onEvent({ type: "tool_result", name: tc.function.name, result });
        convo.push({
          role: "tool",
          tool_call_id: tc.id,
          name: tc.function.name,
          content: JSON.stringify(result),
        });
      }
      continue; // let the model read the tool results
    }

    if (msg.content) onEvent({ type: "assistant", text: msg.content });
    return convo; // final answer, done
  }

  onEvent({ type: "error", text: `stopped after ${maxSteps} tool-steps without a final answer` });
  return convo;
}
