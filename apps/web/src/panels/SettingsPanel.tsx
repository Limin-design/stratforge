/**
 * Settings · appearance — live color-palette customization. Changes apply
 * instantly (CSS variables on :root) and persist on-device via theme.ts.
 */
import { useState } from "react";
import { applyPreset, getOverrides, PRESETS, resetTheme, setVar, THEME_VARS } from "../theme.js";

const ghost = { background: "var(--bg-3)", color: "var(--text)", border: "1px solid var(--border)" } as const;

export function SettingsPanel() {
  const [, force] = useState(0);
  const refresh = () => force((n) => n + 1);
  const overrides = getOverrides();
  const valueOf = (key: string, def: string) => overrides[key] || def;

  return (
    <div className="cli-panel" style={{ overflowY: "auto" }}>
      <span className="cli-prompt">settings · color palette</span>

      <div className="cli-box">
        <strong>Presets</strong>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {PRESETS.map((p) => (
            <button
              key={p.name}
              className="cli-btn"
              style={{ ...ghost, fontSize: 11, padding: "6px 10px" }}
              onClick={() => { applyPreset(p); refresh(); }}
            >
              <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 3, background: p.vars["--accent"], marginRight: 6, verticalAlign: "middle" }} />
              {p.name}
            </button>
          ))}
        </div>
      </div>

      <div className="cli-box">
        <strong>Custom colors</strong>
        {THEME_VARS.map((v) => (
          <label key={v.key} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12, color: "var(--text-dim)" }}>
            <input
              type="color"
              value={valueOf(v.key, v.def)}
              onChange={(e) => { setVar(v.key, e.target.value); refresh(); }}
              style={{ width: 36, height: 26, padding: 0, border: "1px solid var(--border)", borderRadius: 6, background: "transparent", cursor: "pointer" }}
            />
            <span style={{ flex: 1, color: "var(--text)" }}>{v.label}</span>
            <code style={{ fontSize: 11 }}>{valueOf(v.key, v.def)}</code>
          </label>
        ))}
      </div>

      <button className="cli-btn" style={ghost} onClick={() => { resetTheme(); refresh(); }}>
        Reset to default
      </button>
      <span className="cli-hint">Changes apply live and are saved on this device.</span>
    </div>
  );
}
