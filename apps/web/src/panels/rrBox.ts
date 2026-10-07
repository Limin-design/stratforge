/**
 * Risk/reward box — a lightweight-charts series primitive that shades the
 * planned reward zone (entry→target, green) and risk zone (entry→stop, red)
 * across a trade's holding period, like a TradingView position tool. Drawing is
 * wrapped defensively so a coordinate hiccup can never break the chart.
 */
import type { IChartApi, ISeriesApi, Time } from "lightweight-charts";

export interface RRData {
  entry: number;
  stop: number | null;
  target: number | null;
  from: Time;
  to: Time;
}

export class RiskRewardPrimitive {
  data: RRData | null = null;
  private chart: IChartApi;
  private series: ISeriesApi<"Candlestick">;
  private requestUpdate?: () => void;
  private views: { zOrder: () => "top"; renderer: () => { draw: (t: unknown) => void } }[];

  constructor(chart: IChartApi, series: ISeriesApi<"Candlestick">) {
    this.chart = chart;
    this.series = series;
    this.views = [
      {
        zOrder: () => "top",
        renderer: () => ({ draw: (t: unknown) => this.draw(t) }),
      },
    ];
  }

  // lightweight-charts plugin lifecycle (all optional / duck-typed)
  attached(param: { requestUpdate: () => void }): void {
    this.requestUpdate = param.requestUpdate;
  }
  detached(): void {
    this.requestUpdate = undefined;
  }
  updateAllViews(): void {
    /* views read live data each draw */
  }
  paneViews() {
    return this.views;
  }

  setData(d: RRData | null): void {
    this.data = d;
    this.requestUpdate?.();
  }

  private draw(target: unknown): void {
    const d = this.data;
    const t = target as { useBitmapCoordinateSpace?: (cb: (s: unknown) => void) => void } | null;
    if (!d || !t || typeof t.useBitmapCoordinateSpace !== "function") return;
    t.useBitmapCoordinateSpace((sc: unknown) => {
      try {
        const scope = sc as { context: CanvasRenderingContext2D; horizontalPixelRatio: number; verticalPixelRatio: number };
        const ctx = scope.context;
        const ts = this.chart.timeScale();
        const x1 = ts.timeToCoordinate(d.from);
        const x2 = ts.timeToCoordinate(d.to);
        const yE = this.series.priceToCoordinate(d.entry);
        if (x1 == null || x2 == null || yE == null) return;
        const hr = scope.horizontalPixelRatio || 1;
        const vr = scope.verticalPixelRatio || 1;
        const X1 = Math.min(x1, x2) * hr;
        const w = Math.max(Math.abs(x2 - x1) * hr, 2 * hr);
        const yEb = yE * vr;

        if (d.target != null) {
          const yT = this.series.priceToCoordinate(d.target);
          if (yT != null) {
            const yTb = yT * vr;
            ctx.fillStyle = "rgba(38,166,154,0.16)";
            ctx.fillRect(X1, Math.min(yEb, yTb), w, Math.abs(yTb - yEb));
          }
        }
        if (d.stop != null) {
          const yS = this.series.priceToCoordinate(d.stop);
          if (yS != null) {
            const ySb = yS * vr;
            ctx.fillStyle = "rgba(239,83,80,0.16)";
            ctx.fillRect(X1, Math.min(yEb, ySb), w, Math.abs(ySb - yEb));
          }
        }
        ctx.strokeStyle = "#8893a6";
        ctx.lineWidth = Math.max(1, vr);
        ctx.beginPath();
        ctx.moveTo(X1, yEb);
        ctx.lineTo(X1 + w, yEb);
        ctx.stroke();
      } catch {
        /* never let a draw error break the chart */
      }
    });
  }
}
