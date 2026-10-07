import { Component, type ErrorInfo, type ReactNode } from "react";
import { captureError } from "../telemetry/errorTracker.js";

interface PanelErrorBoundaryProps {
  panelTitle: string;
  children: ReactNode;
}

interface PanelErrorBoundaryState {
  hasError: boolean;
  retryNonce: number;
}

/**
 * Prevents a crash in one panel from taking out the rest of the terminal.
 */
export class PanelErrorBoundary extends Component<PanelErrorBoundaryProps, PanelErrorBoundaryState> {
  state: PanelErrorBoundaryState = { hasError: false, retryNonce: 0 };

  static getDerivedStateFromError(): PanelErrorBoundaryState {
    return { hasError: true, retryNonce: 0 };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    captureError(error, { kind: "panel", context: { panel: this.props.panelTitle, componentStack: info.componentStack } });
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div
          style={{
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 20,
            background: "var(--bg-1)",
          }}
        >
          <div
            style={{
              maxWidth: 520,
              border: "1px solid var(--border)",
              borderRadius: 10,
              background: "var(--bg-2)",
              padding: "14px 16px",
            }}
          >
            <div style={{ color: "var(--white)", fontWeight: 700, marginBottom: 8 }}>
              {this.props.panelTitle} crashed
            </div>
            <div style={{ color: "var(--text-dim)", lineHeight: 1.5, marginBottom: 10 }}>
              This panel hit a runtime error. The rest of the workspace is still running.
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                className="cli-btn"
                style={{ background: "var(--bg-3)", border: "1px solid var(--border)", color: "var(--text)" }}
                onClick={() => this.setState((s) => ({ hasError: false, retryNonce: s.retryNonce + 1 }))}
              >
                Retry panel
              </button>
              <button className="cli-btn" onClick={() => window.location.reload()}>
                Reload app
              </button>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div key={this.state.retryNonce} style={{ height: "100%", width: "100%", minHeight: 0 }}>
        {this.props.children}
      </div>
    );
  }
}
