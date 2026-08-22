import type { SummaryData, SeriesView } from "./summary-data";

export type TelcoOperator = "Telkomsel" | "XLSmart" | "Indosat";
export const OPERATORS: TelcoOperator[] = ["Telkomsel", "Indosat", "XLSmart"];

export interface BreakdownComponent {
  name: string;
  // Per-quarter figures (used for the last-8-quarters trend bars) and the
  // sheet's own YTD cumulative figures (used for the period-total/donut/list
  // whenever YTD mode is selected).
  seriesQ: (number | null)[];
  seriesCum: (number | null)[];
}

export interface TelcoDataset {
  QUARTERS: string[];
  OPERATORS: TelcoOperator[];
  METRICS: Record<string, Record<TelcoOperator, (number | null)[]>>;
  BREAKDOWN: Record<TelcoOperator, { components: BreakdownComponent[] }>;
}

function zeros(n: number): (number | null)[] {
  return new Array(n).fill(null);
}

// "XLSmart" in the dashboard maps straight to the sheet's "XLS" operator rows
// (XL Axiata's legacy rows are gone from the sheet — XLSmart only shows data
// from whenever XLS itself starts reporting; earlier quarters are left blank).
const XLSMART_SHEET_NAME = "XLS";

function findRaw(data: SummaryData, operator: string, baseName: string, view: SeriesView): (number | null)[] {
  const s = data.series.find((r) => r.operator === operator && r.baseName === baseName && r.view === view);
  return s ? s.values : zeros(data.quarters.length);
}

function toFraction(values: (number | null)[]): (number | null)[] {
  return values.map((v) => (v == null ? null : v / 100));
}

function scale(values: (number | null)[], factor: number): (number | null)[] {
  return values.map((v) => (v == null ? null : v * factor));
}

function metric(
  data: SummaryData,
  baseName: string,
  view: SeriesView,
  opts?: { pct?: boolean },
): Record<TelcoOperator, (number | null)[]> {
  const telkomsel = findRaw(data, "Telkomsel", baseName, view);
  const xlsmart = findRaw(data, XLSMART_SHEET_NAME, baseName, view);
  const indosat = findRaw(data, "Indosat/IOH", baseName, view);
  if (opts?.pct) {
    return { Telkomsel: toFraction(telkomsel), XLSmart: toFraction(xlsmart), Indosat: toFraction(indosat) };
  }
  return { Telkomsel: telkomsel, XLSmart: xlsmart, Indosat: indosat };
}

export function buildTelcoDataset(data: SummaryData): TelcoDataset {
  const q = data.quarters;

  // Read straight from the sheet — Total Payload is expected to be in TB for
  // every operator, XLSmart included, as entered directly in the source.
  const payloadQ: Record<TelcoOperator, (number | null)[]> = {
    Telkomsel: findRaw(data, "Telkomsel", "Total Payload", "Quarterly"),
    Indosat: findRaw(data, "Indosat/IOH", "Total Payload", "Quarterly"),
    XLSmart: findRaw(data, XLSMART_SHEET_NAME, "Total Payload", "Quarterly"),
  };

  // FBB (Fixed Broadband) Subscribers: the sheet reports Telkomsel's in
  // Million but Indosat's and XLSmart's in K (thousand) — normalize those two
  // to Million so all three plot on the same scale.
  const fbbSubscribersRaw = metric(data, "2C FBB Subscribers", "Snapshot");
  const fbbSubscribers: Record<TelcoOperator, (number | null)[]> = {
    Telkomsel: fbbSubscribersRaw.Telkomsel,
    Indosat: scale(fbbSubscribersRaw.Indosat, 1 / 1000),
    XLSmart: scale(fbbSubscribersRaw.XLSmart, 1 / 1000),
  };

  const METRICS: TelcoDataset["METRICS"] = {
    totalRevenueQ: metric(data, "Total Revenue", "Quarterly"),
    totalRevenueCum: metric(data, "Total Revenue", "Cumulative"),
    ebitdaQ: metric(data, "EBITDA", "Quarterly"),
    ebitdaCum: metric(data, "EBITDA", "Cumulative"),
    ebitdaMarginQ: metric(data, "EBITDA Margin", "Quarterly", { pct: true }),
    ebitdaMarginCum: metric(data, "EBITDA Margin", "Cumulative", { pct: true }),
    patQ: metric(data, "PAT", "Quarterly"),
    patCum: metric(data, "PAT", "Cumulative"),
    totalUser: metric(data, "Total User", "Snapshot"),
    postpaidUser: metric(data, "Postpaid User", "Snapshot"),
    prepaidUser: metric(data, "Prepaid User", "Snapshot"),
    blendedArpuQ: metric(data, "Blended ARPU", "Quarterly"),
    blendedArpuCum: metric(data, "Blended ARPU", "Cumulative"),
    postpaidArpuQ: metric(data, "Postpaid ARPU", "Quarterly"),
    postpaidArpuCum: metric(data, "Postpaid ARPU", "Cumulative"),
    prepaidArpuQ: metric(data, "Prepaid ARPU", "Quarterly"),
    prepaidArpuCum: metric(data, "Prepaid ARPU", "Cumulative"),
    dataRevenueQ: metric(data, "Data Revenue", "Quarterly"),
    capexCum: metric(data, "Capex", "Cumulative"),
    payloadQ,
    payloadCum: metric(data, "Total Payload", "Cumulative"),
    fiveGBTS: metric(data, "5G BTS", "Snapshot"),
    totalBTS: metric(data, "Total BTS", "Snapshot"),
    opexQ: metric(data, "Opex", "Quarterly"),
    fbbSubscribers,
    // Only Telkomsel reports an FBB ARPU line (as "2C Indihome ARPU") —
    // Indosat and XLSmart show as a gap.
    fbbArpuQ: metric(data, "2C Indihome ARPU", "Quarterly"),
    fbbArpuCum: metric(data, "2C Indihome ARPU", "Cumulative"),
  };

  const component = (operator: string, baseName: string, name: string): BreakdownComponent => ({
    name,
    seriesQ: findRaw(data, operator, baseName, "Quarterly"),
    seriesCum: findRaw(data, operator, baseName, "Cumulative"),
  });

  const BREAKDOWN: TelcoDataset["BREAKDOWN"] = {
    Telkomsel: {
      components: [
        component("Telkomsel", "Legacy Revenue", "Legacy"),
        component("Telkomsel", "Digital Business", "Digital Business"),
        component("Telkomsel", "2C Indihome Revenue", "IndiHome (B2C)"),
      ],
    },
    Indosat: {
      components: [
        component("Indosat/IOH", "Cellular Revenue", "Cellular"),
        component("Indosat/IOH", "MIDI Revenue", "MIDI"),
        component("Indosat/IOH", "Fixed Telecom", "Fixed Telecom"),
      ],
    },
    XLSmart: {
      components: [
        component(XLSMART_SHEET_NAME, "Data Revenue and Digital Revenue", "Data & Digital"),
        component(XLSMART_SHEET_NAME, "Other Revenue", "Other"),
      ],
    },
  };

  return { QUARTERS: q, OPERATORS, METRICS, BREAKDOWN };
}
