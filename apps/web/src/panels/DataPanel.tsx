import { parseMt5Csv, validateCandles } from "@stratforge/data-import";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { getActiveWorkspaceId, setState, subscribe } from "../store.js";
import { recordDataset } from "../usage.js";
import { parseCsvCandlesAsync } from "../csv.js";
import { resetTrialCounters } from "../agent/tools.js";
import { EXCHANGES, IV, fetchKlines, fetchJsonWithTimeout, type Exchange } from "./dataSources.js";

const QUOTES = ["ALL", "USDT", "USDC", "BTC", "ETH", "FDUSD", "EUR"];

// Symbol universe is fetched once and shared across panel re-mounts.
let symbolCache: string[] | null = null;

export function DataPanel() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [exchange, setExchange] = useState<Exchange>("Binance");
  const [apiKey, setApiKey] = useState("");
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [search, setSearch] = useState("");
  const [quote, setQuote] = useState("USDT");
  const [interval, setIv] = useState("1h");
  const [symbols, setSymbols] = useState<string[]>(symbolCache ?? []);
  const [status, setStatus] = useState("no dataset loaded");
  const activeWorkspaceRef = useRef<string>(getActiveWorkspaceId());
  const statusByWorkspaceRef = useRef<Map<string, string>>(new Map([[activeWorkspaceRef.current, "no dataset loaded"]]));
  const latestLoadSeqByWorkspaceRef = useRef<Map<string, number>>(new Map());
  const loadSeqRef = useRef(0);

  const setWorkspaceStatus = (workspaceId: string, nextStatus: string) => {
    statusByWorkspaceRef.current.set(workspaceId, nextStatus);
    if (workspaceId === activeWorkspaceRef.current) setStatus(nextStatus);
  };

  const beginWorkspaceLoad = (workspaceId: string, initialStatus: string): number => {
    const seq = ++loadSeqRef.current;
    latestLoadSeqByWorkspaceRef.current.set(workspaceId, seq);
    setWorkspaceStatus(workspaceId, initialStatus);
    return seq;
  };

  const isLatestWorkspaceLoad = (workspaceId: string, seq: number): boolean => {
    return latestLoadSeqByWorkspaceRef.current.get(workspaceId) === seq;
  };

  useEffect(() => {
    return subscribe((_, workspaceId) => {
      activeWorkspaceRef.current = workspaceId;
      setStatus(statusByWorkspaceRef.current.get(workspaceId) ?? "no dataset loaded");
    });
  }, []);

  // Fetch the searchable pair universe once (Binance exchangeInfo, no key needed).
  useEffect(() => {
    if (symbolCache || !(exchange === "Binance" || exchange === "Bybit" || exchange === "OKX" || exchange === "Coinbase")) return;
    fetchJsonWithTimeout("https://api.binance.com/api/v3/exchangeInfo", "symbol universe")
      .then((payload) => {
        const d = payload as { symbols?: { symbol: string; status: string }[] };
        symbolCache = (d.symbols ?? [])
          .filter((x) => x.status === "TRADING")
          .map((x) => x.symbol)
          .sort();
        setSymbols(symbolCache);
      })
      .catch(() => setWorkspaceStatus(activeWorkspaceRef.current, "could not load symbol list (offline?) — you can still type a symbol"));
  }, [exchange]);

  const filtered = useMemo(() => {
    const q = search.trim().toUpperCase();
    return symbols
      .filter((s) => (quote === "ALL" || s.endsWith(quote)) && (q === "" || s.includes(q)))
      .slice(0, 80);
  }, [symbols, search, quote]);

  const load = async () => {
    const workspaceId = getActiveWorkspaceId();
    const seq = beginWorkspaceLoad(workspaceId, `fetching ${symbol} ${interval} from ${exchange}…`);
    try {
      const { candles, report } = validateCandles(await fetchKlines(exchange, symbol, interval, apiKey));
      if (!isLatestWorkspaceLoad(workspaceId, seq)) return;
      if (candles.length === 0) {
        setWorkspaceStatus(workspaceId, `no bars returned — does ${symbol} trade on ${exchange}?`);
        return;
      }
      setState({ candles, datasetName: `${symbol} ${interval} · ${exchange}`, result: null, customStats: [], optimization: null }, workspaceId);
      resetTrialCounters(workspaceId);
      recordDataset(report.bars);
      setWorkspaceStatus(
        workspaceId,
        `loaded ${report.bars} bars · ${report.duplicatesRemoved} dupes removed · ${report.gaps.length} gap(s) · ${report.issues.join("; ") || "clean"}`
      );
    } catch (e) {
      if (!isLatestWorkspaceLoad(workspaceId, seq)) return;
      setWorkspaceStatus(workspaceId, `error: ${e instanceof Error ? e.message : e}`);
    }
  };

  const loadMt5 = async (file: File) => {
    const workspaceId = getActiveWorkspaceId();
    const seq = beginWorkspaceLoad(workspaceId, `parsing ${file.name}…`);
    try {
      const { candles, report } = validateCandles(parseMt5Csv(await file.text()));
      if (!isLatestWorkspaceLoad(workspaceId, seq)) return;
      if (candles.length === 0) {
        setWorkspaceStatus(workspaceId, "could not parse any bars — is this an MT5 'Export Bars' file?");
        return;
      }
      setState({ candles, datasetName: `${file.name} · MT5`, result: null, customStats: [], optimization: null }, workspaceId);
      resetTrialCounters(workspaceId);
      recordDataset(report.bars);
      setWorkspaceStatus(
        workspaceId,
        `loaded ${report.bars} bars · ${report.duplicatesRemoved} dupes removed · ${report.gaps.length} gap(s) · ${report.issues.join("; ") || "clean"}`
      );
    } catch (e) {
      if (!isLatestWorkspaceLoad(workspaceId, seq)) return;
      setWorkspaceStatus(workspaceId, `error: ${e instanceof Error ? e.message : e}`);
    }
  };

  const loadCsv = async (file: File) => {
    const workspaceId = getActiveWorkspaceId();
    const seq = beginWorkspaceLoad(workspaceId, `parsing ${file.name}…`);
    try {
      const { candles: parsed, total } = await parseCsvCandlesAsync(await file.text());
      const { candles, report } = validateCandles(parsed);
      if (!isLatestWorkspaceLoad(workspaceId, seq)) return;
      if (candles.length === 0) {
        setWorkspaceStatus(workspaceId, "no OHLCV rows found — need columns for time/date, open, high, low, close (volume optional).");
        return;
      }
      setState({ candles, datasetName: file.name, result: null, customStats: [], optimization: null }, workspaceId);
      resetTrialCounters(workspaceId);
      recordDataset(report.bars);
      const cap = total > parsed.length ? ` · capped to most recent ${parsed.length.toLocaleString()} of ${total.toLocaleString()}` : "";
      setWorkspaceStatus(
        workspaceId,
        `loaded ${report.bars} bars${cap} · ${report.duplicatesRemoved} dupes removed · ${report.gaps.length} gap(s) · ${report.issues.join("; ") || "clean"}`
      );
    } catch (e) {
      if (!isLatestWorkspaceLoad(workspaceId, seq)) return;
      setWorkspaceStatus(workspaceId, `error: ${e instanceof Error ? e.message : e}`);
    }
  };

  const masked = apiKey ? `••••${apiKey.slice(-4)}` : "";
  const isVendor = exchange === "Twelve Data" || exchange === "Polygon";
  const isCrypto = exchange === "Binance" || exchange === "Bybit" || exchange === "OKX" || exchange === "Coinbase";

  const onPanelKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && exchange !== "MT5 file" && exchange !== "CSV file") {
      e.preventDefault();
      void load();
    }
  };

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      onMouseDown={() => rootRef.current?.focus()}
      onKeyDown={onPanelKeyDown}
      className="cli-panel cli-panel-focusable"
      style={{ overflowY: "auto", outline: "none" }}
    >
      {/* Source selector */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {EXCHANGES.map((ex) => (
          <button
            key={ex}
            onClick={() => setExchange(ex)}
            style={{
              padding: "7px 13px",
              borderRadius: 8,
              fontFamily: "var(--font-sans)",
              fontSize: 12,
              cursor: "pointer",
              border: "1px solid " + (ex === exchange ? "var(--accent)" : "var(--border)"),
              background: ex === exchange ? "var(--accent-dim)" : "var(--bg-2)",
              color: ex === exchange ? "var(--white)" : "var(--text-dim)",
            }}
          >
            {ex}
          </button>
        ))}
      </div>

      {exchange !== "MT5 file" && exchange !== "CSV file" && (
        <div className="cli-box">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <strong>Connection</strong>
            <span
              style={{
                fontSize: 11,
                padding: "3px 9px",
                borderRadius: 20,
                background: apiKey ? "var(--accent-dim)" : "var(--bg-3)",
                color: apiKey ? "var(--accent)" : "var(--text-dim)",
                border: "1px solid " + (apiKey ? "var(--accent)" : "var(--border)"),
              }}
            >
              {apiKey ? `🔒 ${masked}` : exchange}
            </span>
          </div>
          <input
            className="cli-input"
            type="password"
            autoComplete="off"
            placeholder="API key"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <span className="cli-hint">
            Paste a key if your source needs one. Masked the moment you type and never shown again.
          </span>
        </div>
      )}

      {exchange !== "MT5 file" && exchange !== "CSV file" ? (
        <div className="cli-box">
          <strong>{isVendor ? "Symbol" : "Find a pair"}</strong>
          {isVendor && (
            <span className="cli-hint">
              Type a symbol — stocks like <b>AAPL</b>, forex like <b>EUR/USD</b>, crypto like <b>BTC/USD</b>.
            </span>
          )}
          {isCrypto && (
            <>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              className="cli-input"
              style={{ flex: 1 }}
              placeholder="search the market… (e.g. ONDO, SOL, BTC)"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select className="cli-select" value={quote} onChange={(e) => setQuote(e.target.value)} title="Quote-asset filter">
              {QUOTES.map((q) => (
                <option key={q}>{q}</option>
              ))}
            </select>
          </div>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 5,
              maxHeight: 150,
              overflowY: "auto",
              padding: 2,
            }}
          >
            {symbols.length === 0 && <span className="cli-hint">loading symbol universe…</span>}
            {filtered.map((s) => (
              <button
                key={s}
                onClick={() => setSymbol(s)}
                style={{
                  padding: "4px 8px",
                  borderRadius: 6,
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  cursor: "pointer",
                  border: "1px solid " + (s === symbol ? "var(--accent)" : "var(--border)"),
                  background: s === symbol ? "var(--accent-dim)" : "var(--bg-1)",
                  color: s === symbol ? "var(--white)" : "var(--text-dim)",
                }}
              >
                {s}
              </button>
            ))}
            {symbols.length > 0 && filtered.length === 0 && <span className="cli-hint">no matches</span>}
          </div>
            </>
          )}
          <div style={{ display: "flex", gap: 6 }}>
            <input className="cli-input" style={{ flex: 1 }} value={symbol} onChange={(e) => setSymbol(e.target.value)} />
            <select className="cli-select" value={interval} onChange={(e) => setIv(e.target.value)}>
              {["1m", "5m", "15m", "1h", "4h", "1d", "1w"].map((i) => (
                <option key={i}>{i}</option>
              ))}
            </select>
            <button className="cli-btn" onClick={load}>
              Load
            </button>
          </div>
          {IV[exchange][interval] == null && (
            <span className="cli-hint">{exchange} doesn't offer the {interval} timeframe — pick another.</span>
          )}
          <span className="cli-shortcuts">shortcut: Ctrl/Cmd+Enter loads the selected dataset</span>
        </div>
      ) : exchange === "MT5 file" ? (
        <div className="cli-box">
          <strong>MetaTrader 5 — forex (any broker, free)</strong>
          <input
            className="cli-input"
            type="file"
            accept=".csv,.txt,.tsv"
            onChange={(e) => e.target.files?.[0] && loadMt5(e.target.files[0])}
          />
          <span className="cli-hint">
            MT5: View → Symbols → Bars tab → pick symbol/timeframe/dates → Request → Export Bars.
          </span>
        </div>
      ) : (
        <div className="cli-box">
          <strong>CSV file — any OHLCV export</strong>
          <input
            className="cli-input"
            type="file"
            accept=".csv,.txt,.tsv"
            onChange={(e) => e.target.files?.[0] && loadCsv(e.target.files[0])}
          />
          <span className="cli-hint">
            Auto-detects the format — Binance dumps, MetaTrader 4/5, NinjaTrader, Dukascopy,
            TradingView, Yahoo and most exports. Comma/semicolon/tab/pipe; split or combined
            date-time; epoch (s/ms) or date strings; decimal point or comma. Big histories cap
            to the most recent 250k bars to stay responsive.
          </span>
        </div>
      )}

      <span className="cli-prompt">{status}</span>
    </div>
  );
}
