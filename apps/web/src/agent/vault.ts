/**
 * Zero-knowledge local key vault (web build).
 *
 * Encrypts sensitive agent secrets (API key material) with a key derived from the user's passphrase
 * (PBKDF2 → AES-GCM) and persists ONLY the ciphertext. The passphrase never
 * leaves the device and is never stored, so nobody — not us, not a server, not
 * a localStorage dump — can read the API key without it. This is the browser
 * pattern; the Tauri desktop build hardens it with the OS keychain (docs/03).
 */

const PBKDF2_ITERATIONS = 250_000;
const STORAGE_KEY = "stratforge.vault.v1";
const STORAGE_BY_WORKSPACE_KEY = "stratforge.vault.workspaces.v1";
const DEFAULT_SCOPE = "default";
const enc = new TextEncoder();
const dec = new TextDecoder();

type VaultListener = (workspaceId: string, hasEncryptedBlob: boolean) => void;
const vaultListeners = new Set<VaultListener>();
let storageBridgeInstalled = false;
let snapshotByWorkspace: Record<string, string> | null = null;

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/** Encrypt any JSON-serializable value to a self-contained base64 blob (salt+iv+ciphertext). */
export async function encryptJson(value: unknown, passphrase: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(value)))
  );
  const packed = new Uint8Array(salt.length + iv.length + ciphertext.length);
  packed.set(salt, 0);
  packed.set(iv, salt.length);
  packed.set(ciphertext, salt.length + iv.length);
  return bytesToBase64(packed);
}

/** Decrypt a blob produced by `encryptJson`. Throws on a wrong passphrase or tampering. */
export async function decryptJson<T = unknown>(blob: string, passphrase: string): Promise<T> {
  const packed = base64ToBytes(blob);
  const salt = packed.slice(0, 16);
  const iv = packed.slice(16, 28);
  const ciphertext = packed.slice(28);
  const key = await deriveKey(passphrase, salt);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return JSON.parse(dec.decode(plaintext)) as T;
}

// --- persistence (browser localStorage; only ciphertext ever stored) ---

function readVaultsByWorkspace(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_BY_WORKSPACE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const out: Record<string, string> = {};
    for (const [workspaceId, blob] of Object.entries(parsed)) {
      if (typeof blob === "string" && blob) out[workspaceId] = blob;
    }
    return out;
  } catch {
    return {};
  }
}

function writeVaultsByWorkspace(next: Record<string, string>): void {
  try {
    localStorage.setItem(STORAGE_BY_WORKSPACE_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

function emitVault(workspaceId: string, hasEncryptedBlob: boolean): void {
  for (const listener of vaultListeners) listener(workspaceId, hasEncryptedBlob);
}

function emitVaultDiff(prev: Record<string, string>, next: Record<string, string>): void {
  const keys = new Set<string>([...Object.keys(prev), ...Object.keys(next)]);
  for (const workspaceId of keys) {
    const prevBlob = prev[workspaceId] ?? null;
    const nextBlob = next[workspaceId] ?? null;
    if (prevBlob === nextBlob) continue;
    emitVault(workspaceId, !!nextBlob);
  }
}

function installStorageBridge(): void {
  if (storageBridgeInstalled || typeof window === "undefined") return;
  storageBridgeInstalled = true;

  window.addEventListener("storage", (event) => {
    if (event.storageArea !== localStorage) return;
    if (event.key !== STORAGE_BY_WORKSPACE_KEY && event.key !== STORAGE_KEY) return;

    migrateLegacyVault();
    const prev = snapshotByWorkspace ?? {};
    const next = readVaultsByWorkspace();
    snapshotByWorkspace = next;
    emitVaultDiff(prev, next);
  });
}

function migrateLegacyVault(): void {
  try {
    const legacy = localStorage.getItem(STORAGE_KEY);
    if (!legacy) return;
    const map = readVaultsByWorkspace();
    if (!map[DEFAULT_SCOPE]) {
      map[DEFAULT_SCOPE] = legacy;
      writeVaultsByWorkspace(map);
    }
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

function scopeKey(workspaceId?: string): string {
  return workspaceId || DEFAULT_SCOPE;
}

export function hasVault(workspaceId?: string): boolean {
  migrateLegacyVault();
  const map = readVaultsByWorkspace();
  snapshotByWorkspace = map;
  return !!map[scopeKey(workspaceId)];
}

export function saveVaultBlob(blob: string, workspaceId?: string): void {
  migrateLegacyVault();
  const scope = scopeKey(workspaceId);
  const prev = readVaultsByWorkspace();
  const next = { ...prev, [scope]: blob };
  writeVaultsByWorkspace(next);
  snapshotByWorkspace = next;
  emitVaultDiff(prev, next);
}

export function loadVaultBlob(workspaceId?: string): string | null {
  migrateLegacyVault();
  const map = readVaultsByWorkspace();
  snapshotByWorkspace = map;
  return map[scopeKey(workspaceId)] ?? null;
}

export function clearVault(workspaceId?: string): void {
  migrateLegacyVault();
  const scope = scopeKey(workspaceId);
  const prev = readVaultsByWorkspace();
  if (!(scope in prev)) {
    snapshotByWorkspace = prev;
    return;
  }
  const next = { ...prev };
  delete next[scope];
  writeVaultsByWorkspace(next);
  snapshotByWorkspace = next;
  emitVaultDiff(prev, next);
}

export function subscribeVault(listener: VaultListener): () => void {
  installStorageBridge();
  snapshotByWorkspace = snapshotByWorkspace ?? readVaultsByWorkspace();
  vaultListeners.add(listener);
  return () => vaultListeners.delete(listener);
}
