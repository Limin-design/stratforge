/**
 * Vault crypto smoke test — proves the zero-knowledge guarantee holds.
 *
 * The vault is the product's crown jewel (keys "never seen by anyone"). Its crypto
 * path must be the MOST-tested code, not the least. This exercises the pure
 * encrypt/decrypt functions (no localStorage/DOM needed) under Node's Web Crypto:
 *   - round-trip: encryptJson → decryptJson returns the exact value
 *   - wrong passphrase is rejected (AES-GCM auth tag fails)
 *   - tampered ciphertext is rejected
 *   - blobs are non-deterministic (fresh salt+iv per encrypt) and never contain the plaintext
 *
 * Run: node --experimental-strip-types scripts/vault-smoke.ts
 */
import { encryptJson, decryptJson } from "../src/agent/vault.ts";
const fake = (prefix: string, length: number): string => prefix + "x".repeat(length - prefix.length); // test-only placeholder, not a real key

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

async function expectThrows(fn: () => Promise<unknown>, msg: string): Promise<void> {
  let threw = false;
  try {
    await fn();
  } catch {
    threw = true;
  }
  assert(threw, msg);
}

async function main(): Promise<void> {
  const secret = { apiKey: fake("sk-live-", 24), provider: "openai", nested: { n: 42 } };
  const pass = "correct horse battery staple";

  // 1. round-trip
  const blob = await encryptJson(secret, pass);
  const back = await decryptJson<typeof secret>(blob, pass);
  assert(JSON.stringify(back) === JSON.stringify(secret), "round-trip must return the exact value");

  // 2. wrong passphrase rejected
  await expectThrows(() => decryptJson(blob, "wrong passphrase"), "wrong passphrase must be rejected");

  // 3. tampered ciphertext rejected (flip a byte near the end of the base64 blob)
  const tampered = blob.slice(0, -4) + (blob.slice(-4) === "AAAA" ? "BBBB" : "AAAA");
  await expectThrows(() => decryptJson(tampered, pass), "tampered ciphertext must be rejected");

  // 4. non-deterministic: two encrypts of the same value differ (fresh salt+iv)
  const blob2 = await encryptJson(secret, pass);
  assert(blob !== blob2, "two encryptions of the same value must differ (random salt+iv)");
  // ...and both still decrypt
  assert(
    JSON.stringify(await decryptJson(blob2, pass)) === JSON.stringify(secret),
    "second blob must also round-trip"
  );

  // 5. the plaintext key must never appear in the stored blob
  assert(!blob.includes(secret.apiKey), "ciphertext blob must not contain the plaintext key");
  // and decoded bytes must not contain it either
  const decoded = Buffer.from(blob, "base64").toString("latin1");
  assert(!decoded.includes(secret.apiKey), "decoded blob bytes must not contain the plaintext key");

  console.log("vault-smoke: OK (round-trip, wrong-pass reject, tamper reject, non-deterministic, no-plaintext-leak)");
}

main().catch((e) => {
  console.error("vault-smoke FAILED:", e);
  process.exit(1);
});
