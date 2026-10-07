/**
 * Trade-log analyzer smoke.
 * Run with: pnpm --filter @stratforge/engine exec tsx scripts/tradelog-smoke.ts
 */
import { analyzeTradeLogInMarketContext, parseTradeLogCsv } from "../src/index.js";
import type { Candle } from "../src/index.js";

const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error("FAIL:", msg);
    throw new Error(msg);
  }
};

function candles(n: number): Candle[] {
  const out: Candle[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const drift = i < n / 2 ? 0.001 : -0.0005;
    const wave = Math.sin(i / 5) * 0.004;
    const close = price * (1 + drift + wave);
    out.push({
      time: 1700000000 + i * 3600,
      open: price,
      high: Math.max(price, close) * 1.003,
      low: Math.min(price, close) * 0.997,
      close,
      volume: 1000 + Math.sin(i / 3) * 100,
    });
    price = close;
  }
  return out;
}

const cs = candles(240);
const csv = [
  "entry_time,exit_time,side,entry_price,exit_price,quantity,pnl,symbol,tag",
  `${cs[40].time},${cs[45].time},long,${cs[40].close},${cs[45].close},1,120,ES,breakout`,
  `${cs[55].time},${cs[62].time},long,${cs[55].close},${cs[62].close},1,90,ES,breakout`,
  `${cs[150].time},${cs[156].time},short,${cs[150].close},${cs[156].close},1,-80,ES,reversal`,
  `${cs[170].time},${cs[175].time},long,${cs[170].close},${cs[175].close},1,-60,ES,reversal`,
].join("\n");

const parsed = parseTradeLogCsv(csv);
assert(parsed.issues.length === 0, `expected no parse issues, got ${parsed.issues.length}`);
assert(parsed.trades.length === 4, "should parse 4 trades");

const analysis = analyzeTradeLogInMarketContext(cs, parsed.trades, {
  metadata: { symbol: "ES", assetClass: "future", exchange: "CME", tickSize: 0.25, pointValue: 50 },
});

assert(analysis.summary.trades === 4, "summary should include 4 trades");
assert(analysis.summary.totalPnl === 70, `total pnl should be 70, got ${analysis.summary.totalPnl}`);
assert(analysis.rows.every((r) => r.entryBar >= 0 && r.regime), "each trade should align to a classified regime");
assert(analysis.bySession.length > 0, "session attribution should exist");
assert(analysis.byTag.length === 2, "tag attribution should split breakout/reversal");
assert(analysis.engineTrades.length === 4, "should expose engine-compatible trades for MC reuse");

console.log("=== Trade-log analyzer smoke ===");
console.log("Summary:", analysis.summary);
console.log("By regime:", analysis.byRegime.map((r) => `${r.key}:${r.totalPnl}`).join(" | "));
console.log("By session:", analysis.bySession.map((r) => `${r.key}:${r.totalPnl}`).join(" | "));
console.log("\nAll trade-log smoke checks passed.");
