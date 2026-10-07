# StratForge — agent brief

**Read [`PROJECT_STATUS.md`](./PROJECT_STATUS.md) for the full handoff** (architecture,
file map, how to run, gotchas, roadmap). This file is the short version any AI
working in this repo must follow.

## What this is
A desktop trading-strategy terminal: design, backtest, and **honestly stress-test**
strategies, with a bring-your-own-model AI quant analyst. pnpm monorepo,
**TypeScript only**. `apps/web` (Vite+React UI) · `apps/desktop` (Tauri 2 shell) ·
`packages/{dsl,engine,data-import}`.

## Rules (non-negotiable)
1. **TS-only.** No Python / TA-Lib / Pandas backends. The engine is pure TypeScript.
2. **Key security.** API keys are masked on entry and never shown again; only the
   selected source is displayed. The AI key is stored zero-knowledge (encrypted
   on-device, passphrase never stored). Never log secrets.
3. **Honesty about overfitting is mandatory.** The analyst is analytical and
   **never sycophantic**; it doesn't moralize about legal trading but **must** flag
   illegal activity (insider trading, manipulation).
4. **Never expose internal/scratch file paths** to the user.
5. Communication: blunt, direct, concise — pushback over validation.
6. **Flag what's not good enough.** Whenever you spot something weak, fragile, or
   improvable, surface it with a concrete fix — as long as it won't break anything
   else. Known flaws/bugs live in `PROJECT_STATUS.md` §8; keep that list current.

## Run
```
pnpm install
pnpm --filter @stratforge/web dev        # browser dev — the working path today
```
Desktop (`pnpm --filter @stratforge/desktop dev:desktop`) needs **Visual Studio
Build Tools → "Desktop development with C++"** (`link.exe`), not yet installed on
the dev machine. Use the web path until then.

## Gotchas (see PROJECT_STATUS.md §7)
- Azure OpenAI `/openai/v1` needs `api-version=preview`; `model` = deployment name.
- Desktop routes LLM calls through `tauri-plugin-http` (CORS-free) via `pickFetch()`.
- Vite dev doesn't typecheck — run `pnpm --filter @stratforge/web typecheck`.
- Verify engine logic in a sandbox with `node --experimental-strip-types` on copied
  source (pnpm symlinks don't resolve; the mount can serve stale files).

## State of play
Built: engine (indicators, backtest, robustness, correlation, cointegration, pairs),
all panels (Chart, Strategy, Stats, Data, Agent, Correlate, Pairs, Cloud, Referral,
Profile, Settings), multi-provider agent + vault, multi-source data hub + generic
CSV importer, Slate theme. Pending: cloud backend deploy, persist data keys, JSON/
tick importers. Full detail in PROJECT_STATUS.md.
