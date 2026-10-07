/**
 * Secret/PII redaction for error telemetry — the security-critical core of the
 * error tracker. StratForge's #1 rule is "never log secrets"; the zero-knowledge
 * vault means an API key or passphrase reaching a log/report is a brand-level
 * failure. So EVERY error is run through this scrubber before it is stored,
 * shown, or forwarded to any sink. Pure and DOM-free → unit-tested like the vault.
 *
 * It is defence-in-depth, not a licence to log secrets: the real guarantee is
 * that secrets are never passed to telemetry in the first place. This catches the
 * accidental leak (a key inside an error message, a token in a request URL, a
 * ciphertext blob in a stack) and a username inside a file path.
 */

const REDACTED = "[REDACTED]";
const SENSITIVE_KEY = /^(api[_-]?key|apikey|authorization|auth|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|client[_-]?secret|password|passphrase|pass|pwd|ciphertext|blob|vault|kdf[_-]?salt|salt|iv|private[_-]?key|cookie|set-cookie)$/i;

/** Redact secrets and PII inside an arbitrary string (error message, stack, URL). */
export function redactString(input: string): string {
  if (!input) return input;
  let s = input;

  // JSON web tokens (header.payload.signature).
  s = s.replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}\b/g, REDACTED);
  // Provider API keys: OpenAI/Anthropic sk-…, sk-ant-…, sk-proj-…, rk-…, pk-…
  s = s.replace(/\b(?:sk|rk|pk)-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}\b/g, REDACTED);
  // Google API keys.
  s = s.replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, REDACTED);
  // AWS access key ids.
  s = s.replace(/\bAKIA[0-9A-Z]{16}\b/g, REDACTED);
  // Bearer / api-key auth headers.
  s = s.replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, `Bearer ${REDACTED}`);
  // key=value / "key": "value" for sensitive parameter names (query strings, headers, JSON).
  s = s.replace(
    /\b(api[_-]?key|apikey|authorization|access[_-]?token|refresh[_-]?token|token|secret|password|passphrase|pwd|sig|signature)\b(\s*["']?\s*[:=]\s*["']?)([^"'&\s,;}]+)/gi,
    (_m, name, sep) => `${name}${sep}${REDACTED}`
  );
  // Long opaque blobs — vault ciphertext (base64) and hex digests/secrets.
  s = s.replace(/\b[A-Za-z0-9+/]{80,}={0,2}\b/g, REDACTED);
  s = s.replace(/\b[0-9a-f]{48,}\b/gi, REDACTED);
  // Emails (PII).
  s = s.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[EMAIL]");
  // Collapse file paths to the bare filename — strips the OS username
  // (C:\Users\<name>\…) and internal/scratch paths (rule #4). Keeps the basename
  // so a stack is still useful.
  s = s.replace(
    /(?:[A-Za-z]:)?(?:file:\/\/\/?)?(?:[\\/][\w .~%@()+-]+){1,}[\\/]([\w.-]+\.(?:tsx?|jsx?|mjs|cjs|html|css))/gi,
    (_m, file) => file
  );

  return s;
}

/**
 * Recursively scrub an arbitrary value for safe inclusion as error context.
 * Drops values under sensitive key names outright, redacts strings, and bounds
 * depth/breadth/length so a huge or cyclic object can't bloat a report.
 */
export function scrubValue(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === "string") return redactString(value.length > 2000 ? value.slice(0, 2000) + "…" : value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 4) return "[depth-limit]";
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrubValue(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (n++ >= 50) {
        out["…"] = "[truncated]";
        break;
      }
      out[k] = SENSITIVE_KEY.test(k) ? REDACTED : scrubValue(v, depth + 1);
    }
    return out;
  }
  return "[unserializable]";
}

export interface ScrubbedError {
  name: string;
  message: string;
  stack?: string;
}

/** Normalize + scrub any thrown thing into a safe, structured error. */
export function scrubError(err: unknown): ScrubbedError {
  if (err instanceof Error) {
    return {
      name: redactString(err.name || "Error"),
      message: redactString(err.message || ""),
      stack: err.stack ? redactString(err.stack).split("\n").slice(0, 20).join("\n") : undefined,
    };
  }
  if (typeof err === "string") return { name: "Error", message: redactString(err) };
  try {
    return { name: "Error", message: redactString(JSON.stringify(scrubValue(err))) };
  } catch {
    return { name: "Error", message: "[unserializable error]" };
  }
}
