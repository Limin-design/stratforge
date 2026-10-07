// Smoke for the pure parts of the data-source layer (the kline fetch itself is
// network and not unit-testable). Covers the agent load_data request validation,
// symbol splitting, and the vendor response parsers (success + error payloads).
import {
  parsePolygon,
  parseTwelveData,
  splitSymbol,
  validateLoadRequest,
} from "../src/panels/dataSources.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// validateLoadRequest: crypto-only, supported timeframe, real symbol; uppercases/trims.
const ok = validateLoadRequest("Binance", " btcusdt ", "1h");
assert(!("error" in ok), "a valid crypto request must pass");
if (!("error" in ok)) assert(ok.symbol === "BTCUSDT" && ok.exchange === "Binance" && ok.interval === "1h", "symbol must be trimmed and uppercased");

assert("error" in validateLoadRequest("Twelve Data", "AAPL", "1h"), "keyed vendors must be rejected for the agent");
assert("error" in validateLoadRequest("CSV file", "X", "1h"), "file imports must be rejected for the agent");
assert("error" in validateLoadRequest("Binance", "", "1h"), "an empty symbol must be rejected");
assert("error" in validateLoadRequest("Binance", "BTCUSDT", "2h"), "an unsupported interval must be rejected");
assert("error" in validateLoadRequest("Coinbase", "BTCUSD", "4h"), "Coinbase 4h is unsupported and must be rejected");
assert(!("error" in validateLoadRequest("Coinbase", "BTCUSD", "1h")), "Coinbase 1h is supported");

// splitSymbol: longest known quote wins; defaults to USDT.
assert(splitSymbol("BTCUSDT").quote === "USDT" && splitSymbol("BTCUSDT").base === "BTC", "BTCUSDT splits into BTC/USDT");
assert(splitSymbol("btc/usdt").quote === "USDT" && splitSymbol("btc/usdt").base === "BTC", "lowercase/slashed symbols normalize before splitting");
assert(splitSymbol("ETHBTC").quote === "BTC" && splitSymbol("ETHBTC").base === "ETH", "ETHBTC splits into ETH/BTC");
assert(splitSymbol("FOO").quote === "USDT" && splitSymbol("FOO").base === "FOO", "an unknown symbol defaults quote to USDT without truncating base");

// parseTwelveData: maps + sorts ascending; surfaces vendor errors and rate limits.
const td = parseTwelveData({
  values: [
    { datetime: "2024-01-02", open: "2", high: "3", low: "1", close: "2.5", volume: "10" },
    { datetime: "2024-01-01", open: "1", high: "2", low: "0.5", close: "1.5" },
  ],
});
assert(td.length === 2 && td[0].time < td[1].time, "Twelve Data rows must be sorted ascending by time");
assert(td[0].volume === 0, "a missing volume must default to 0");
let threw = false;
try { parseTwelveData({ status: "error", message: "API limit reached" }); } catch { threw = true; }
assert(threw, "a Twelve Data error payload must throw");

// parsePolygon: maps ms→s, sorts ascending; empty resultsCount is not an error.
const pg = parsePolygon({ results: [{ t: 1_700_000_000_000, o: 1, h: 2, l: 0.5, c: 1.5, v: 100 }] });
assert(pg.length === 1 && pg[0].time === 1_700_000_000, "Polygon ms timestamps must convert to seconds");
assert(parsePolygon({ resultsCount: 0 }).length === 0, "an empty Polygon result is valid (no rows), not an error");
let pgThrew = false;
try { parsePolygon({ status: "ERROR", error: "unknown ticker" }); } catch { pgThrew = true; }
assert(pgThrew, "a Polygon error payload must throw");

console.log("data sources smoke passed");
