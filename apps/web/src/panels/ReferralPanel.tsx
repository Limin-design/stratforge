/**
 * Referral / data-link manager. The affiliate revenue path: the user shares
 * their referral links to data/exchange providers and earns commission. Edit
 * the URLs to your own codes; search/filter to find one; copy to share.
 */
import { useEffect, useMemo, useState } from "react";

interface RefLink {
  name: string;
  note: string;
  category: string;
  url: string;
}

const CATEGORIES = ["All", "Crypto", "Forex", "Stocks/Data"];

const DEFAULTS: RefLink[] = [
  { name: "Binance", note: "crypto spot/futures", category: "Crypto", url: "https://accounts.binance.com/register?ref=YOUR_CODE" },
  { name: "Bybit", note: "crypto derivatives", category: "Crypto", url: "https://www.bybit.com/invite?ref=YOUR_CODE" },
  { name: "OKX", note: "crypto", category: "Crypto", url: "https://www.okx.com/join/YOUR_CODE" },
  { name: "Coinbase", note: "crypto exchange", category: "Crypto", url: "https://www.coinbase.com/join/YOUR_CODE" },
  { name: "IC Markets", note: "forex / MT5 broker", category: "Forex", url: "https://www.icmarkets.com/?camp=YOUR_CODE" },
  { name: "Pepperstone", note: "forex / MT5 broker", category: "Forex", url: "https://pepperstone.com/?ref=YOUR_CODE" },
  { name: "Polygon.io", note: "stocks/options data", category: "Stocks/Data", url: "https://polygon.io/?ref=YOUR_CODE" },
  { name: "Databento", note: "market data", category: "Stocks/Data", url: "https://databento.com/?ref=YOUR_CODE" },
];

const guessCat = (note = ""): string =>
  /forex|mt5|broker/i.test(note) ? "Forex" : /stock|option|data|equit/i.test(note) ? "Stocks/Data" : "Crypto";

export function ReferralPanel() {
  const [links, setLinks] = useState<RefLink[]>(() => {
    try {
      const s = localStorage.getItem("stratforge.referrals");
      if (s) return (JSON.parse(s) as RefLink[]).map((l) => ({ ...l, category: l.category ?? guessCat(l.note) }));
    } catch {
      /* ignore */
    }
    return DEFAULTS;
  });
  const [copied, setCopied] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [cat, setCat] = useState("All");

  useEffect(() => {
    try { localStorage.setItem("stratforge.referrals", JSON.stringify(links)); } catch { /* ignore */ }
  }, [links]);

  const update = (i: number, url: string) => setLinks((ls) => ls.map((l, j) => (j === i ? { ...l, url } : l)));
  const copy = (i: number) => {
    navigator.clipboard?.writeText(links[i].url);
    setCopied(i);
    setTimeout(() => setCopied((c) => (c === i ? null : c)), 1200);
  };

  // Keep the original index so edit/copy hit the right row after filtering.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return links
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => (cat === "All" || l.category === cat) && (q === "" || l.name.toLowerCase().includes(q) || l.note.toLowerCase().includes(q)));
  }, [links, search, cat]);

  return (
    <div className="cli-panel" style={{ overflowY: "auto" }}>
      <span className="cli-prompt">referral &amp; data links</span>
      <span className="cli-hint">
        Share these to earn commission when people sign up for data/exchange providers. Paste your own codes,
        then copy.
      </span>

      <div style={{ display: "flex", gap: 6 }}>
        <input className="cli-input" style={{ flex: 1 }} placeholder="search providers…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className="cli-select" value={cat} onChange={(e) => setCat(e.target.value)} title="filter by category">
          {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
        </select>
      </div>

      {filtered.map(({ l, i }) => (
        <div className="cli-box" key={l.name + i} style={{ gap: 6 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <strong>{l.name}</strong>
            <span className="cli-hint" style={{ fontSize: 11 }}>{l.note}</span>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <input className="cli-input" style={{ flex: 1 }} value={l.url} onChange={(e) => update(i, e.target.value)} spellCheck={false} />
            <button className="cli-btn" onClick={() => copy(i)}>{copied === i ? "copied ✓" : "copy"}</button>
          </div>
        </div>
      ))}
      {filtered.length === 0 && <span className="cli-hint">no providers match — try a different search or category.</span>}
    </div>
  );
}
