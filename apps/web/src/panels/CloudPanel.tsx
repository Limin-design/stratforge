/**
 * Cloud sync & storage panel — Phase A. Uses the dependency-free Supabase client
 * (cloud/supabase.ts). Shows a setup state until VITE_SUPABASE_* are configured,
 * so it never errors. See docs/research/08-cloud-backend-plan.md.
 */
import { useState } from "react";
import { getSession, isConfigured, pushLayout, signIn, signOut, signUp, type Session } from "../cloud/supabase.js";

export function CloudPanel() {
  const configured = isConfigured();
  const [session, setSession] = useState<Session | null>(getSession());
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const doAuth = async (mode: "in" | "up") => {
    setBusy(true);
    setMsg(null);
    try {
      const s = mode === "up" ? await signUp(email, pw) : await signIn(email, pw);
      setSession(s ?? getSession());
      setMsg(getSession() ? "signed in" : "check your email to confirm, then sign in");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const out = () => { signOut(); setSession(null); setMsg("signed out"); };
  const syncLayout = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const l = localStorage.getItem("stratforge.layout");
      if (l) await pushLayout(JSON.parse(l));
      setMsg("workspace layout synced to cloud");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const ghost = { background: "var(--bg-3)", color: "var(--text)", border: "1px solid var(--border)" } as const;

  return (
    <div className="cli-panel" style={{ overflowY: "auto" }}>
      <span className="cli-prompt">cloud sync &amp; storage</span>

      {!configured ? (
        <div className="cli-box">
          <strong>Connect a backend</strong>
          <span className="cli-hint">
            Cloud sync is off until you add a (free) Supabase project. Put this in <b>apps/web/.env</b> and
            restart <code>pnpm dev</code>:
          </span>
          <pre style={{ fontSize: 11, color: "var(--text)", background: "var(--bg-1)", padding: 8, borderRadius: 6, margin: 0, overflowX: "auto" }}>
{`VITE_SUPABASE_URL=https://YOUR-PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...`}
          </pre>
          <span className="cli-hint">Tables + RLS to create are in docs/research/08-cloud-backend-plan.md.</span>
        </div>
      ) : !session ? (
        <div className="cli-box">
          <strong>Account</strong>
          <input className="cli-input" type="email" placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
          <input className="cli-input" type="password" placeholder="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" />
          <div style={{ display: "flex", gap: 6 }}>
            <button className="cli-btn" disabled={busy} onClick={() => doAuth("in")}>Sign in</button>
            <button className="cli-btn" disabled={busy} style={ghost} onClick={() => doAuth("up")}>Create account</button>
          </div>
        </div>
      ) : (
        <div className="cli-box">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <strong>Signed in</strong>
            <button className="cli-btn" style={{ ...ghost, padding: "4px 10px" }} onClick={out}>Sign out</button>
          </div>
          <span className="cli-hint">{session.user.email ?? session.user.id}</span>
          <button className="cli-btn" disabled={busy} onClick={syncLayout}>Sync workspace layout ↑</button>
          <span className="cli-hint">Strategies, encrypted keys, and datasets sync next — see the plan doc.</span>
        </div>
      )}

      {msg && <span className="cli-prompt" style={{ fontSize: 12 }}>{msg}</span>}

      <div className="cli-box">
        <strong>Storage</strong>
        <div className="cli-stats" style={{ borderTop: "none", paddingTop: 0 }}>used <b>0 MB</b> of <b>50 MB</b> · plan <b>Free</b></div>
        <div style={{ height: 8, borderRadius: 5, background: "var(--bg-3)", overflow: "hidden" }}>
          <div style={{ width: "2%", height: "100%", background: "var(--accent)" }} />
        </div>
        <span className="cli-hint">End-to-end encrypted (zero-knowledge). Tiers: Free 50 MB · Pro 25 GB · Quant 250 GB.</span>
      </div>
    </div>
  );
}
