import * as React from "react";
import { useMemo, useRef, useState } from "react";

import type { TelcoDataset, TelcoOperator } from "@/lib/data/telco-adapter";
import type { Series, TipState } from "./chart-tooltip-types";
import { RefreshIcon } from "@/components/dashboard/icons";

const h = React.createElement;

const COLORS: Record<TelcoOperator, string> = {
  Telkomsel: "#E4002B",
  XLSmart: "#0A5BD3",
  Indosat: "#E8920A",
};

const INK = "#10202F";
const MUTED = "#67788A";

interface Growth {
  text: string;
  dir: "up" | "down" | "flat";
}

interface KpiDef {
  label?: string;
  unit?: string;
  q: string;
  cum?: string | null;
  type: "flow" | "ratio" | "stock";
  kind?: string;
  k?: string;
}

interface Props {
  data: TelcoDataset;
  defaultTab?: string;
  onRefresh?: () => void;
  refreshing?: boolean;
  refreshError?: string | null;
  lastUpdated?: string;
}

export function TelcoDashboard({ data, defaultTab, onRefresh, refreshing, refreshError, lastUpdated }: Props) {
  const lastQuarter = data.QUARTERS[data.QUARTERS.length - 1] ?? "1Q2020";
  const lastMatch = lastQuarter.match(/^(\d)Q(\d+)$/);
  const defaultQuarter = lastMatch ? Number(lastMatch[1]) : 1;
  const defaultYear = lastMatch ? Number(lastMatch[2]) : new Date().getFullYear();

  const [activeTab, setActiveTab] = useState(defaultTab || "overview");
  const [ops, setOps] = useState<Record<TelcoOperator, boolean>>({
    Telkomsel: true,
    XLSmart: true,
    Indosat: true,
  });
  const [year, setYear] = useState(defaultYear);
  const [quarter, setQuarter] = useState(defaultQuarter);
  const [mode, setMode] = useState<"quarter" | "ytd">("quarter");
  const [tip, setTipState] = useState<TipState | null>(null);
  const [showLabels, setShowLabels] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const tsigRef = useRef<string | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function color(op: TelcoOperator) {
    return COLORS[op];
  }
  function opSub(op: TelcoOperator) {
    return op === "Telkomsel" ? "TLKM / TSEL" : op === "XLSmart" ? "EXCL · merged" : "ISAT / IOH";
  }

  function fmt(v: number | null | undefined, kind?: string): string {
    if (v == null || Number.isNaN(v)) return "—";
    switch (kind) {
      case "tn":
        return "Rp " + (v / 1000).toFixed(1) + "T";
      case "bn":
        return Math.round(v).toLocaleString("en-US") + " Bn";
      case "m":
        return v.toFixed(1) + "M";
      case "m2":
        return v.toFixed(2) + "M";
      case "k":
        return "Rp " + v.toFixed(1) + "k";
      case "pct":
        return (v * 100).toFixed(1) + "%";
      case "pb":
        return (v / 1000).toLocaleString("en-US", { maximumFractionDigits: 0 }) + " PB";
      case "num0":
        return Math.round(v).toLocaleString("en-US");
      case "num1":
        return v.toFixed(1);
      case "num2":
        return v.toFixed(2);
      default:
        return "" + v;
    }
  }

  function qi(): number {
    const idx = data.QUARTERS.indexOf(quarter + "Q" + year);
    return idx < 0 ? data.QUARTERS.length - 1 : idx;
  }
  function shortQ(q: string): string {
    return ("" + q).replace("Q20", "Q");
  }
  function selectedOps(): TelcoOperator[] {
    return data.OPERATORS.filter((o) => ops[o]);
  }

  function growth(cur: number | null, prior: number | null, ratio: boolean): Growth | null {
    if (cur == null || prior == null || Number.isNaN(cur) || Number.isNaN(prior)) return null;
    if (ratio) {
      const pp = (cur - prior) * 100;
      return { text: (pp >= 0 ? "+" : "") + pp.toFixed(1) + "pp", dir: pp > 0.05 ? "up" : pp < -0.05 ? "down" : "flat" };
    }
    if (prior === 0) return null;
    const pct = ((cur - prior) / Math.abs(prior)) * 100;
    return { text: (pct >= 0 ? "+" : "") + pct.toFixed(1) + "%", dir: pct > 0.05 ? "up" : pct < -0.05 ? "down" : "flat" };
  }

  function chip(g: Growth | null, sz?: number) {
    if (!g) return h("span", { style: { color: "#9AA8B6", fontSize: (sz || 11) + "px" } }, "n/a");
    const c = g.dir === "up" ? { f: "#15803D", b: "#E6F4EC" } : g.dir === "down" ? { f: "#C32A2A", b: "#FBECEC" } : { f: "#6B7888", b: "#EEF1F5" };
    const ar = g.dir === "up" ? "▲" : g.dir === "down" ? "▼" : "▬";
    return h(
      "span",
      {
        style: {
          display: "inline-flex",
          alignItems: "center",
          gap: "3px",
          background: c.b,
          color: c.f,
          fontWeight: 600,
          fontSize: (sz || 11) + "px",
          padding: "2px 6px",
          borderRadius: "5px",
          fontVariantNumeric: "tabular-nums",
          whiteSpace: "nowrap",
        },
      },
      h("span", { style: { fontSize: (sz ? sz - 3 : 8) + "px" } }, ar),
      g.text,
    );
  }

  function kpiData(kpi: KpiDef): Record<TelcoOperator, { value: number | null; yoyPrior: number | null; qoqPrior: number | null }> {
    const d = data;
    const idx = qi();
    const M = d.METRICS;
    const q = M[kpi.q];
    const cum = kpi.cum ? M[kpi.cum] : null;
    const out = {} as Record<TelcoOperator, { value: number | null; yoyPrior: number | null; qoqPrior: number | null }>;
    for (const op of d.OPERATORS) {
      let value: number | null, yoyPrior: number | null, qoqPrior: number | null;
      if (mode === "ytd" && cum) {
        // A reported cumulative/YTD row exists — prefer it outright (this
        // applies to ratio metrics too, e.g. EBITDA Margin (Cumulative),
        // not just summable flow metrics).
        value = cum[op][idx];
        yoyPrior = cum[op][idx - 4];
        qoqPrior = idx % 4 === 0 ? null : cum[op][idx - 1];
      } else if (mode === "ytd" && kpi.type === "flow") {
        const s = q[op];
        const st = idx - (quarter - 1);
        let v = 0,
          ok = false;
        for (let i = st; i <= idx; i++) {
          if (s[i] != null) {
            v += s[i] as number;
            ok = true;
          }
        }
        value = ok ? v : null;
        let py = 0,
          pok = false;
        for (let i = st - 4; i <= idx - 4; i++) {
          if (i >= 0 && s[i] != null) {
            py += s[i] as number;
            pok = true;
          }
        }
        yoyPrior = pok ? py : null;
        qoqPrior = null;
      } else {
        value = q[op][idx];
        yoyPrior = q[op][idx - 4];
        qoqPrior = q[op][idx - 1];
      }
      out[op] = { value, yoyPrior, qoqPrior };
    }
    return out;
  }

  function copyBtn(id: string, fn: () => string) {
    const done = copied === id;
    return h(
      "button",
      {
        title: "Copy this panel’s data to clipboard",
        onClick: () => {
          let tx = "";
          try {
            tx = fn();
          } catch {
            /* ignore */
          }
          try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(tx);
            } else {
              const ta = document.createElement("textarea");
              ta.value = tx;
              ta.style.position = "fixed";
              ta.style.opacity = "0";
              document.body.appendChild(ta);
              ta.select();
              try {
                document.execCommand("copy");
              } catch {
                /* ignore */
              }
              document.body.removeChild(ta);
            }
          } catch {
            /* ignore */
          }
          setCopied(id);
          if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
          copyTimerRef.current = setTimeout(() => setCopied((c) => (c === id ? null : c)), 1300);
        },
        style: {
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: "28px",
          height: "28px",
          borderRadius: "7px",
          border: "1px solid " + (done ? "#15803D" : "#E0E6ED"),
          background: done ? "#E6F4EC" : "#fff",
          color: done ? "#15803D" : "#8593A2",
          cursor: "pointer",
          flex: "0 0 auto",
          transition: "all .15s",
          padding: 0,
        },
      },
      done
        ? h(
            "svg",
            { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none" },
            h("path", { d: "M5 12.5l4.5 4.5L19 7", stroke: "currentColor", strokeWidth: 2.4, strokeLinecap: "round", strokeLinejoin: "round" }),
          )
        : h(
            "svg",
            { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none" },
            h("rect", { x: 8, y: 8, width: 12, height: 12, rx: 2.5, stroke: "currentColor", strokeWidth: 2 }),
            h("path", { d: "M16 5.5H6.5A1.5 1.5 0 005 7v10", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" }),
          ),
    );
  }

  function tsvSeries(labels: string[], series: Series[]): string {
    const head = "Quarter\t" + series.map((s) => s.name).join("\t");
    const rows = labels.map(
      (lb, i) =>
        shortQ(lb) +
        "\t" +
        series
          .map((s) => {
            const v = s.data[i];
            return v == null ? "" : Math.round(v * 100) / 100;
          })
          .join("\t"),
    );
    return head + "\n" + rows.join("\n");
  }
  function tsvRows(header: string[], rows: (string | number | null)[][]): string {
    return header.join("\t") + "\n" + rows.map((r) => r.map((c) => (c == null ? "" : c)).join("\t")).join("\n");
  }

  function idxFromEvent(e: React.MouseEvent<SVGSVGElement>, W: number, padL: number, plotW: number, n: number, band: boolean) {
    const svg = e.currentTarget;
    const rc = svg.getBoundingClientRect();
    const vx = ((e.clientX - rc.left) / rc.width) * W;
    let idx = band ? Math.floor((vx - padL) / (plotW / n)) : Math.round((vx - padL) / (plotW / Math.max(1, n - 1)));
    idx = Math.max(0, Math.min(n - 1, idx));
    return { idx, rc };
  }
  function setTip(chart: string, idx: number, p: Omit<TipState, "chart" | "idx">) {
    const sig = chart + "|" + idx;
    if (tsigRef.current === sig) return;
    tsigRef.current = sig;
    setTipState({ chart, idx, ...p });
  }
  function clearTip() {
    tsigRef.current = null;
    setTipState((t) => (t ? null : t));
  }
  function tooltipEl() {
    const t = tip;
    if (!t) return null;
    return h(
      "div",
      {
        style: {
          position: "fixed",
          left: t.px + "px",
          top: t.py + "px",
          transform: "translate(-50%,calc(-100% - 12px))",
          background: "#0C1A28",
          color: "#fff",
          borderRadius: "9px",
          padding: "9px 11px",
          boxShadow: "0 8px 24px rgba(8,18,28,0.4)",
          pointerEvents: "none",
          zIndex: 100,
          minWidth: "132px",
        },
      },
      h(
        "div",
        { style: { fontSize: "10.5px", color: "#8EA1B4", fontWeight: 600, marginBottom: "6px", letterSpacing: "0.04em", textTransform: "uppercase" } },
        shortQ(t.label),
      ),
      t.rows.map((r, i) =>
        h(
          "div",
          { key: i, style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "16px", padding: "2px 0" } },
          h(
            "span",
            { style: { display: "flex", alignItems: "center", gap: "6px" } },
            h("span", { style: { width: "8px", height: "8px", borderRadius: "2px", background: r.color, flex: "0 0 auto" } }),
            h("span", { style: { fontSize: "11.5px", color: "#D7E0E9", whiteSpace: "nowrap" } }, r.name),
          ),
          h("span", { style: { fontSize: "12.5px", fontWeight: 700, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" } }, t.vfmt(r.value)),
        ),
      ),
    );
  }

  function niceMax(max: number): number {
    if (max <= 0) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(max)));
    const n = max / p;
    const m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
    return m * p;
  }

  function lineChart(seriesList: Series[], labels: string[], opts: Record<string, any> = {}) {
    const W = opts.width || 760,
      H = opts.height || 250,
      padL = opts.padL || 46,
      padR = 18,
      padT = 16,
      padB = 26;
    const iW = W - padL - padR,
      iH = H - padT - padB;
    const vals: number[] = [];
    seriesList.forEach((s) =>
      s.data.forEach((v) => {
        if (v != null) vals.push(v);
      }),
    );
    if (!vals.length)
      return h("div", { style: { color: MUTED, fontSize: "13px", padding: "40px 30px", textAlign: "center" } }, "No data for the selected operators / period");
    let mn = Math.min(...vals),
      mx = Math.max(...vals);
    if (opts.zero || (mn > 0 && mn / mx > 0.35)) mn = Math.min(0, mn);
    if (opts.pct) {
      mn = Math.min(mn, 0);
    }
    const rng = mx - mn || 1;
    mx = mn + rng * 1.12;
    const n = labels.length;
    const X = (i: number) => padL + (n <= 1 ? iW / 2 : (iW * i) / (n - 1));
    const Y = (v: number) => padT + iH * (1 - (v - mn) / (mx - mn));
    const vfmt: (v: number | null) => string = opts.vfmt || opts.yfmt || ((v: number | null) => fmt(v, "num1"));
    const tipKey = opts.tipKey || "L" + W + H + seriesList.map((s) => s.name).join("|") + n;

    const grid: any[] = [];
    const ticks = 4;
    for (let t = 0; t <= ticks; t++) {
      const val = mn + ((mx - mn) * t) / ticks;
      const y = Y(val);
      grid.push(h("line", { key: "g" + t, x1: padL, x2: W - padR, y1: y, y2: y, stroke: t === 0 ? "#D7DEE6" : "#EEF2F6", strokeWidth: 1 }));
      grid.push(
        h(
          "text",
          { key: "gt" + t, x: padL - 8, y: y + 3.5, textAnchor: "end", fontSize: 10.5, fill: "#93A1B0", style: { fontVariantNumeric: "tabular-nums" } },
          opts.yfmt ? opts.yfmt(val) : Math.round(val),
        ),
      );
    }
    const xlabels = labels.map((lb, i) => h("text", { key: "x" + i, x: X(i), y: H - 8, textAnchor: "middle", fontSize: 9.3, fill: "#93A1B0" }, shortQ(lb)));
    const paths: any[] = [];
    const dots: any[] = [];
    const lbls: any[] = [];
    seriesList.forEach((s, si) => {
      let dd = "",
        started = false;
      s.data.forEach((v, i) => {
        if (v == null) {
          started = false;
          return;
        }
        dd += (started ? "L" : "M") + X(i).toFixed(1) + " " + Y(v).toFixed(1) + " ";
        started = true;
      });
      paths.push(h("path", { key: "p" + si, d: dd, fill: "none", stroke: s.color, strokeWidth: 2.4, strokeLinejoin: "round", strokeLinecap: "round" }));
      let li = -1;
      for (let i = s.data.length - 1; i >= 0; i--) {
        if (s.data[i] != null) {
          li = i;
          break;
        }
      }
      if (li >= 0) {
        dots.push(h("circle", { key: "d" + si, cx: X(li), cy: Y(s.data[li] as number), r: 3.4, fill: "#fff", stroke: s.color, strokeWidth: 2 }));
      }
      if (showLabels) {
        s.data.forEach((v, i) => {
          if (v == null) return;
          lbls.push(
            h(
              "text",
              {
                key: "ll" + si + "-" + i,
                x: X(i),
                y: Y(v) - 8,
                textAnchor: "middle",
                fontSize: 11,
                fontWeight: 700,
                fill: s.color,
                style: { fontVariantNumeric: "tabular-nums", paintOrder: "stroke", stroke: "#fff", strokeWidth: "3px", strokeLinejoin: "round" },
              },
              vfmt(v),
            ),
          );
        });
      }
    });
    const hl =
      opts.highlight != null && opts.highlight >= 0 && opts.highlight < n
        ? h("line", { x1: X(opts.highlight), x2: X(opts.highlight), y1: padT, y2: padT + iH, stroke: "#CDD6DF", strokeWidth: 1, strokeDasharray: "3 3" })
        : null;
    let guide = null,
      gdots = null;
    if (tip && tip.chart === tipKey) {
      const gi = tip.idx;
      guide = h("line", { x1: X(gi), x2: X(gi), y1: padT, y2: padT + iH, stroke: "#8593A2", strokeWidth: 1 });
      gdots = seriesList.map((s, si) =>
        s.data[gi] == null ? null : h("circle", { key: "gd" + si, cx: X(gi), cy: Y(s.data[gi] as number), r: 4.2, fill: s.color, stroke: "#fff", strokeWidth: 1.6 }),
      );
    }
    const move = (e: React.MouseEvent<SVGSVGElement>) => {
      const r = idxFromEvent(e, W, padL, iW, n, false);
      const idx = r.idx;
      const rows = seriesList.map((s) => ({ name: s.name, color: s.color, value: s.data[idx] })).filter((x) => x.value != null);
      if (!rows.length) return;
      const minY = Math.min(...rows.map((x) => Y(x.value as number)));
      const px = r.rc.left + (X(idx) / W) * r.rc.width;
      const py = r.rc.top + (minY / H) * r.rc.height;
      setTip(tipKey, idx, { label: labels[idx], rows, vfmt, px, py });
    };
    return h(
      "svg",
      { viewBox: "0 0 " + W + " " + H, width: "100%", height: H, style: { display: "block", overflow: "visible" }, onMouseMove: move, onMouseLeave: () => clearTip() },
      grid,
      hl,
      guide,
      xlabels,
      paths,
      dots,
      gdots,
      lbls,
    );
  }

  function groupedBars(groups: string[], seriesList: Series[], opts: Record<string, any> = {}) {
    const W = opts.width || 760,
      H = opts.height || 250,
      padL = opts.padL || 46,
      padR = 14,
      padT = 18,
      padB = 30;
    const iW = W - padL - padR,
      iH = H - padT - padB;
    const vals: number[] = [];
    seriesList.forEach((s) =>
      s.data.forEach((v) => {
        if (v != null) vals.push(v);
      }),
    );
    if (!vals.length)
      return h("div", { style: { color: MUTED, fontSize: "13px", padding: "40px 30px", textAlign: "center" } }, "No data for the selected operators / period");
    let mx = niceMax(Math.max(...vals, 0));
    let mn = Math.min(0, ...vals);
    if (mn < 0) mn = -niceMax(-mn);
    const Y = (v: number) => padT + iH * (1 - (v - mn) / (mx - mn));
    const gN = groups.length,
      sN = seriesList.length;
    const gW = iW / gN,
      bGap = 0.18 * gW,
      bW = ((gW - bGap) / sN) * 0.82;
    const vfmt: (v: number | null) => string = opts.vfmt || opts.yfmt || ((v: number | null) => fmt(v, "num1"));
    const tipKey = opts.tipKey || "B" + W + H + seriesList.map((s) => s.name).join("|") + gN;

    const grid: any[] = [];
    const ticks = 4;
    for (let t = 0; t <= ticks; t++) {
      const val = mn + ((mx - mn) * t) / ticks;
      const y = Y(val);
      grid.push(h("line", { key: "g" + t, x1: padL, x2: W - padR, y1: y, y2: y, stroke: Math.abs(val) < 1e-9 ? "#D0D8E0" : "#EEF2F6", strokeWidth: 1 }));
      grid.push(
        h(
          "text",
          { key: "gt" + t, x: padL - 8, y: y + 3.5, textAnchor: "end", fontSize: 10.5, fill: "#93A1B0", style: { fontVariantNumeric: "tabular-nums" } },
          opts.yfmt ? opts.yfmt(val) : Math.round(val),
        ),
      );
    }
    const hov = tip && tip.chart === tipKey ? h("rect", { x: padL + gW * tip.idx, y: padT, width: gW, height: iH, fill: "#0C1A28", opacity: 0.05, rx: 3 }) : null;
    const bars: any[] = [];
    const xlabels: any[] = [];
    const lbls: any[] = [];
    groups.forEach((g, gi) => {
      const gx = padL + gW * gi + bGap / 2;
      xlabels.push(h("text", { key: "x" + gi, x: padL + gW * gi + gW / 2, y: H - 9, textAnchor: "middle", fontSize: 10.5, fill: "#7C8A98" }, shortQ(g)));
      seriesList.forEach((s, si) => {
        const v = s.data[gi];
        if (v == null) return;
        const x = gx + ((gW - bGap) / sN) * si + ((gW - bGap) / sN - bW) / 2;
        const y0 = Y(0),
          y1 = Y(v);
        const top = Math.min(y0, y1),
          hh = Math.abs(y1 - y0);
        bars.push(h("rect", { key: "b" + gi + "-" + si, x: x, y: top, width: bW, height: Math.max(hh, 1), rx: 2, fill: s.color, opacity: 0.92 }));
        if (showLabels && bW >= 11) {
          lbls.push(
            h(
              "text",
              {
                key: "bl" + gi + "-" + si,
                x: x + bW / 2,
                y: v >= 0 ? top - 4 : top + hh + 11,
                textAnchor: "middle",
                fontSize: 10,
                fontWeight: 700,
                fill: "#3C4B5C",
                style: { fontVariantNumeric: "tabular-nums", paintOrder: "stroke", stroke: "#fff", strokeWidth: "2.6px", strokeLinejoin: "round" },
              },
              vfmt(v),
            ),
          );
        }
      });
    });
    const move = (e: React.MouseEvent<SVGSVGElement>) => {
      const r = idxFromEvent(e, W, padL, iW, gN, true);
      const gi = r.idx;
      const rows = seriesList.map((s) => ({ name: s.name, color: s.color, value: s.data[gi] })).filter((x) => x.value != null);
      if (!rows.length) return;
      const px = r.rc.left + ((padL + gW * gi + gW / 2) / W) * r.rc.width;
      const tops = rows.map((x) => Y(Math.max(0, x.value as number)));
      const py = r.rc.top + (Math.min(...tops) / H) * r.rc.height;
      setTip(tipKey, gi, { label: groups[gi], rows, vfmt, px, py });
    };
    return h(
      "svg",
      { viewBox: "0 0 " + W + " " + H, width: "100%", height: H, style: { display: "block", overflow: "visible" }, onMouseMove: move, onMouseLeave: () => clearTip() },
      grid,
      hov,
      bars,
      xlabels,
      lbls,
    );
  }

  function stackedBars(labels: string[], stacks: Series[], opts: Record<string, any> = {}) {
    const W = opts.width || 540,
      H = opts.height || 230,
      padL = opts.padL || 44,
      padR = 12,
      padT = 12,
      padB = 26;
    const iW = W - padL - padR,
      iH = H - padT - padB;
    const totals = labels.map((_, i) => stacks.reduce((a, s) => a + (s.data[i] || 0), 0));
    const mx = niceMax(Math.max(...totals, 1));
    const Y = (v: number) => padT + iH * (1 - v / mx);
    const n = labels.length,
      gW = iW / n,
      bW = gW * 0.6;
    const vfmt: (v: number | null) => string = opts.vfmt || opts.yfmt || ((v: number | null) => fmt(v, "num1"));
    const tipKey = opts.tipKey || "S" + W + H + stacks.map((s) => s.name).join("|") + n;

    const grid: any[] = [];
    const ticks = 4;
    for (let t = 0; t <= ticks; t++) {
      const val = (mx * t) / ticks;
      const y = Y(val);
      grid.push(h("line", { key: "g" + t, x1: padL, x2: W - padR, y1: y, y2: y, stroke: t === 0 ? "#D0D8E0" : "#EEF2F6", strokeWidth: 1 }));
      grid.push(
        h(
          "text",
          { key: "gt" + t, x: padL - 7, y: y + 3.5, textAnchor: "end", fontSize: 10, fill: "#93A1B0", style: { fontVariantNumeric: "tabular-nums" } },
          opts.yfmt ? opts.yfmt(val) : Math.round(val),
        ),
      );
    }
    const hov = tip && tip.chart === tipKey ? h("rect", { x: padL + gW * tip.idx, y: padT, width: gW, height: iH, fill: "#0C1A28", opacity: 0.05, rx: 3 }) : null;
    const bars: any[] = [];
    const xlabels: any[] = [];
    const lbls: any[] = [];
    labels.forEach((lb, i) => {
      const x = padL + gW * i + (gW - bW) / 2;
      let acc = 0;
      xlabels.push(h("text", { key: "x" + i, x: padL + gW * i + gW / 2, y: H - 8, textAnchor: "middle", fontSize: 9.8, fill: "#7C8A98" }, shortQ(lb)));
      stacks.forEach((s, si) => {
        const v = s.data[i] || 0;
        if (v <= 0) return;
        const y1 = Y(acc + v),
          y0 = Y(acc);
        acc += v;
        bars.push(
          h("rect", {
            key: "b" + i + "-" + si,
            x: x,
            y: y1,
            width: bW,
            height: Math.max(y0 - y1, 0.5),
            fill: s.color,
            opacity: 0.94,
            rx: si === stacks.length - 1 ? 2 : 0,
          }),
        );
        if (showLabels && y0 - y1 > 15 && bW >= 22) {
          lbls.push(
            h(
              "text",
              {
                key: "sl" + i + "-" + si,
                x: x + bW / 2,
                y: (y0 + y1) / 2 + 3.5,
                textAnchor: "middle",
                fontSize: 10,
                fontWeight: 700,
                fill: "#fff",
                style: { fontVariantNumeric: "tabular-nums" },
              },
              vfmt(v),
            ),
          );
        }
      });
    });
    const move = (e: React.MouseEvent<SVGSVGElement>) => {
      const r = idxFromEvent(e, W, padL, iW, n, true);
      const i = r.idx;
      const rows = stacks.map((s) => ({ name: s.name, color: s.color, value: s.data[i] })).filter((x) => x.value != null && x.value > 0);
      if (!rows.length) return;
      rows.push({ name: "Total", color: "#5B6B7B", value: totals[i] });
      const px = r.rc.left + ((padL + gW * i + gW / 2) / W) * r.rc.width;
      const py = r.rc.top + (Y(totals[i]) / H) * r.rc.height;
      setTip(tipKey, i, { label: labels[i], rows, vfmt, px, py });
    };
    return h(
      "svg",
      { viewBox: "0 0 " + W + " " + H, width: "100%", height: H, style: { display: "block", overflow: "visible" }, onMouseMove: move, onMouseLeave: () => clearTip() },
      grid,
      hov,
      bars,
      xlabels,
      lbls,
    );
  }

  function donut(slices: { name: string; color: string; value: number }[], opts: Record<string, any> = {}) {
    const sz = opts.size || 150,
      r = sz / 2,
      rin = r * 0.6;
    const tot = slices.reduce((a, s) => a + (s.value || 0), 0) || 1;
    let ang = -Math.PI / 2;
    const arcs: any[] = [];
    slices.forEach((s, i) => {
      const frac = (s.value || 0) / tot;
      const a2 = ang + frac * Math.PI * 2;
      const x1 = r + r * Math.cos(ang),
        y1 = r + r * Math.sin(ang),
        x2 = r + r * Math.cos(a2),
        y2 = r + r * Math.sin(a2);
      const xi1 = r + rin * Math.cos(a2),
        yi1 = r + rin * Math.sin(a2),
        xi2 = r + rin * Math.cos(ang),
        yi2 = r + rin * Math.sin(ang);
      const large = frac > 0.5 ? 1 : 0;
      const d = `M${x1} ${y1} A${r} ${r} 0 ${large} 1 ${x2} ${y2} L${xi1} ${yi1} A${rin} ${rin} 0 ${large} 0 ${xi2} ${yi2} Z`;
      arcs.push(h("path", { key: i, d: d, fill: s.color, opacity: 0.94 }));
      ang = a2;
    });
    return h(
      "svg",
      { viewBox: "0 0 " + sz + " " + sz, width: sz, height: sz, style: { display: "block" } },
      arcs,
      opts.center ? h("text", { x: r, y: r - 2, textAnchor: "middle", fontSize: 15, fontWeight: 700, fill: INK, style: { fontFamily: "Archivo" } }, opts.center) : null,
      opts.centerSub ? h("text", { x: r, y: r + 13, textAnchor: "middle", fontSize: 9.5, fill: MUTED }, opts.centerSub) : null,
    );
  }

  function legend(items: { name: string; color: string }[]) {
    return h(
      "div",
      { style: { display: "flex", gap: "16px", flexWrap: "wrap", alignItems: "center" } },
      items.map((it, i) =>
        h(
          "div",
          { key: i, style: { display: "flex", alignItems: "center", gap: "6px" } },
          h("span", { style: { width: "11px", height: "11px", borderRadius: "3px", background: it.color, display: "inline-block" } }),
          h("span", { style: { fontSize: "12px", color: INK, fontWeight: 500 } }, it.name),
        ),
      ),
    );
  }

  function panel(title: string, sub: string | null, body: any, extra: any, copyFn?: () => string) {
    return h(
      "div",
      { style: { background: "#fff", border: "1px solid #E3E9EF", borderRadius: "12px", padding: "16px 18px 18px", boxShadow: "0 1px 2px rgba(16,32,47,0.04)" } },
      h(
        "div",
        { style: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "12px", marginBottom: "12px" } },
        h(
          "div",
          null,
          h("div", { style: { fontFamily: "Archivo", fontWeight: 700, fontSize: "14.5px", color: INK, letterSpacing: "-0.005em" } }, title),
          sub ? h("div", { style: { fontSize: "11.5px", color: MUTED, marginTop: "2px" } }, sub) : null,
        ),
        h("div", { style: { display: "flex", alignItems: "center", gap: "10px", flex: "0 0 auto" } }, extra || null, copyFn ? copyBtn(title, copyFn) : null),
      ),
      body,
    );
  }

  function scorecardCard(kpi: KpiDef) {
    const dataK = kpiData(kpi);
    const opsSel = selectedOps();
    const ratio = kpi.kind === "pct";
    let maxAbs = 0;
    opsSel.forEach((o) => {
      const v = dataK[o].value;
      if (v != null && Math.abs(v) > maxAbs) maxAbs = Math.abs(v);
    });
    maxAbs = maxAbs || 1;
    const rows = opsSel.map((op, i) => {
      const dd = dataK[op];
      const g = growth(dd.value, dd.yoyPrior, ratio);
      const w = dd.value != null ? Math.max(3, (Math.abs(dd.value) / maxAbs) * 100) : 0;
      return h(
        "div",
        { key: op, style: { padding: "7px 0", borderTop: i ? "1px solid #F0F3F6" : "none" } },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" } },
          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: "7px", minWidth: 0 } },
            h("span", { style: { width: "8px", height: "8px", borderRadius: "2px", background: color(op), flex: "0 0 auto" } }),
            h("span", { style: { fontSize: "12.5px", color: INK, fontWeight: 500, whiteSpace: "nowrap" } }, op),
          ),
          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: "8px" } },
            h("span", { style: { fontFamily: "Archivo", fontWeight: 700, fontSize: "15px", color: INK, fontVariantNumeric: "tabular-nums" } }, fmt(dd.value, kpi.kind)),
            chip(g, 10.5),
          ),
        ),
        h(
          "div",
          { style: { height: "4px", borderRadius: "3px", background: "#EFF2F6", marginTop: "6px", overflow: "hidden" } },
          h("div", { style: { height: "100%", width: w + "%", borderRadius: "3px", background: color(op), opacity: (dd.value ?? 0) < 0 ? 0.45 : 0.85 } }),
        ),
      );
    });
    return h(
      "div",
      { style: { background: "#fff", border: "1px solid #E3E9EF", borderRadius: "12px", padding: "14px 16px 13px", boxShadow: "0 1px 2px rgba(16,32,47,0.04)", display: "flex", flexDirection: "column" } },
      h(
        "div",
        { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "8px", marginBottom: "4px" } },
        h("div", { style: { fontSize: "12px", fontWeight: 700, color: INK, textTransform: "uppercase", letterSpacing: "0.04em", whiteSpace: "nowrap" } }, kpi.label),
        h("div", { style: { fontSize: "10.5px", color: "#9AA8B6", whiteSpace: "nowrap", flex: "0 0 auto" } }, kpi.unit),
      ),
      h("div", { style: { fontSize: "10px", color: "#A7B3C0", marginBottom: "2px" } }, "value · Δ YoY"),
      rows,
    );
  }

  function scorecard() {
    const kpis: KpiDef[] = [
      { label: "Total Revenue", unit: "Rp / quarter", q: "totalRevenueQ", cum: "totalRevenueCum", type: "flow", kind: "tn" },
      { label: "EBITDA Margin", unit: "% of revenue", q: "ebitdaMarginQ", cum: "ebitdaMarginCum", type: "ratio", kind: "pct" },
      { label: "Mobile Subscribers", unit: "million", q: "totalUser", type: "stock", kind: "m" },
      { label: "Blended ARPU", unit: "Rp /sub/mo", q: "blendedArpuQ", cum: "blendedArpuCum", type: "ratio", kind: "k" },
      { label: "Data Traffic", unit: "PB / quarter", q: "payloadQ", cum: "payloadCum", type: "flow", kind: "pb" },
    ];
    return h(
      "div",
      { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(214px,1fr))", gap: "14px", alignItems: "stretch" } },
      kpis.map((k, i) => h("div", { key: i, style: { display: "flex" } }, h("div", { style: { flex: 1, display: "flex" } }, scorecardCard(k)))),
    );
  }

  function trendSlice(metricKey: string) {
    const idx = qi();
    const start = Math.max(0, idx - 11);
    const labels = data.QUARTERS.slice(start, idx + 1);
    const series: Series[] = selectedOps().map((op) => ({ name: op, color: color(op), data: data.METRICS[metricKey][op].slice(start, idx + 1) }));
    return { labels, series, highlight: labels.length - 1 };
  }

  const vT = () => (v: number) => "Rp " + (v / 1000).toFixed(1) + "T";
  const vM = () => (v: number) => v.toFixed(1) + "M";
  const vK = () => (v: number) => "Rp " + v.toFixed(0) + "k";
  const vP = () => (v: number) => (v * 100).toFixed(1) + "%";
  const vPB = () => (v: number) => (v / 1000).toLocaleString("en-US", { maximumFractionDigits: 0 }) + " PB";
  const vN = () => (v: number) => Math.round(v).toLocaleString("en-US");

  function periodTitle(): string {
    const q = quarter + "Q" + String(year).slice(2);
    return mode === "ytd" ? "YTD " + q : q;
  }

  function leagueTable(kpis: KpiDef[]) {
    const opsSel = selectedOps();
    const idx = qi();
    // MoM (quarter-over-quarter) always compares the raw quarterly series,
    // regardless of the YTD/Quarter toggle — unlike the YoY chip (which
    // follows kpiData's mode-dependent cum/quarterly sourcing), this column
    // is meant to answer "vs. last quarter" the same way no matter what
    // period is selected.
    const momGrowth = (k: KpiDef, op: TelcoOperator): Growth | null => {
      const q = data.METRICS[k.q][op];
      return growth(q[idx], q[idx - 1], k.k === "pct");
    };
    const subHeadCell = { textAlign: "right" as const, padding: "0 14px 8px", fontSize: "10px", textTransform: "uppercase" as const, letterSpacing: "0.04em", color: MUTED, fontWeight: 600, borderBottom: "1px solid #E3E9EF" };
    const head1 = h(
      "tr",
      null,
      h("th", { rowSpan: 2, style: { textAlign: "left", verticalAlign: "bottom", padding: "9px 14px", fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.05em", color: MUTED, fontWeight: 600, borderBottom: "1px solid #E3E9EF" } }, "Metric"),
      opsSel.map((op) => h("th", { key: op, colSpan: 2, style: { textAlign: "center", padding: "9px 14px 4px", fontSize: "12px", color: INK, fontWeight: 700, borderBottom: "2px solid " + color(op) } }, op)),
    );
    const head2 = h(
      "tr",
      null,
      opsSel.map((op) => [h("th", { key: op + "-yoy", style: subHeadCell }, "YoY"), h("th", { key: op + "-mom", style: subHeadCell }, "MoM")]),
    );
    const rows = kpis.map((k, ri) => {
      const dataK = kpiData(k);
      return h(
        "tr",
        { key: ri, style: { background: ri % 2 ? "#FAFBFC" : "#fff" } },
        h("td", { style: { padding: "9px 14px", fontSize: "12.5px", color: INK, fontWeight: 500, whiteSpace: "nowrap" } }, k.label),
        opsSel.map((op) => {
          const dd = dataK[op];
          const g = growth(dd.value, dd.yoyPrior, k.k === "pct");
          const mg = momGrowth(k, op);
          return [
            h(
              "td",
              { key: op + "-yoy", style: { padding: "9px 14px", textAlign: "right", whiteSpace: "nowrap" } },
              h(
                "div",
                { style: { display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "8px" } },
                h("span", { style: { fontSize: "13px", fontWeight: 600, color: INK, fontVariantNumeric: "tabular-nums" } }, fmt(dd.value, k.k)),
                chip(g, 10),
              ),
            ),
            h("td", { key: op + "-mom", style: { padding: "9px 14px", textAlign: "right", whiteSpace: "nowrap" } }, chip(mg, 10)),
          ];
        }),
      );
    });
    const copyFn = () =>
      tsvRows(
        ["Metric", ...opsSel.flatMap((op) => [op + " value", op + " YoY %", op + " MoM %"])],
        kpis.map((k) => {
          const dataK = kpiData(k);
          return [
            k.label as string | number,
            ...opsSel.flatMap((op): (string | number)[] => {
              const dd = dataK[op];
              const g = growth(dd.value, dd.yoyPrior, k.k === "pct");
              const mg = momGrowth(k, op);
              const gVal = g ? parseFloat(g.text) : "";
              const mVal = mg ? parseFloat(mg.text) : "";
              return [dd.value == null ? "" : Math.round(dd.value * 100) / 100, gVal, mVal];
            }),
          ];
        }),
      );
    return panel(
      "League table — all KPIs",
      "Value with year-over-year and quarter-over-quarter change · " + periodTitle(),
      h("div", { style: { overflowX: "auto" } }, h("table", { style: { width: "100%", borderCollapse: "collapse", minWidth: "760px" } }, h("thead", null, head1, head2), h("tbody", null, rows))),
      null,
      copyFn,
    );
  }

  function overview() {
    const idx = qi();
    const opsSel = selectedOps();
    const revData = kpiData({ q: "totalRevenueQ", cum: "totalRevenueCum", type: "flow" });
    const slices = opsSel.map((op) => ({ name: op, color: color(op), value: revData[op].value || 0 }));
    const totSel = slices.reduce((a, s) => a + s.value, 0);
    const tr = trendSlice("totalRevenueQ");
    const subLabels = data.QUARTERS.slice(Math.max(0, idx - 11), idx + 1);
    const subSeries: Series[] = opsSel.map((op) => ({ name: op, color: color(op), data: data.METRICS.totalUser[op].slice(Math.max(0, idx - 11), idx + 1) }));
    const fbbSubSeries: Series[] = opsSel.map((op) => ({ name: op, color: color(op), data: data.METRICS.fbbSubscribers[op].slice(Math.max(0, idx - 11), idx + 1) }));
    const leagueKpis: KpiDef[] = [
      { label: "Revenue", k: "tn", q: "totalRevenueQ", cum: "totalRevenueCum", type: "flow" },
      { label: "EBITDA", k: "tn", q: "ebitdaQ", cum: "ebitdaCum", type: "flow" },
      { label: "EBITDA margin", k: "pct", q: "ebitdaMarginQ", cum: "ebitdaMarginCum", type: "ratio" },
      { label: "Net income", k: "tn", q: "patQ", cum: "patCum", type: "flow" },
      { label: "Mobile subs", k: "m", q: "totalUser", type: "stock" },
      { label: "FBB Subscribers", k: "m", q: "fbbSubscribers", type: "stock" },
      { label: "Blended ARPU", k: "k", q: "blendedArpuQ", cum: "blendedArpuCum", type: "ratio" },
      { label: "FBB ARPU", k: "k", q: "fbbArpuQ", cum: "fbbArpuCum", type: "ratio" },
      { label: "Data traffic (PB)", k: "pb", q: "payloadQ", cum: "payloadCum", type: "flow" },
    ];
    const shareCopy = () =>
      tsvRows(
        ["Operator", "Revenue (Rp Bn)", "Share %"],
        slices.map((s) => [s.name, s.value != null ? Math.round(s.value) : "", totSel ? ((s.value / totSel) * 100).toFixed(1) : ""]),
      );
    return h(
      "div",
      null,
      h(
        "div",
        { style: { fontFamily: "Archivo", fontWeight: 700, fontSize: "13px", color: MUTED, textTransform: "uppercase", letterSpacing: "0.08em", margin: "0 0 12px" } },
        "Executive scorecard — " + periodTitle(),
      ),
      scorecard(),
      h(
        "div",
        { style: { display: "grid", gridTemplateColumns: "1.55fr 1fr", gap: "16px", marginTop: "16px" } },
        panel(
          "Total revenue trend",
          "Rp trillion / quarter · last 12 quarters",
          lineChart(tr.series, tr.labels, { height: 250, yfmt: (v: number) => (v / 1000).toFixed(0), vfmt: vT(), highlight: tr.highlight, tipKey: "ov-rev" }),
          legend(tr.series),
          () => tsvSeries(tr.labels, tr.series),
        ),
        panel(
          "Revenue share",
          "Selected operators · " + periodTitle(),
          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: "14px", justifyContent: "center", flexWrap: "wrap" } },
            donut(slices, { size: 148, center: fmt(totSel, "tn"), centerSub: "combined" }),
            h(
              "div",
              { style: { display: "flex", flexDirection: "column", gap: "9px" } },
              slices.map((s, i) =>
                h(
                  "div",
                  { key: i, style: { display: "flex", alignItems: "center", gap: "8px" } },
                  h("span", { style: { width: "10px", height: "10px", borderRadius: "3px", background: s.color } }),
                  h(
                    "div",
                    null,
                    h("div", { style: { fontSize: "12.5px", fontWeight: 600, color: INK } }, s.name),
                    h("div", { style: { fontSize: "11px", color: MUTED, fontVariantNumeric: "tabular-nums" } }, fmt(s.value, "tn") + " · " + (totSel ? ((s.value / totSel) * 100).toFixed(1) : "0") + "%"),
                  ),
                ),
              ),
            ),
          ),
          null,
          shareCopy,
        ),
      ),
      h("div", { style: { marginTop: "16px" } }, panel("Mobile subscribers", "million · last 12 quarters", groupedBars(subLabels, subSeries, { height: 230, yfmt: (v: number) => v.toFixed(0), vfmt: vM(), tipKey: "ov-subs" }), legend(subSeries), () => tsvSeries(subLabels, subSeries))),
      h("div", { style: { marginTop: "16px" } }, panel("FBB subscribers", "million · last 12 quarters", groupedBars(subLabels, fbbSubSeries, { height: 230, yfmt: (v: number) => v.toFixed(0), vfmt: vM(), tipKey: "ov-fbb-subs" }), legend(fbbSubSeries), () => tsvSeries(subLabels, fbbSubSeries))),
      h("div", { style: { marginTop: "16px" } }, leagueTable(leagueKpis)),
    );
  }

  function financials() {
    const idx = qi();
    const start = Math.max(0, idx - 11);
    const labels = data.QUARTERS.slice(start, idx + 1);
    const opsSel = selectedOps();
    const ser = (key: string): Series[] => opsSel.map((op) => ({ name: op, color: color(op), data: data.METRICS[key][op].slice(start, idx + 1) }));
    const ebitdaMarginTrendKey = mode === "ytd" ? "ebitdaMarginCum" : "ebitdaMarginQ";
    return h(
      "div",
      null,
      h(
        "div",
        { style: { fontFamily: "Archivo", fontWeight: 700, fontSize: "13px", color: MUTED, textTransform: "uppercase", letterSpacing: "0.08em", margin: "0 0 12px" } },
        "Financial performance — " + periodTitle(),
      ),
      h(
        "div",
        { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" } },
        panel("Total revenue", "Rp trillion / quarter", lineChart(ser("totalRevenueQ"), labels, { height: 240, yfmt: (v: number) => (v / 1000).toFixed(0), vfmt: vT(), highlight: labels.length - 1, tipKey: "fin-rev" }), legend(ser("totalRevenueQ")), () => tsvSeries(labels, ser("totalRevenueQ"))),
        panel("EBITDA", "Rp trillion / quarter", groupedBars(labels, ser("ebitdaQ"), { height: 240, yfmt: (v: number) => (v / 1000).toFixed(0), vfmt: vT(), tipKey: "fin-ebitda" }), legend(ser("ebitdaQ")), () => tsvSeries(labels, ser("ebitdaQ"))),
        panel("EBITDA margin", "% of revenue", lineChart(ser(ebitdaMarginTrendKey), labels, { height: 240, pct: true, yfmt: (v: number) => (v * 100).toFixed(0) + "%", vfmt: vP(), highlight: labels.length - 1, tipKey: "fin-margin" }), legend(ser(ebitdaMarginTrendKey)), () => tsvSeries(labels, ser(ebitdaMarginTrendKey))),
        panel("Net income (PAT)", "Rp trillion / quarter · negative = loss", groupedBars(labels, ser("patQ"), { height: 240, yfmt: (v: number) => (v / 1000).toFixed(1), vfmt: vT(), tipKey: "fin-pat" }), legend(ser("patQ")), () => tsvSeries(labels, ser("patQ"))),
        panel("Capex (cumulative)", "Rp trillion · year-to-date", lineChart(ser("capexCum"), labels, { height: 240, zero: true, yfmt: (v: number) => (v / 1000).toFixed(0), vfmt: vT(), highlight: labels.length - 1, tipKey: "fin-capex" }), legend(ser("capexCum")), () => tsvSeries(labels, ser("capexCum"))),
        panel("Operating expenses", "Rp trillion / quarter", groupedBars(labels, ser("opexQ"), { height: 240, yfmt: (v: number) => (v / 1000).toFixed(0), vfmt: vT(), tipKey: "fin-opex" }), legend(ser("opexQ")), () => tsvSeries(labels, ser("opexQ"))),
      ),
    );
  }

  function subscribers() {
    const idx = qi();
    const start = Math.max(0, idx - 11);
    const labels = data.QUARTERS.slice(start, idx + 1);
    const opsSel = selectedOps();
    const ser = (key: string): Series[] => opsSel.map((op) => ({ name: op, color: color(op), data: data.METRICS[key][op].slice(start, idx + 1) }));
    const blendedArpuTrendKey = mode === "ytd" ? "blendedArpuCum" : "blendedArpuQ";
    const ppPanels = opsSel.map((op) => {
      const post = data.METRICS.postpaidUser[op][idx];
      const pre = data.METRICS.prepaidUser[op][idx];
      const tot = (post || 0) + (pre || 0);
      return h(
        "div",
        { key: op, style: { flex: "1 1 0", minWidth: "150px" } },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: "7px", marginBottom: "8px" } },
          h("span", { style: { width: "9px", height: "9px", borderRadius: "2px", background: color(op) } }),
          h("span", { style: { fontSize: "12.5px", fontWeight: 600, color: INK } }, op),
        ),
        h(
          "div",
          { style: { display: "flex", height: "26px", borderRadius: "5px", overflow: "hidden", background: "#EFF2F6" } },
          h("div", { style: { width: (tot ? ((pre || 0) / tot) * 100 : 0) + "%", background: color(op), opacity: 0.85 } }),
          h("div", { style: { width: (tot ? ((post || 0) / tot) * 100 : 0) + "%", background: color(op), opacity: 0.4 } }),
        ),
        h(
          "div",
          { style: { display: "flex", justifyContent: "space-between", marginTop: "6px", fontSize: "11px", color: MUTED, fontVariantNumeric: "tabular-nums" } },
          h("span", null, "Prepaid " + fmt(pre, "m") + (tot ? " (" + (((pre || 0) / tot) * 100).toFixed(0) + "%)" : "")),
          h("span", null, "Postpaid " + fmt(post, "m") + (tot ? " (" + (((post || 0) / tot) * 100).toFixed(0) + "%)" : "")),
        ),
      );
    });
    const mixCopy = () =>
      tsvRows(
        ["Operator", "Prepaid (M)", "Prepaid %", "Postpaid (M)", "Postpaid %"],
        opsSel.map((op) => {
          const post = data.METRICS.postpaidUser[op][idx];
          const pre = data.METRICS.prepaidUser[op][idx];
          const tot = (post || 0) + (pre || 0);
          return [op, pre, tot ? (((pre || 0) / tot) * 100).toFixed(1) : "", post, tot ? (((post || 0) / tot) * 100).toFixed(1) : ""];
        }),
      );
    const subsShareSlices = opsSel.map((op) => ({ name: op, color: color(op), value: data.METRICS.totalUser[op][idx] || 0 }));
    const subsShareTot = subsShareSlices.reduce((a, s) => a + s.value, 0);
    const subsShareCopy = () =>
      tsvRows(
        ["Operator", "Mobile Subs (M)", "Share %"],
        subsShareSlices.map((s) => [s.name, Math.round(s.value * 100) / 100, subsShareTot ? ((s.value / subsShareTot) * 100).toFixed(1) : ""]),
      );
    const fbbArpuTrendKey = mode === "ytd" ? "fbbArpuCum" : "fbbArpuQ";
    const payloadCumSer: Series[] = opsSel.map((op) => ({ name: op, color: color(op), data: data.METRICS.payloadCum[op].slice(start, idx + 1) }));
    return h(
      "div",
      null,
      h(
        "div",
        { style: { fontFamily: "Archivo", fontWeight: 700, fontSize: "13px", color: MUTED, textTransform: "uppercase", letterSpacing: "0.08em", margin: "0 0 12px" } },
        "Operations — " + periodTitle(),
      ),
      h(
        "div",
        { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" } },
        panel("Mobile subscribers", "million · last 12 quarters", lineChart(ser("totalUser"), labels, { height: 240, highlight: labels.length - 1, yfmt: (v: number) => v.toFixed(0), vfmt: vM(), tipKey: "sub-mob" }), legend(ser("totalUser")), () => tsvSeries(labels, ser("totalUser"))),
        panel("Prepaid vs postpaid mix", periodTitle() + " · share of base", h("div", { style: { display: "flex", gap: "18px", flexWrap: "wrap", padding: "6px 0" } }, ppPanels), h("div", { style: { fontSize: "10.5px", color: "#9AA8B6" } }, "solid = prepaid · faded = postpaid"), mixCopy),
      ),
      h(
        "div",
        { style: { marginTop: "16px" } },
        panel(
          "Market share of Mobile Subscribers",
          "Selected operators · " + periodTitle(),
          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: "14px", justifyContent: "center", flexWrap: "wrap" } },
            donut(subsShareSlices, { size: 148, center: fmt(subsShareTot, "m"), centerSub: "combined" }),
            h(
              "div",
              { style: { display: "flex", flexDirection: "column", gap: "9px" } },
              subsShareSlices.map((s, i) =>
                h(
                  "div",
                  { key: i, style: { display: "flex", alignItems: "center", gap: "8px" } },
                  h("span", { style: { width: "10px", height: "10px", borderRadius: "3px", background: s.color } }),
                  h(
                    "div",
                    null,
                    h("div", { style: { fontSize: "12.5px", fontWeight: 600, color: INK } }, s.name),
                    h(
                      "div",
                      { style: { fontSize: "11px", color: MUTED, fontVariantNumeric: "tabular-nums" } },
                      fmt(s.value, "m") + " · " + (subsShareTot ? ((s.value / subsShareTot) * 100).toFixed(1) : "0") + "%",
                    ),
                  ),
                ),
              ),
            ),
          ),
          null,
          subsShareCopy,
        ),
      ),
      h(
        "div",
        { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px", marginTop: "16px" } },
        panel("Prepaid subscribers", "million · last 12 quarters", lineChart(ser("prepaidUser"), labels, { height: 240, highlight: labels.length - 1, yfmt: (v: number) => v.toFixed(0), vfmt: vM(), tipKey: "sub-prepaid" }), legend(ser("prepaidUser")), () => tsvSeries(labels, ser("prepaidUser"))),
        panel("Postpaid subscribers", "million · last 12 quarters", lineChart(ser("postpaidUser"), labels, { height: 240, zero: true, highlight: labels.length - 1, yfmt: (v: number) => v.toFixed(1), vfmt: vM(), tipKey: "sub-postpaid" }), legend(ser("postpaidUser")), () => tsvSeries(labels, ser("postpaidUser"))),
        panel("Blended ARPU trend", "Rp thousand · last 12 quarters", lineChart(ser(blendedArpuTrendKey), labels, { height: 240, highlight: labels.length - 1, yfmt: (v: number) => v.toFixed(0), vfmt: vK(), tipKey: "sub-barpu" }), legend(ser(blendedArpuTrendKey)), () => tsvSeries(labels, ser(blendedArpuTrendKey))),
        panel("FBB subscribers trend", "million · last 12 quarters", lineChart(ser("fbbSubscribers"), labels, { height: 240, highlight: labels.length - 1, yfmt: (v: number) => v.toFixed(0), vfmt: vM(), tipKey: "sub-fbb-subs" }), legend(ser("fbbSubscribers")), () => tsvSeries(labels, ser("fbbSubscribers"))),
        panel("FBB ARPU trend", "Rp thousand · last 12 quarters", lineChart(ser(fbbArpuTrendKey), labels, { height: 240, highlight: labels.length - 1, yfmt: (v: number) => v.toFixed(0), vfmt: vK(), tipKey: "sub-fbb-arpu" }), legend(ser(fbbArpuTrendKey)), () => tsvSeries(labels, ser(fbbArpuTrendKey))),
        panel("Data traffic — quarterly", "Petabytes (PB) / quarter", groupedBars(labels, ser("payloadQ"), { height: 240, yfmt: (v: number) => (v / 1000).toLocaleString("en-US", { maximumFractionDigits: 0 }), vfmt: vPB(), tipKey: "sub-traffic" }), legend(ser("payloadQ")), () => tsvSeries(labels, ser("payloadQ"))),
        panel("Data traffic — cumulative (YTD)", "Petabytes accumulated year-to-date", lineChart(payloadCumSer, labels, { height: 240, zero: true, highlight: labels.length - 1, yfmt: (v: number) => (v / 1000).toLocaleString("en-US", { maximumFractionDigits: 0 }), vfmt: vPB(), tipKey: "sub-traffic-cum" }), legend(payloadCumSer), () => tsvSeries(labels, payloadCumSer)),
        panel("5G base stations — cumulative", "total sites deployed", lineChart(ser("fiveGBTS"), labels, { height: 240, zero: true, highlight: labels.length - 1, yfmt: (v: number) => (v / 1000).toFixed(0) + "k", vfmt: vN(), tipKey: "sub-5g" }), legend(ser("fiveGBTS")), () => tsvSeries(labels, ser("fiveGBTS"))),
      ),
    );
  }

  function shade(hex: string, i: number, n: number): string {
    const c = hex.replace("#", "");
    const r = parseInt(c.slice(0, 2), 16),
      g = parseInt(c.slice(2, 4), 16),
      b = parseInt(c.slice(4, 6), 16);
    const t = n <= 1 ? 0 : (i / n) * 0.62;
    const mix = (x: number) => Math.round(x + (255 - x) * t);
    return "rgb(" + mix(r) + "," + mix(g) + "," + mix(b) + ")";
  }

  function revenueDetail() {
    const idx = qi();
    const start = Math.max(0, idx - 7);
    const labels = data.QUARTERS.slice(start, idx + 1);
    const opsSel = selectedOps().filter((op) => data.BREAKDOWN[op]);
    const palette = (base: string, n: number) => {
      const arr: string[] = [];
      for (let i = 0; i < n; i++) arr.push(shade(base, i, n));
      return arr;
    };
    const panels = opsSel.map((op) => {
      const comps = data.BREAKDOWN[op].components;
      const cols = palette(color(op), comps.length);
      // Trend bars always show the per-quarter split over the last 8
      // quarters. The headline total / donut / list below reflect whichever
      // period is selected — the sheet's own YTD cumulative figures when
      // YTD mode is on, the single quarter's figures otherwise.
      const snapshotSeries = (c: (typeof comps)[number]) => (mode === "ytd" ? c.seriesCum : c.seriesQ);
      const stacks: Series[] = comps.map((c, ci) => ({ name: c.name, color: cols[ci], data: c.seriesQ.slice(start, idx + 1) }));
      const latest = comps.map((c, ci) => ({ name: c.name, color: cols[ci], value: snapshotSeries(c)[idx] || 0 }));
      const tot = latest.reduce((a, s) => a + s.value, 0);
      const prevTot = comps.reduce((a, c) => a + (snapshotSeries(c)[idx - 4] || 0), 0);
      const g = growth(tot, prevTot, false);
      return h(
        "div",
        { key: op, style: { background: "#fff", border: "1px solid #E3E9EF", borderRadius: "12px", padding: "16px 18px 18px", boxShadow: "0 1px 2px rgba(16,32,47,0.04)" } },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: "9px", marginBottom: "3px" } },
          h("span", { style: { width: "12px", height: "12px", borderRadius: "3px", background: color(op) } }),
          h("span", { style: { fontFamily: "Archivo", fontWeight: 700, fontSize: "15.5px", color: INK } }, op),
          h("span", { style: { fontSize: "11px", color: "#9AA8B6" } }, opSub(op)),
          h("div", { style: { marginLeft: "auto" } }, copyBtn("rd-" + op, () => tsvSeries(labels, stacks))),
        ),
        h(
          "div",
          { style: { display: "flex", alignItems: "baseline", gap: "9px", marginBottom: "12px", flexWrap: "wrap" } },
          h("span", { style: { fontFamily: "Archivo", fontWeight: 800, fontSize: "25px", color: INK, fontVariantNumeric: "tabular-nums" } }, tot > 0 ? fmt(tot, "tn") : "—"),
          h("span", { style: { fontSize: "11.5px", color: MUTED } }, "total revenue · " + periodTitle()),
          chip(g, 11),
        ),
        h(
          "div",
          { style: { display: "grid", gridTemplateColumns: "1fr 220px", gap: "20px", alignItems: "center" } },
          stackedBars(labels, stacks, { height: 320, width: 520, yfmt: (v: number) => (v / 1000).toFixed(0), vfmt: vT(), tipKey: "rd-" + op }),
          donut(latest, { size: 190 }),
        ),
        h(
          "div",
          { style: { marginTop: "12px", display: "flex", flexDirection: "column", gap: "6px" } },
          h(
            "div",
            { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", padding: "0 0 2px" } },
            h("span", null),
            h(
              "div",
              { style: { display: "flex", alignItems: "center", gap: "10px" } },
              h("span", { style: { width: "34px" } }),
              h("span", { style: { minWidth: "72px" } }),
              h("span", { style: { width: "62px", textAlign: "right", fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.04em", color: MUTED, fontWeight: 600 } }, "YoY"),
              h("span", { style: { width: "62px", textAlign: "right", fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.04em", color: MUTED, fontWeight: 600 } }, "MoM"),
            ),
          ),
          latest.map((s, i) => {
            const prev = snapshotSeries(comps[i])[idx - 4];
            const cg = growth(s.value, prev, false);
            // MoM always compares the raw quarterly series against the prior
            // quarter, regardless of the YTD/Quarter toggle — same rule as
            // the league table's MoM column.
            const mg = growth(comps[i].seriesQ[idx], comps[i].seriesQ[idx - 1], false);
            return h(
              "div",
              { key: i, style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", padding: "5px 0", borderTop: i ? "1px solid #F1F4F7" : "none" } },
              h(
                "div",
                { style: { display: "flex", alignItems: "center", gap: "7px" } },
                h("span", { style: { width: "9px", height: "9px", borderRadius: "2px", background: s.color } }),
                h("span", { style: { fontSize: "12.5px", color: INK } }, s.name),
              ),
              h(
                "div",
                { style: { display: "flex", alignItems: "center", gap: "10px" } },
                h("span", { style: { width: "34px", textAlign: "right", fontSize: "12px", color: MUTED, fontVariantNumeric: "tabular-nums" } }, tot ? ((s.value / tot) * 100).toFixed(0) + "%" : "—"),
                h("span", { style: { fontSize: "13px", fontWeight: 600, color: INK, fontVariantNumeric: "tabular-nums", minWidth: "72px", textAlign: "right" } }, fmt(s.value, "tn")),
                h("span", { style: { width: "62px", display: "inline-flex", justifyContent: "flex-end" } }, chip(cg, 10)),
                h("span", { style: { width: "62px", display: "inline-flex", justifyContent: "flex-end" } }, chip(mg, 10)),
              ),
            );
          }),
        ),
      );
    });
    return h(
      "div",
      null,
      h(
        "div",
        { style: { fontFamily: "Archivo", fontWeight: 700, fontSize: "13px", color: MUTED, textTransform: "uppercase", letterSpacing: "0.08em", margin: "0 0 12px" } },
        "Revenue breakdown by operator — " + periodTitle(),
      ),
      h(
        "div",
        { style: { fontSize: "12px", color: MUTED, margin: "0 0 14px" } },
        "Each operator reports revenue differently — Telkomsel by business line, Indosat by product, XLSmart by service type. Stacked bars show the last 8 quarters; donut shows the selected-period composition. Hover for exact figures.",
      ),
      opsSel.length
        ? h("div", { style: { display: "flex", flexDirection: "column", gap: "16px" } }, panels)
        : h("div", { style: { padding: "40px", textAlign: "center", color: MUTED, background: "#fff", borderRadius: "12px", border: "1px solid #E3E9EF" } }, "Select an operator to see its revenue breakdown."),
    );
  }

  // ---------- assemble outer chrome ----------
  const yoyQ = quarter + "Q" + (year - 1);
  const qoqIdx = qi() - 1 >= 0 ? data.QUARTERS[qi() - 1] : "—";
  const periodLabel = (mode === "ytd" ? "YTD " : "") + quarter + "Q" + year;
  const compareLabel = "vs " + shortQ(yoyQ) + " (YoY) · vs " + shortQ(qoqIdx) + " (QoQ)";
  const lastUpdatedLabel = useMemo(() => {
    if (!lastUpdated) return null;
    try {
      return new Date(lastUpdated).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
    } catch {
      return lastUpdated;
    }
  }, [lastUpdated]);

  const years = useMemo(() => {
    const set = new Set<number>();
    for (const q of data.QUARTERS) {
      const m = q.match(/(\d{4})$/);
      if (m) set.add(Number(m[1]));
    }
    if (set.size === 0) set.add(defaultYear);
    return Array.from(set).sort((a, b) => a - b);
  }, [data.QUARTERS]);

  const availQ: { value: number; label: string }[] = [];
  for (let qq = 1; qq <= 4; qq++) {
    if (data.QUARTERS.indexOf(qq + "Q" + year) >= 0) availQ.push({ value: qq, label: "Q" + qq });
  }

  const segOn: React.CSSProperties = { background: "#0C1A28", color: "#fff", border: "none", borderRadius: "6px", padding: "5px 14px", fontSize: "12.5px", fontWeight: 600, cursor: "pointer" };
  const segOff: React.CSSProperties = { background: "none", color: "#7A8A99", border: "none", borderRadius: "6px", padding: "5px 14px", fontSize: "12.5px", fontWeight: 600, cursor: "pointer" };

  const tabsDef: [string, string][] = [
    ["overview", "Overview"],
    ["financials", "Financials"],
    ["revenue", "Revenue details"],
    ["subscribers", "Operations"],
  ];

  let body: any;
  if (activeTab === "financials") body = financials();
  else if (activeTab === "subscribers") body = subscribers();
  else if (activeTab === "revenue") body = revenueDetail();
  else body = overview();

  return (
    <div style={{ minHeight: "100vh", background: "#EAEEF3", padding: "0 0 60px" }}>
      <div
        style={{
          background: "#0C1A28",
          color: "#fff",
          padding: "22px 34px 20px",
          position: "sticky",
          top: 0,
          zIndex: 40,
          boxShadow: "0 1px 0 rgba(255,255,255,0.06),0 6px 22px rgba(8,18,28,0.28)",
        }}
      >
        <div style={{ maxWidth: "1320px", margin: "0 auto", display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: "24px", flexWrap: "wrap" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "11px" }}>
              <div style={{ width: "9px", height: "26px", borderRadius: "2px", background: "linear-gradient(180deg,#E4002B 0 33%,#0A5BD3 33% 66%,#E8920A 66% 100%)" }} />
              <h1 style={{ margin: 0, fontFamily: "Archivo,sans-serif", fontWeight: 800, fontSize: "23px", letterSpacing: "-0.01em", whiteSpace: "nowrap" }}>Indonesia Mobile Operators</h1>
            </div>
            <div style={{ marginTop: "5px", color: "#8EA1B4", fontSize: "13px", letterSpacing: "0.01em", paddingLeft: "20px" }}>
              Competitive intelligence dashboard · Telkomsel · Indosat&nbsp;Ooredoo&nbsp;Hutchison · XLSmart
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.13em", color: "#6E8298", fontWeight: 600 }}>Reporting period</div>
            <div style={{ fontFamily: "Archivo,sans-serif", fontWeight: 700, fontSize: "20px", marginTop: "2px" }}>{periodLabel}</div>
            <div style={{ fontSize: "11.5px", color: "#7C8FA4", marginTop: "1px" }}>{compareLabel}</div>
          </div>
        </div>
      </div>

      <div style={{ background: "#fff", borderBottom: "1px solid #DCE3EB", position: "sticky", top: 88, zIndex: 35, boxShadow: "0 4px 14px rgba(16,32,47,0.04)" }}>
        <div style={{ maxWidth: "1320px", margin: "0 auto", padding: "13px 34px", display: "flex", alignItems: "center", gap: "20px", flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "9px" }}>
            <span style={{ fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.1em", color: "#90A0B0", fontWeight: 600 }}>Operators</span>
            <div style={{ display: "flex", gap: "7px", flexWrap: "wrap" }}>
              {data.OPERATORS.map((op) => {
                const active = ops[op];
                const col = color(op);
                return (
                  <button
                    key={op}
                    onClick={() =>
                      setOps((s) => {
                        const cnt = Object.values(s).filter(Boolean).length;
                        if (s[op] && cnt === 1) return s;
                        return { ...s, [op]: !s[op] };
                      })
                    }
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "7px",
                      border: "1px solid " + (active ? col : "#D7DEE6"),
                      background: active ? col : "#fff",
                      color: active ? "#fff" : "#7A8A99",
                      fontWeight: 600,
                      fontSize: "13px",
                      padding: "6px 13px 6px 11px",
                      borderRadius: "8px",
                      cursor: "pointer",
                      transition: "all .15s",
                      boxShadow: active ? "0 1px 6px " + col + "44" : "none",
                    }}
                  >
                    <span style={{ width: "8px", height: "8px", borderRadius: "2px", background: active ? "#fff" : col, display: "inline-block" }} />
                    {op}
                  </button>
                );
              })}
            </div>
          </div>
          <div style={{ width: "1px", height: "26px", background: "#E1E7EE" }} />
          <div style={{ display: "flex", alignItems: "center", gap: "9px" }}>
            <span style={{ fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.1em", color: "#90A0B0", fontWeight: 600 }}>Period</span>
            <select
              value={years.includes(year) ? year : years[years.length - 1]}
              onChange={(e) => {
                const ny = Number(e.target.value);
                const nq = data.QUARTERS.indexOf(quarter + "Q" + ny) >= 0 ? quarter : Math.max(...[1, 2, 3, 4].filter((qq) => data.QUARTERS.indexOf(qq + "Q" + ny) >= 0));
                setYear(ny);
                setQuarter(nq);
                clearTip();
              }}
              style={{
                appearance: "none",
                background:
                  "#F2F5F9 url('data:image/svg+xml;utf8,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2210%22 height=%2210%22 viewBox=%220 0 10 10%22%3E%3Cpath d=%22M2 3.5L5 6.5L8 3.5%22 stroke=%22%235B6B7B%22 stroke-width=%221.4%22 fill=%22none%22 stroke-linecap=%22round%22/%3E%3C/svg%3E') no-repeat right 10px center",
                border: "1px solid #D7DEE6",
                borderRadius: "8px",
                padding: "7px 28px 7px 12px",
                fontSize: "13.5px",
                fontWeight: 600,
                color: "#1B2C3C",
                cursor: "pointer",
              }}
            >
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
            <select
              value={quarter}
              onChange={(e) => {
                setQuarter(Number(e.target.value));
                clearTip();
              }}
              style={{
                appearance: "none",
                background:
                  "#F2F5F9 url('data:image/svg+xml;utf8,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2210%22 height=%2210%22 viewBox=%220 0 10 10%22%3E%3Cpath d=%22M2 3.5L5 6.5L8 3.5%22 stroke=%22%235B6B7B%22 stroke-width=%221.4%22 fill=%22none%22 stroke-linecap=%22round%22/%3E%3C/svg%3E') no-repeat right 10px center",
                border: "1px solid #D7DEE6",
                borderRadius: "8px",
                padding: "7px 28px 7px 12px",
                fontSize: "13.5px",
                fontWeight: 600,
                color: "#1B2C3C",
                cursor: "pointer",
              }}
            >
              {availQ.map((q) => (
                <option key={q.value} value={q.value}>
                  {q.label}
                </option>
              ))}
            </select>
            <div style={{ display: "flex", background: "#F2F5F9", border: "1px solid #D7DEE6", borderRadius: "8px", padding: "2px", gap: "2px" }}>
              <button
                onClick={() => {
                  setMode("quarter");
                  clearTip();
                }}
                style={mode === "quarter" ? segOn : segOff}
              >
                Quarter
              </button>
              <button
                onClick={() => {
                  setMode("ytd");
                  clearTip();
                }}
                style={mode === "ytd" ? segOn : segOff}
              >
                YTD
              </button>
            </div>
          </div>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "14px" }}>
            {lastUpdatedLabel && (
              <span style={{ fontSize: "11px", color: "#9AA8B6", whiteSpace: "nowrap" }}>Updated {lastUpdatedLabel}</span>
            )}
            {onRefresh && (
              <button
                onClick={onRefresh}
                disabled={refreshing}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  background: "none",
                  border: "1px solid #D7DEE6",
                  borderRadius: "8px",
                  padding: "7px 13px",
                  fontSize: "12.5px",
                  fontWeight: 600,
                  color: refreshing ? "#B7C1CC" : "#5B6B7B",
                  cursor: refreshing ? "default" : "pointer",
                }}
              >
                <RefreshIcon className={refreshing ? "icon-sm spin" : "icon-sm"} />
                {refreshing ? "Refreshing…" : "Refresh"}
              </button>
            )}
            <label style={{ display: "flex", alignItems: "center", gap: "7px", cursor: "pointer", fontSize: "12.5px", fontWeight: 600, color: "#48586A", whiteSpace: "nowrap", userSelect: "none" }}>
              <input type="checkbox" checked={showLabels} onChange={() => setShowLabels((v) => !v)} style={{ width: "15px", height: "15px", accentColor: "#0C1A28", cursor: "pointer" }} />
              Show all values
            </label>
            <button
              onClick={() => {
                setOps({ Telkomsel: true, XLSmart: true, Indosat: true });
                setYear(defaultYear);
                setQuarter(defaultQuarter);
                setMode("quarter");
                setActiveTab("overview");
                setShowLabels(false);
                clearTip();
              }}
              style={{ background: "none", border: "1px solid #D7DEE6", borderRadius: "8px", padding: "7px 13px", fontSize: "12.5px", fontWeight: 600, color: "#5B6B7B", cursor: "pointer" }}
            >
              Reset
            </button>
          </div>
        </div>
        <div style={{ maxWidth: "1320px", margin: "0 auto", padding: "0 34px", display: "flex", gap: "2px" }}>
          {tabsDef.map(([k, lb]) => {
            const on = activeTab === k;
            return (
              <button
                key={k}
                onClick={() => {
                  setActiveTab(k);
                  clearTip();
                }}
                style={{
                  background: "none",
                  border: "none",
                  borderBottom: "2.5px solid " + (on ? "#0C1A28" : "transparent"),
                  color: on ? "#0C1A28" : "#8090A0",
                  fontWeight: on ? 700 : 500,
                  fontSize: "13.5px",
                  padding: "12px 16px 11px",
                  cursor: "pointer",
                  fontFamily: "Archivo, sans-serif",
                }}
              >
                {lb}
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ maxWidth: "1320px", margin: "0 auto", padding: "24px 34px 0" }}>
        {refreshError && (
          <div style={{ marginBottom: "16px", borderRadius: "8px", border: "1px solid #F3B9B9", background: "#FBECEC", color: "#C32A2A", padding: "10px 14px", fontSize: "12.5px" }}>
            {refreshError}
          </div>
        )}
        {body}
        {tooltipEl()}
      </div>

      <div style={{ maxWidth: "1320px", margin: "30px auto 0", padding: "0 34px", color: "#8090A0", fontSize: "11.5px", lineHeight: 1.6 }}>
        Source: company quarterly filings &amp; IRO telco statistics. <b>XLSmart</b> reflects the XL Axiata–Smartfren merged entity; figures shown start from when XLSmart itself began reporting. Net income shown as
        PAT. Revenue &amp; EBITDA in Rp trillion unless noted. Hover any chart for exact figures, tick "Show all values", or use the copy icon on each panel to copy its data. Figures are management
        estimates for indicative comparison only.
      </div>
    </div>
  );
}
