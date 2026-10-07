/**
 * Live theming. Overrides the CSS variables in theme.css at runtime and persists
 * them on-device. `applyTheme()` runs once at startup (main.tsx); the Settings
 * panel calls setVar / applyPreset / resetTheme.
 */
const KEY = "stratforge.theme";

export interface ThemeVar {
  key: string;
  label: string;
  def: string;
}

export const THEME_VARS: ThemeVar[] = [
  { key: "--accent", label: "Accent", def: "#717d92" },
  { key: "--bg-0", label: "Background", def: "#0c0d10" },
  { key: "--bg-1", label: "Panels", def: "#15171b" },
  { key: "--bg-2", label: "Surfaces", def: "#1c1f25" },
  { key: "--rail", label: "Side rail", def: "#101116" },
  { key: "--text", label: "Text", def: "#dce1e8" },
  { key: "--border", label: "Borders", def: "#252a32" },
  { key: "--good", label: "Positive", def: "#4fae8e" },
];

function hexToRgba(hex: string, a: number): string {
  const h = hex.replace("#", "");
  const n = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const r = parseInt(n.slice(0, 2), 16);
  const g = parseInt(n.slice(2, 4), 16);
  const b = parseInt(n.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

export function getOverrides(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

/** Apply one variable to :root (and keep --accent-dim in sync with --accent). */
export function applyVar(key: string, value: string): void {
  const root = document.documentElement;
  root.style.setProperty(key, value);
  if (key === "--accent") root.style.setProperty("--accent-dim", hexToRgba(value, 0.16));
}

export function setVar(key: string, value: string): void {
  const o = getOverrides();
  o[key] = value;
  try {
    localStorage.setItem(KEY, JSON.stringify(o));
  } catch {
    /* ignore */
  }
  applyVar(key, value);
}

/** Run at startup: re-apply saved overrides. */
export function applyTheme(): void {
  for (const [k, v] of Object.entries(getOverrides())) applyVar(k, v);
}

export function resetTheme(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  const root = document.documentElement;
  for (const v of THEME_VARS) root.style.removeProperty(v.key);
  root.style.removeProperty("--accent-dim");
}

export interface Preset {
  name: string;
  vars: Record<string, string>;
}

export const PRESETS: Preset[] = [
  { name: "Slate", vars: { "--accent": "#717d92", "--bg-0": "#0c0d10", "--bg-1": "#15171b", "--bg-2": "#1c1f25", "--rail": "#101116", "--text": "#dce1e8", "--border": "#252a32", "--good": "#4fae8e" } },
  { name: "Default Blue", vars: { "--accent": "#5aa0f2", "--bg-0": "#0b0c0e", "--bg-1": "#131519", "--bg-2": "#1a1d22", "--rail": "#0e0f12", "--text": "#d7dbe0", "--border": "#2a2e35", "--good": "#3fb98a" } },
  { name: "Terminal Green", vars: { "--accent": "#3fb98a", "--bg-0": "#0a0d0a", "--bg-1": "#0f140f", "--bg-2": "#141a14", "--rail": "#0c100c", "--text": "#cfe8d6", "--border": "#244029", "--good": "#3fb98a" } },
  { name: "Amber Forge", vars: { "--accent": "#e0a35e", "--bg-0": "#0d0b08", "--bg-1": "#16120c", "--bg-2": "#1d1810", "--rail": "#100d09", "--text": "#e6ddcf", "--border": "#3a2f1f", "--good": "#3fb98a" } },
  { name: "Slate Mono", vars: { "--accent": "#9aa3b0", "--bg-0": "#0a0a0a", "--bg-1": "#121212", "--bg-2": "#1a1a1a", "--rail": "#0e0e0e", "--text": "#d6d6d6", "--border": "#2e2e2e", "--good": "#bdbdbd" } },
  { name: "Rose Noir", vars: { "--accent": "#e0608a", "--bg-0": "#0d0a0c", "--bg-1": "#161015", "--bg-2": "#1d151b", "--rail": "#100b0e", "--text": "#e7d8df", "--border": "#3a2530", "--good": "#3fb98a" } },
];

export function applyPreset(p: Preset): void {
  for (const [k, v] of Object.entries(p.vars)) setVar(k, v);
}
