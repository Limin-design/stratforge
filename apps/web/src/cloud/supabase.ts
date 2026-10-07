/**
 * Cloud Phase A — dependency-free Supabase client (auth + sync over REST).
 *
 * Talks to Supabase's GoTrue (/auth/v1) and PostgREST (/rest/v1) with plain
 * fetch + the anon key, so it adds NO npm dependency and can't break the build.
 * It only activates when you set these in apps/web/.env:
 *   VITE_SUPABASE_URL=https://YOUR-PROJECT.supabase.co
 *   VITE_SUPABASE_ANON_KEY=eyJ...
 * Schema + RLS to create are in docs/research/08-cloud-backend-plan.md.
 */
const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};
const URL = env.VITE_SUPABASE_URL;
const ANON = env.VITE_SUPABASE_ANON_KEY;
const SKEY = "stratforge.session";

export function isConfigured(): boolean {
  return Boolean(URL && ANON);
}

export interface Session {
  access_token: string;
  user: { id: string; email?: string };
}

function saveSession(s: Session | null): void {
  try {
    if (s) localStorage.setItem(SKEY, JSON.stringify(s));
    else localStorage.removeItem(SKEY);
  } catch {
    /* ignore */
  }
}
export function getSession(): Session | null {
  try {
    const r = localStorage.getItem(SKEY);
    return r ? (JSON.parse(r) as Session) : null;
  } catch {
    return null;
  }
}

async function auth(path: string, body: unknown): Promise<Record<string, unknown>> {
  if (!isConfigured()) throw new Error("cloud not configured — set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY");
  const r = await fetch(`${URL}/auth/v1/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ANON! },
    body: JSON.stringify(body),
  });
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) throw new Error(String(j.error_description || j.msg || j.message || `auth ${r.status}`));
  return j;
}

/** Sign up. May return without a session if email confirmation is required. */
export async function signUp(email: string, password: string): Promise<Session | null> {
  const j = await auth("signup", { email, password });
  if (j.access_token) {
    const s: Session = { access_token: String(j.access_token), user: j.user as Session["user"] };
    saveSession(s);
    return s;
  }
  return null;
}

export async function signIn(email: string, password: string): Promise<Session> {
  const j = await auth("token?grant_type=password", { email, password });
  const s: Session = { access_token: String(j.access_token), user: j.user as Session["user"] };
  saveSession(s);
  return s;
}

export function signOut(): void {
  saveSession(null);
}

// ---------- PostgREST (RLS-protected rows) ----------
async function rest(pathWithQuery: string, init: RequestInit): Promise<Response> {
  if (!isConfigured()) throw new Error("cloud not configured");
  const s = getSession();
  const r = await fetch(`${URL}/rest/v1/${pathWithQuery}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      apikey: ANON!,
      Authorization: `Bearer ${s?.access_token ?? ANON}`,
      ...(init.headers ?? {}),
    },
  });
  if (!r.ok) throw new Error(`db ${r.status}: ${(await r.text().catch(() => "")).slice(0, 160)}`);
  return r;
}

export async function upsertRow(table: string, row: Record<string, unknown>): Promise<void> {
  await rest(table, { method: "POST", headers: { Prefer: "resolution=merge-duplicates" }, body: JSON.stringify(row) });
}
export async function getRows<T = unknown>(table: string, query = ""): Promise<T[]> {
  const r = await rest(`${table}?${query}`, { method: "GET" });
  return (await r.json()) as T[];
}

// ---------- convenience: layout + zero-knowledge vault sync ----------
export async function pushLayout(dockview: unknown): Promise<void> {
  const s = getSession();
  if (!s) throw new Error("not signed in");
  await upsertRow("layouts", { user_id: s.user.id, dockview, updated_at: new Date().toISOString() });
}
export async function pullLayout(): Promise<unknown | null> {
  const s = getSession();
  if (!s) return null;
  const rows = await getRows<{ dockview: unknown }>("layouts", `user_id=eq.${s.user.id}&select=dockview`);
  return rows[0]?.dockview ?? null;
}
/** The vault ciphertext is opaque to the server (encrypted on-device in vault.ts). */
export async function pushVault(ciphertext: string): Promise<void> {
  const s = getSession();
  if (!s) throw new Error("not signed in");
  await upsertRow("vaults", { user_id: s.user.id, ciphertext, updated_at: new Date().toISOString() });
}
export async function pullVault(): Promise<string | null> {
  const s = getSession();
  if (!s) return null;
  const rows = await getRows<{ ciphertext: string }>("vaults", `user_id=eq.${s.user.id}&select=ciphertext`);
  return rows[0]?.ciphertext ?? null;
}
