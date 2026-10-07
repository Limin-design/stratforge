# 03 — Secure Key Vault, Login Sync, and Cloud Storage

Decoding your three requirements into a concrete architecture:

- *"Stored in the app in a secure folder, never seen by anyone — not even in verification"* → **zero-knowledge, end-to-end encryption.** The key is encrypted on the device; only ciphertext is ever stored or transmitted; nobody server-side (including us) can decrypt it.
- *"Keyless entry system to store the API keys"* → the user doesn't re-type a master password each time; the vault is unlocked by the **OS keychain / biometrics / passkey**.
- *"Hold keys in the cloud so the user logs in and works from any device"* → **E2E-encrypted cloud sync** tied to an account, password-manager style.
- *"Plug in cloud storage I can sell to my users"* → resell object storage with markup, same E2E approach for stored project data.

Build it in that order — each layer stands alone and ships independently.

---

## 1. Local secure storage (ship first)

**Use the OS keychain, not Tauri Stronghold.** Stronghold (IOTA, argon2-based) is the commonly-cited Tauri secrets engine, but it is **being deprecated and removed in Tauri v3** — do not build on it. Instead use the OS-native credential store via a keyring plugin (`tauri-plugin-keyring` / the `keyring` Rust crate): **Windows Credential Manager**, **macOS Keychain**, **Linux Secret Service**. These are OS-encrypted, unlocked by the user's existing login session — which *is* the "keyless" experience (no app-specific master password to type).

**Pattern for many keys + true at-rest encryption:**

1. Generate a random **vault key** on first run.
2. Encrypt the API-key vault (a small JSON blob) with the vault key using authenticated encryption (**AES-256-GCM** or **XChaCha20-Poly1305**).
3. Store only the **vault key** in the OS keychain; store the encrypted vault blob in the app data dir.

Result: keys are encrypted on disk, and the unlock secret lives in the OS-protected keychain — no password prompt every launch. For higher assurance, gate release of the vault key behind **biometrics / passkey (WebAuthn)** so a stolen unlocked laptop still can't dump keys. (Cross-platform biometric+keyring patterns for Tauri v2 are documented and in use.)

**Never** put keys in `localStorage`, plain files, or app logs, and never print them in any diagnostic/verification path — that's the explicit requirement.

---

## 2. Zero-knowledge cloud sync (ship second)

This is the 1Password/Bitwarden model. The principle: **all encryption and decryption happen on the device; the server only ever sees ciphertext and cannot read it.** That is what makes "never seen by anyone, even in verification" literally true rather than a promise.

**Key derivation and vault:**

1. Account = email + a **master passphrase** (or a device passkey).
2. Derive a **master encryption key** on the client with a slow KDF (**Argon2id**). The passphrase never leaves the device.
3. **Envelope encryption:** each stored secret gets a random **data key**; data keys are wrapped by the master key. Lets you rotate or share individual items without re-encrypting everything, and supports adding a new device cleanly.
4. Encrypt the vault client-side; upload **only ciphertext**. To sync a new device, the user signs in, the ciphertext downloads, and it decrypts locally with the key derived from their passphrase/passkey.

**Separate authentication from encryption.** Don't send the master passphrase to the server as the login secret. Derive an independent **auth verifier** (e.g., a separate hash, or SRP) for proving identity, and keep the **encryption key** strictly client-side. If the two are tangled, a server breach can expose vaults.

**Recovery is the hard part — design it deliberately.** Zero-knowledge means *you cannot reset a forgotten passphrase*. Offer a one-time **recovery code** (generated client-side at signup) or a secondary passkey. Make the irreversibility explicit in the UI.

This same envelope scheme is what you'll reuse to encrypt users' **project/strategy data** in the resold storage below.

---

## 3. Resellable cloud storage (the income layer, ship third)

You want storage you can sell to users for margin. The economics in 2026:

- **Cloudflare R2** — ~$0.015/GB-month, and **near-zero egress fees**. Egress is where S3 bills murder you, so R2's free-ish egress is the structural advantage for a consumer app where users pull their data back often.
- **Backblaze B2** — ~$6/TB-month ($0.006/GB) hot storage, the cheapest at-rest. **B2 + Cloudflare** is the classic combo: egress from B2 through the Cloudflare **Bandwidth Alliance** is free, giving the lowest all-in cost for most workloads. B2 also has an authorized-**reseller** program (B2 Reserve, capacity bought upfront) if you want a formal wholesale relationship.
- **Storj** — decentralized, S3-compatible, also low egress; an option if you want geo-distribution.

**Reseller model (practical path):** public turnkey "white-label" programs are thin, so the standard approach is **buy wholesale, resell with markup**:

1. Provision one R2 (or B2+Cloudflare) bucket under *your* account.
2. **Multi-tenant** it: per-user key prefixes (`/{userId}/…`), per-user quotas, and usage metering.
3. Bill users a simple plan (e.g., "50 GB included, $X/mo for more") at a markup over your ~$0.006–0.015/GB wholesale cost. The margin is your income.
4. Encrypt each user's stored data with **their** envelope key from §2, so even in the storage layer their content is unreadable to you — consistent with the zero-knowledge promise and a genuine selling point.

This dovetails with the affiliate/revenue model already noted for the project: storage becomes a recurring-revenue line, not just a cost.

**Caveat:** reselling infrastructure makes you responsible for uptime, quotas, abuse handling, and billing. Start with a single included-storage tier and one paid upgrade; don't build a billing platform before there are users.

---

## Build order recap

1. **Local OS-keychain vault** (AES-GCM blob + keychain-held vault key, optional biometric/passkey gate). Ships value immediately, no backend.
2. **E2E-encrypted cloud sync** (Argon2id-derived master key, envelope encryption, client-only decryption, deliberate recovery flow).
3. **Resold object storage** (R2 or B2+Cloudflare, multi-tenant, per-user envelope encryption, simple paid tier).

---

## Sources

- Tauri secure storage; Stronghold deprecation; keyring/biometric — https://v2.tauri.app/plugin/stronghold/ ; https://github.com/HuakunShen/tauri-plugin-keyring ; https://github.com/tauri-apps/tauri/discussions/7846 ; https://decentpaste.com/blog/cross-platform-biometric-keyring-storage-tauri/
- Zero-knowledge / E2E architecture — https://bitwarden.com/blog/end-to-end-encryption-and-zero-knowledge/ ; https://bitwarden.com/resources/zero-knowledge-encryption-white-paper/
- Cloud storage pricing & egress (2026) — https://www.backblaze.com/cloud-storage/pricing ; https://leanopstech.com/blog/cloudflare-r2-pricing-2026/ ; https://leanopstech.com/blog/backblaze-b2-pricing-2026/ ; https://www.backblaze.com/cloud-storage/b2-reserve
