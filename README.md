# StratForge (working title)

Trading Strategy Builder — declarative strategies, backtesting, professional charts, and a plug-in AI agent. Web first; Windows/macOS/iOS via Tauri 2 in phase 2.

## Structure

| Path | What it is |
|---|---|
| `packages/dsl` | Strategy DSL (Zod schema). Strategies are JSON data, not code — safe for AI agents to generate. |
| `packages/engine` | TypeScript backtest engine: indicators, bar-by-bar executor (no look-ahead bias), per-bar timeline for chart replay, summary stats. |
| `packages/data-import` | Data Hub wizards: Binance (free crypto API) + MetaTrader 5 (free forex CSV export), plus dataset validation (gaps, duplicates). |
| `apps/web` | React + Vite shell: Dockview multi-tab layout, Lightweight Charts with trade markers/indicator overlays/equity pane, strategy builder, agent panel (stub). |

## Run it

```bash
pnpm install
pnpm demo   # engine smoke test (synthetic data + golden-cross strategy)
pnpm dev    # web app on http://localhost:5173
```

In the app: open the **Data Hub** tab → load BTCUSDT from Binance → switch to **Strategy Builder** → Run Backtest → see trades/indicators/equity on the **Chart** tab.

## Desktop app (.exe)

One-time prerequisites on Windows:

1. Rust (MSVC toolchain): `winget install Rustlang.Rustup` then restart the terminal.
2. Visual Studio C++ Build Tools: `winget install Microsoft.VisualStudio.2022.BuildTools` and select the "Desktop development with C++" workload (or install from visualstudio.microsoft.com/visual-cpp-build-tools).
3. WebView2 runtime — already included in Windows 10/11.

Then:

```bash
pnpm install          # picks up @tauri-apps/cli
pnpm desktop:dev      # run the desktop app in dev mode (hot reload)
pnpm desktop:build    # produce the .exe
```

`desktop:build` outputs two things:

- Installer: `apps/desktop/src-tauri/target/release/bundle/nsis/StratForge_0.1.0_x64-setup.exe`
- Standalone exe: `apps/desktop/src-tauri/target/release/stratforge.exe`

First build takes several minutes (compiles Rust); later builds are fast.

## Roadmap

- **Phase 1 (now):** auth (Supabase: Google/Apple), Data Hub, strategy builder, backtest + chart visualization, agent chat backlog.
- **Phase 2:** Tauri 2 desktop (Win/macOS/iOS), cloud sync, Monte Carlo simulations in Web Workers, agent wired to user's own model key via MCP toolset.
- **Phase 3:** affiliate data partnerships, opt-in anonymized telemetry for community benchmarks, legal entity → TradingView Advanced Charts application.

## Engine design notes

- Signals evaluate on bar close; fills at next bar's open (no look-ahead bias).
- Stop-loss checked before take-profit intrabar (conservative).
- Results stored as per-bar timeline (equity, position, drawdown) — powers chart replay and trade-by-trade inspection.
- Default fee 0.1%/side (Binance spot taker).
