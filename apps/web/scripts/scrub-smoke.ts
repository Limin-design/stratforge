/**
 * Telemetry redaction smoke — the most important test in the error tracker.
 * Proves that secrets and PII never survive scrubbing, end to end through
 * captureError. Run: node --experimental-strip-types scripts/scrub-smoke.ts
 */
import { redactString, scrubValue, scrubError } from "../src/telemetry/scrub.ts";
import { captureError, getRecentErrors, clearErrors } from "../src/telemetry/errorTracker.ts";
const fake = (prefix: string, length: number, fill = "x"): string => (prefix + fill.repeat(length)).slice(0, length); // test-only placeholder, not a real key

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

// Secrets that must NEVER appear in scrubbed output.
const secrets: Array<{ label: string; raw: string; secret: string }> = [
  { label: "openai key", raw: "request failed with key " + fake("sk-proj-", 30), secret: fake("sk-proj-", 30) },
  { label: "anthropic key", raw: "Authorization: Bearer " + fake("sk-ant-" + "api03-", 39), secret: fake("sk-ant-" + "api03-", 39) },
  { label: "google key", raw: "url=https://x/v1?key=" + fake("AIza", 36), secret: fake("AIza", 36) },
  { label: "bearer token", raw: "headers Bearer eyAbderffgh12345.tokpart.sigpart played", secret: "eyAbderffgh12345.tokpart.sigpart" },
  { label: "api-key json", raw: '{"api-key":"super-secret-value-9000","model":"gpt"}', secret: "super-secret-value-9000" },
  { label: "api_key query", raw: "GET /time_series?symbol=BTC&apikey=abc123secretXYZ&interval=1h", secret: "abc123secretXYZ" },
  { label: "jwt", raw: "session eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w", secret: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w" },
];

for (const { label, raw, secret } of secrets) {
  const out = redactString(raw);
  assert(!out.includes(secret), `redactString must remove ${label}: got "${out}"`);
  assert(out.includes("[REDACTED]") || out.includes("[EMAIL]"), `redactString must mark redaction for ${label}`);
}

// Vault-ciphertext-shaped base64 blob must be redacted.
{
  const blob = "QUJD" + "a1B2c3D4".repeat(20); // long base64 run
  assert(!redactString(`vault blob ${blob} failed`).includes(blob), "long base64 (vault ciphertext) must be redacted");
}

// Email PII.
assert(redactString("user someone@example.com hit error") === "user [EMAIL] hit error", "email must be redacted");

// File path collapses to basename (strips OS username / internal paths — rule #4).
{
  const out = redactString("at decrypt (C:\\Users\\pedro\\Projects\\IAQ\\apps\\web\\src\\agent\\vault.ts:71:10)");
  assert(!out.includes("pedro") && !out.includes("Users"), "file path must not leak the OS username");
  assert(out.includes("vault.ts"), "basename should be kept for usefulness");
}

// scrubValue drops sensitive keys and walks nested objects.
{
  const scrubbed = scrubValue({ apiKey: fake("sk-live-", 24), passphrase: "hunter2", nested: { token: "abc", note: "fine" } }) as Record<string, unknown>;
  assert(scrubbed.apiKey === "[REDACTED]" && scrubbed.passphrase === "[REDACTED]", "sensitive top-level keys redacted");
  const nested = scrubbed.nested as Record<string, unknown>;
  assert(nested.token === "[REDACTED]" && nested.note === "fine", "sensitive nested keys redacted, others kept");
}

// scrubError normalizes thrown values and caps the stack.
{
  const e = new Error("failed for " + fake("sk-proj-", 30, "SECRET"));
  const s = scrubError(e);
  assert(!s.message.includes("SECRET"), "scrubError must redact the message");
}

// End-to-end: captureError stores only scrubbed data.
{
  clearErrors();
  captureError(new Error("boom with key " + fake("sk-proj-", 28, "LEAK")), { kind: "manual", context: { apiKey: fake("sk-live-", 23, "DONOTLEAK") } });
  const recent = getRecentErrors();
  assert(recent.length === 1, "captureError must record one event");
  const dump = JSON.stringify(recent[0]);
  assert(!dump.includes("LEAK") && !dump.includes("DONOTLEAK"), "stored event must contain no secret material");
  assert((recent[0].context as Record<string, unknown>).apiKey === "[REDACTED]", "context secrets must be redacted in storage");
  clearErrors();
}

console.log("scrub-smoke: OK (keys, bearer, jwt, query/json secrets, base64 blob, email, paths, nested keys, end-to-end no-leak)");
