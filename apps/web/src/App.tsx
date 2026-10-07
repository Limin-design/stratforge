import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewHeaderActionsProps,
  type IDockviewPanel,
  type IDockviewPanelProps,
} from "dockview";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { PanelErrorBoundary } from "./components/PanelErrorBoundary.js";
import { AgentPanel } from "./panels/AgentPanel.js";
import { ChartPanel } from "./panels/ChartPanel.js";
import { CloudPanel } from "./panels/CloudPanel.js";
import { CorrelationPanel } from "./panels/CorrelationPanel.js";
import { DataPanel } from "./panels/DataPanel.js";
import { FeatureLabPanel } from "./panels/FeatureLabPanel.js";
import { PairsPanel } from "./panels/PairsPanel.js";
import { ProfilePanel } from "./panels/ProfilePanel.js";
import { ReferralPanel } from "./panels/ReferralPanel.js";
import { SettingsPanel } from "./panels/SettingsPanel.js";
import { StatsPanel } from "./panels/StatsPanel.js";
import { StrategyPanel } from "./panels/StrategyPanel.js";
import { TradeLogPanel } from "./panels/TradeLogPanel.js";
import { getState, setActiveWorkspace, subscribe } from "./store.js";
import { getActiveId } from "./chats.js";

function withBoundary(title: string, node: ReactNode): ReactNode {
  return <PanelErrorBoundary panelTitle={title}>{node}</PanelErrorBoundary>;
}

const components = {
  chart: (_: IDockviewPanelProps) => withBoundary("Chart", <ChartPanel />),
  strategy: (_: IDockviewPanelProps) => withBoundary("Strategy", <StrategyPanel />),
  stats: (_: IDockviewPanelProps) => withBoundary("Stats", <StatsPanel />),
  agent: (_: IDockviewPanelProps) => withBoundary("AI Analyst", <AgentPanel />),
  data: (_: IDockviewPanelProps) => withBoundary("Data Hub", <DataPanel />),
  featurelab: (_: IDockviewPanelProps) => withBoundary("Feature Lab", <FeatureLabPanel />),
  tradelog: (_: IDockviewPanelProps) => withBoundary("Trade Log", <TradeLogPanel />),
  correlation: (_: IDockviewPanelProps) => withBoundary("Correlate", <CorrelationPanel />),
  pairs: (_: IDockviewPanelProps) => withBoundary("Pairs", <PairsPanel />),
  cloud: (_: IDockviewPanelProps) => withBoundary("Cloud", <CloudPanel />),
  referrals: (_: IDockviewPanelProps) => withBoundary("Referrals", <ReferralPanel />),
  profile: (_: IDockviewPanelProps) => withBoundary("Profile", <ProfilePanel />),
  settings: (_: IDockviewPanelProps) => withBoundary("Settings", <SettingsPanel />),
};

type ComponentName = keyof typeof components;

interface PanelDef {
  id: string;
  component: ComponentName;
  title: string;
  icon: ReactNode;
}

// ---------- minimal inline icons (no icon dependency) ----------
const I = (paths: ReactNode) => (
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {paths}
  </svg>
);
const ChartIcon = I(<><path d="M4 20V11" /><path d="M10 20V4" /><path d="M16 20v-6" /><path d="M3 20h18" /></>);
const StrategyIcon = I(<><path d="M4 21v-6M4 11V3" /><path d="M12 21v-9M12 8V3" /><path d="M20 21v-4M20 13V3" /><path d="M2 15h4M10 8h4M18 17h4" /></>);
const StatsIcon = I(<><path d="M3 3v18h18" /><path d="M7 14l3-4 3 3 4-6" /></>);
const DataIcon = I(<><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5" /><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" /></>);
const AgentIcon = I(<><path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /><path d="M9 10h.01M13 10h.01M17 10h.01" /></>);
const CorrIcon = I(<><path d="M3 12h3l3-8 4 16 3-8h5" /></>);
const FeatureIcon = I(<><path d="M4 19V5" /><path d="M4 12h16" /><circle cx="8" cy="12" r="2" /><circle cx="14" cy="8" r="2" /><circle cx="17" cy="16" r="2" /></>);
const JournalIcon = I(<><path d="M5 4h14v16H5z" /><path d="M8 8h8" /><path d="M8 12h8" /><path d="M8 16h5" /></>);
const PairsIcon = I(<><path d="M3 8h14M17 8l-3-3M17 8l-3 3" /><path d="M21 16H7M7 16l3-3M7 16l3 3" /></>);
const CloudIcon = I(<><path d="M17.5 19a4.5 4.5 0 0 0 .5-9 6 6 0 0 0-11.5-1.6A4 4 0 0 0 6.5 19z" /></>);
const LinkIcon = I(<><path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1" /><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1" /></>);
const ProfileIcon = I(<><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>);
const GearIcon = I(<><circle cx="12" cy="12" r="3.2" /><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8" /></>);
const ResetIcon = I(<><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 4v5h-5" /></>);

/** Single source of truth: every panel the workspace can open. */
const PANEL_DEFS: PanelDef[] = [
  { id: "chart-1", component: "chart", title: "Chart", icon: ChartIcon },
  { id: "strategy-1", component: "strategy", title: "Strategy", icon: StrategyIcon },
  { id: "stats-1", component: "stats", title: "Stats", icon: StatsIcon },
  { id: "data-1", component: "data", title: "Data Hub", icon: DataIcon },
  { id: "agent-1", component: "agent", title: "AI Analyst", icon: AgentIcon },
  { id: "featurelab-1", component: "featurelab", title: "Feature Lab", icon: FeatureIcon },
  { id: "tradelog-1", component: "tradelog", title: "Trade Log", icon: JournalIcon },
  { id: "correlation-1", component: "correlation", title: "Correlate", icon: CorrIcon },
  { id: "pairs-1", component: "pairs", title: "Pairs", icon: PairsIcon },
  { id: "cloud-1", component: "cloud", title: "Cloud", icon: CloudIcon },
  { id: "referrals-1", component: "referrals", title: "Referrals", icon: LinkIcon },
  { id: "profile-1", component: "profile", title: "Profile", icon: ProfileIcon },
  { id: "settings-1", component: "settings", title: "Settings", icon: GearIcon },
];

/** Open a panel, or focus it if already open. */
function openPanel(api: DockviewApi, def: PanelDef): IDockviewPanel {
  const existing = api.getPanel(def.id);
  if (existing) {
    existing.api.setActive();
    return existing;
  }
  const anchor = api.panels.find((p) => p.id !== def.id);
  return api.addPanel({
    id: def.id,
    component: def.component,
    title: def.title,
    position: anchor ? { referencePanel: anchor.id, direction: "within" } : undefined,
  });
}

/** The default arrangement; also used by "reset layout". */
function buildDefaultLayout(api: DockviewApi): void {
  api.addPanel({ id: "chart-1", component: "chart", title: "Chart" });
  api.addPanel({
    id: "strategy-1",
    component: "strategy",
    title: "Strategy",
    position: { referencePanel: "chart-1", direction: "right" },
  });
  api.addPanel({
    id: "data-1",
    component: "data",
    title: "Data Hub",
    position: { referencePanel: "strategy-1", direction: "within" },
  });
  api.addPanel({
    id: "agent-1",
    component: "agent",
    title: "AI Analyst",
    position: { referencePanel: "strategy-1", direction: "below" },
  });
}

/** Per-group header buttons: float (movable inside the window) + pop out (own OS window). */
function RightHeaderActions(props: IDockviewHeaderActionsProps) {
  const float = () => props.containerApi.addFloatingGroup(props.group);
  const popOut = () => void props.containerApi.addPopoutGroup(props.group);
  return (
    <div className="dv-actions">
      <button className="dv-action-btn" title="Float this panel (movable, inside the window)" onClick={float}>
        {I(<><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M9 9h6v6H9z" /></>)}
      </button>
      <button className="dv-action-btn" title="Pop out to its own window (drag to another monitor)" onClick={popOut}>
        {I(<><path d="M14 3h7v7" /><path d="M21 3l-9 9" /><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" /></>)}
      </button>
    </div>
  );
}

export function App() {
  const apiRef = useRef<DockviewApi | null>(null);
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  const [dataset, setDataset] = useState(getState().datasetName);
  const [trades, setTrades] = useState<number | null>(getState().result?.stats.trades ?? null);

  useEffect(
    () =>
      subscribe((s) => {
        setDataset(s.datasetName);
        setTrades(s.result?.stats.trades ?? null);
      }),
    []
  );

  useEffect(() => {
    const activeChatId = getActiveId();
    if (activeChatId) setActiveWorkspace(activeChatId);
  }, []);

  const onReady = (event: DockviewReadyEvent) => {
    const api = event.api;
    apiRef.current = api;
    // Restore the saved workspace, or build the default if there's none / it's stale.
    let restored = false;
    try {
      const saved = localStorage.getItem("stratforge.layout");
      if (saved) {
        api.fromJSON(JSON.parse(saved));
        restored = api.panels.length > 0;
      }
    } catch (err) {
      console.warn("[layout] failed to restore saved layout; using default", err);
      try { api.clear(); } catch { /* ignore */ }
      restored = false;
    }
    if (!restored) buildDefaultLayout(api);

    const sync = () => setOpenIds(new Set(api.panels.map((p) => p.id)));
    sync();
    api.onDidAddPanel(sync);
    api.onDidRemovePanel(sync);

    // Persist the layout on change (debounced) so it survives restarts.
    let t: ReturnType<typeof setTimeout> | undefined;
    api.onDidLayoutChange(() => {
      clearTimeout(t);
      t = setTimeout(() => {
        try {
          localStorage.setItem("stratforge.layout", JSON.stringify(api.toJSON()));
        } catch (err) {
          console.warn("[layout] failed to persist layout", err);
        }
      }, 400);
    });
  };

  const reopen = (def: PanelDef) => {
    const api = apiRef.current;
    if (api) openPanel(api, def);
  };
  const popOutActive = () => {
    const api = apiRef.current;
    if (!api) return;
    const g = api.activeGroup;
    if (g) void api.addPopoutGroup(g);
  };
  const floatActive = () => {
    const api = apiRef.current;
    if (api?.activeGroup) api.addFloatingGroup(api.activeGroup);
  };
  const resetLayout = () => {
    const api = apiRef.current;
    if (!api) return;
    api.clear();
    buildDefaultLayout(api);
  };

  const empty = openIds.size === 0;

  return (
    <div className="app-root">
      {/* Left rail — always-visible panel launcher (reopen anything, anytime) */}
      <aside className="rail">
        <div className="rail-logo" title="StratForge">SF</div>
        <nav className="rail-nav">
          {PANEL_DEFS.map((def) => (
            <button
              key={def.id}
              className={"rail-btn" + (openIds.has(def.id) ? " on" : "")}
              onClick={() => reopen(def)}
              title={(openIds.has(def.id) ? "Focus " : "Open ") + def.title}
            >
              {def.icon}
              <span className="rail-tip">{def.title}</span>
            </button>
          ))}
        </nav>
        <div className="rail-foot">
          <button className="rail-btn" onClick={resetLayout} title="Reset to default layout">
            {ResetIcon}
            <span className="rail-tip">Reset layout</span>
          </button>
        </div>
      </aside>

      <div className="app-main">
        <header className="topbar">
          <span className="brand">StratForge</span>
          <span className="brand-sub">strategy terminal</span>
          <div className="topbar-actions">
            <button className="tb-btn" onClick={floatActive} title="Float the active panel inside the window">
              ⊞ Float
            </button>
            <button className="tb-btn" onClick={popOutActive} title="Pop the active panel out to its own window">
              ⤢ Pop out
            </button>
          </div>
          <span className="topbar-meta">{dataset}</span>
        </header>

        <div className="dock-wrap">
          <DockviewReact
            components={components}
            onReady={onReady}
            rightHeaderActionsComponent={RightHeaderActions}
            className="dockview-theme-cli"
          />
          {empty && (
            <div className="empty-state">
              <div className="empty-logo">SF</div>
              <div className="empty-title">No panels open</div>
              <div className="empty-sub">
                Open one below to get started. Rearrange by dragging a tab, resize by dragging the edge between
                panels, and use the ⤢ button on any panel to pop it onto another monitor.
              </div>
              <div className="empty-grid">
                {PANEL_DEFS.map((def) => (
                  <button key={def.id} className="empty-card" onClick={() => reopen(def)}>
                    <span className="empty-card-ic">{def.icon}</span>
                    {def.title}
                  </button>
                ))}
              </div>
              <button className="empty-reset" onClick={resetLayout}>
                Restore default layout
              </button>
            </div>
          )}
        </div>

        <footer className="statusbar">
          <span className="sb-item">dataset · {dataset}</span>
          <span className="sb-item">{trades !== null ? `backtest · ${trades} trades` : "backtest · —"}</span>
          <span className="sb-item sb-right">engine ready</span>
        </footer>
      </div>
    </div>
  );
}
