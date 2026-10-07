# 08 — Cloud Backend Build Plan (#5)

The remaining roadmap item. Unlike #1–#4 (front-end), this is a real backend: accounts, a database, end-to-end-encrypted sync, resellable storage, and billing. This doc is the implementable spec so it can be built without re-deciding architecture. Builds on [03-secure-keys-cloud.md](03-secure-keys-cloud.md).

## Stack

**Supabase** (Postgres + Auth + Row-Level Security + Storage + Edge Functions) — TypeScript-native, matches the project's stack, and gives auth + DB + RLS + object storage in one. **Stripe** for billing. **Cloudflare R2** (or Backblaze B2 + Cloudflare) for the resold bulk storage. Everything client-callable stays in TS; secrets stay server-side in Edge Functions.

## What is and isn't end-to-end encrypted

- **E2E-encrypted (server can't read):** API keys (the vault), and optionally private strategies/datasets. Encrypted on-device with the user's passphrase-derived key (Argon2id → AES-GCM, already implemented in `agent/vault.ts`); only ciphertext is uploaded.
- **Plaintext (server-readable, RLS-protected):** workspace layout, UI settings, public strategy metadata, referral links, usage counters. No secrets here, so plaintext is fine and enables server-side features.

## Schema (Postgres, all with `user_id` + RLS "owner only")

```sql
profiles        (id=auth.uid, email, plan, storage_quota_mb, created_at)
vaults          (user_id, ciphertext bytea, kdf_salt, updated_at)        -- E2E key vault, one per user
strategies      (id, user_id, name, spec jsonb, is_encrypted, updated_at) -- the DSL JSON
layouts         (user_id, dockview jsonb, updated_at)                     -- workspace arrangement
referral_links  (id, user_id, name, url, note, updated_at)               -- affiliate links
datasets        (id, user_id, exchange, symbol, interval, storage_key, bars, updated_at) -- pointer, not bars
storage_usage   (user_id, used_bytes, updated_at)
subscriptions   (user_id, stripe_customer, stripe_sub, plan, status, current_period_end)
```

RLS on every table: `using (auth.uid() = user_id)`. The `vaults.ciphertext` is opaque even to us — that is the zero-knowledge guarantee.

## Sync protocol

Offline-first, last-write-wins by `updated_at`. On login: pull all rows for the user; merge into local state (newer `updated_at` wins). On change: debounced upsert (same pattern as the layout localStorage save we just shipped — swap the target from localStorage to Supabase). Conflicts are rare for a single-user-multi-device tool; LWW is sufficient. The key vault syncs as one ciphertext blob; the client decrypts it locally with the passphrase (never sent).

## Storage resale (the income line)

- Provision one R2 bucket; namespace per user: `s3://bucket/{user_id}/…`. Encrypt each object client-side with the user's vault key before upload (so even stored data is zero-knowledge).
- Uploads/downloads go through **signed URLs minted by an Edge Function** that first checks the user's quota (`storage_usage` vs `profiles.storage_quota_mb`); update `used_bytes` on completion.
- Plans (already shown in the Cloud panel): Free 50 MB, Pro 25 GB ($4/mo), Quant 250 GB ($12/mo). Margin = plan price − wholesale (~$0.015/GB R2). Stripe webhook → update `subscriptions` + `profiles.storage_quota_mb`.

## API surface (Supabase)

Mostly direct table access via the JS client under RLS. Edge Functions only where a secret or check is needed:
- `POST /functions/storage-sign` — quota check → signed R2 upload/download URL.
- `POST /functions/stripe-webhook` — billing events → plan/quota updates.
- `POST /functions/account-delete` — cascade wipe (GDPR; EU user).
Auth, vault, strategies, layouts, referrals, datasets: direct client calls under RLS.

## How it wires into the app (already-built hooks)

- **CloudPanel** "Sign in" → Supabase auth; show real plan + `used/quota` from `profiles`/`storage_usage`.
- **vault.ts** → after local encrypt, upsert the blob to `vaults`; on a new device, pull + decrypt with the passphrase. (Local-only today.)
- **Layout** → the localStorage save we just added becomes a `layouts` upsert when signed in.
- **StrategyPanel / ReferralPanel** → persist to `strategies` / `referral_links` instead of in-memory.

## Phased build

1. **Phase A — Accounts + plaintext sync.** Supabase auth; sync strategies, layout, referral links. Immediate "log in anywhere, your workspace follows" value. ~Low risk.
2. **Phase B — E2E key vault sync.** Upsert/pull the encrypted vault; recovery-code flow (zero-knowledge means a lost passphrase = unrecoverable — make that explicit in the UI).
3. **Phase C — Storage resale + billing.** R2 + signed URLs + quotas + Stripe plans + the Cloud panel wired to live numbers.

## Honest risks / decisions to make first

- **Recovery UX for zero-knowledge.** If the passphrase is lost, the vault is gone — by design. Need a one-time recovery code generated at signup (and say so loudly).
- **Browser CORS for direct exchange/LLM calls stays client-side** (unchanged) — the backend is for sync/storage/billing, not proxying those.
- **Compliance:** EU user → GDPR. Account-delete cascade + data-export endpoint from day one. Don't log secrets, ever.
- **Cost control:** rate-limit signed-URL minting; cap free-tier abuse.

This is ready to implement Phase A first. The front end already has the seams (vault, layout persistence, CloudPanel, store) to plug each piece in.
