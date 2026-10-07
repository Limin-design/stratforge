import { parseCsvCandles, parseCsvCandlesAsync } from "../src/csv.ts";

const samples: Array<{ name: string; csv: string; minBars: number }> = [
  {
    name: "header-iso",
    minBars: 3,
    csv: `time,open,high,low,close,volume
2024-01-01 00:00:00,100,102,99,101,1200
2024-01-01 01:00:00,101,103,100,102,1300
2024-01-01 02:00:00,102,104,101,103,1250`,
  },
  {
    name: "mt5-split-date-time",
    minBars: 2,
    csv: `Date,Time,Open,High,Low,Close,TickVol
2024.02.01,09:00,1.1000,1.1050,1.0950,1.1020,200
2024.02.01,10:00,1.1020,1.1070,1.1000,1.1060,250`,
  },
  {
    name: "no-header-epoch-ms",
    minBars: 2,
    csv: `1704067200000,100,101,99,100.5,10
1704070800000,100.5,102,100,101.4,11`,
  },
];

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

async function main(): Promise<void> {
  for (const sample of samples) {
    const sync = parseCsvCandles(sample.csv);
    const asyncParsed = await parseCsvCandlesAsync(sample.csv);

    assert(sync.candles.length >= sample.minBars, `${sample.name}: expected at least ${sample.minBars} bars, got ${sync.candles.length}`);
    assert(asyncParsed.candles.length === sync.candles.length, `${sample.name}: async/sync length mismatch`);

    for (let i = 0; i < sync.candles.length; i++) {
      const a = sync.candles[i];
      const b = asyncParsed.candles[i];
      assert(a.time === b.time, `${sample.name}: time mismatch at index ${i}`);
      assert(a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close, `${sample.name}: OHLC mismatch at index ${i}`);
    }

    console.log(`ok: ${sample.name} (${sync.candles.length} bars)`);
  }

  console.log("csv smoke passed");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
