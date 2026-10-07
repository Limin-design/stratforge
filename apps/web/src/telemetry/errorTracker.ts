/**
 * On-device error tracking with mandatory secret/PII scrubbing.
 *
 * Privacy-first by design: nothing leaves the device by default. Errors are
 * scrubbed (see `scrub.ts`), kept in a small bounded ring buffer (memory +
 * localStorage) for an in-app diagnostics readout, and only forwarded if the app
 * explicitly installs a sink via `setErrorSink`. When the cloud backend lands,
 * the sink can point at a Supabase Edge Function — and because every event is
 * already scrubbed before the sink sees it, the "never log secrets" rule holds
 * regardless of where it forwards.
 *
 * No third-party SDK: a tracker that phones home by default would contradict the
 * zero-knowledge posture, and stays dependency-free per project rules.
 */
import { scrubError, scrubValue } from "./scrub.js";

export type ErrorKind = "error" | "unhandledrejection" | "panel" | "manual";

export interface TrackedError {
  id: string;
  ts: number;
  kind: ErrorKind;
  name: string;
  message: string;
  stack?: string;
  context?: Record<string, unknown>;
}

export type ErrorSink = (e: TrackedError) => void | Promise<void>;

const STORAGE_KEY = "stratforge.diag.v1";
const MAX_EVENTS = 50;

let buffer: TrackedError[] = loadBuffer();
let sink: ErrorSink | null = null;
let installed = false;
const listeners = new Set<() => void>();

function loadBuffer(): TrackedError[] {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    const parsed = raw ? (JSON.parse(raw) as TrackedError[]) : [];
    return Array.isArray(parsed) ? parsed.slice(-MAX_EVENTS) : [];
  } catch {
    return [];
  }
}

function persist(): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, JSON.stringify(buffer));
  } catch {
    /* diagnostics must never break the app — ignore quota/availability errors */
  }
}

function emit(): void {
  for (const l of listeners) l();
}

export function subscribeErrors(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function getRecentErrors(): TrackedError[] {
  return [...buffer].reverse(); // newest first
}

export function clearErrors(): void {
  buffer = [];
  persist();
  emit();
}

/** Install a forwarding sink (e.g. to an Edge Function). Events are already scrubbed. */
export function setErrorSink(next: ErrorSink | null): void {
  sink = next;
}

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/**
 * Record an error. The thrown value and any context are scrubbed before they are
 * stored, shown, or forwarded. Never throws (telemetry must not crash the app).
 */
export function captureError(
  err: unknown,
  opts: { kind?: ErrorKind; context?: Record<string, unknown> } = {}
): void {
  try {
    const scrubbed = scrubError(err);
    const event: TrackedError = {
      id: uid(),
      ts: Date.now(),
      kind: opts.kind ?? "manual",
      name: scrubbed.name,
      message: scrubbed.message,
      stack: scrubbed.stack,
      context: opts.context ? (scrubValue(opts.context) as Record<string, unknown>) : undefined,
    };
    buffer.push(event);
    if (buffer.length > MAX_EVENTS) buffer = buffer.slice(-MAX_EVENTS);
    persist();
    emit();
    if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
      console.error(`[diag:${event.kind}]`, event.name, event.message);
    }
    if (sink) void Promise.resolve(sink(event)).catch(() => undefined);
  } catch {
    /* swallow — diagnostics can never be the cause of a failure */
  }
}

export function captureMessage(message: string, context?: Record<string, unknown>): void {
  captureError(new Error(message), { kind: "manual", context });
}

/** Install global handlers for uncaught errors and unhandled promise rejections. Idempotent. */
export function initErrorTracking(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("error", (e: ErrorEvent) => {
    captureError(e.error ?? e.message, { kind: "error", context: { source: e.filename, line: e.lineno, col: e.colno } });
  });
  window.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
    captureError(e.reason, { kind: "unhandledrejection" });
  });
}
