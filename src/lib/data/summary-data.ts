// ---------------------------------------------------------------------------
// Live data source: IRO telco stats V3.xlsx stored in Google Drive, shared
// as "Anyone with the link — Viewer". The Summary sheet is the single source
// of truth; editing it there is reflected here on the next fetch.
// ---------------------------------------------------------------------------
const SUMMARY_FILE_ID = "1_tBU2uRyVcNOu1r7LcYhwqYJRPYR6p9w";
const SUMMARY_SHEET_NAME = "Summary";

// gviz/tq strips text values from numeric columns (quarter columns are typed
// as numeric since most rows contain numbers). export?format=csv returns raw
// cell values so commentary text in quarter cells is included.
// Summary sheet sheetId = 2 (from the xlsx workbook.xml).
const SUMMARY_SHEET_GID = 2;

function summaryCsvUrl(): string {
  return `https://docs.google.com/spreadsheets/d/${SUMMARY_FILE_ID}/export?format=csv&gid=${SUMMARY_SHEET_GID}`;
}

function commentaryCsvUrl(): string {
  // Fallback commentary tab (optional override). If the Summary sheet already
  // has commentary rows at the bottom, this is never fetched.
  return `https://docs.google.com/spreadsheets/d/${SUMMARY_FILE_ID}/gviz/tq?tqx=out:csv&sheet=Commentary`;
}

// --- Minimal RFC4180 CSV parser (quoted fields, embedded commas, "" escape) --
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r") {
      // ignore, \n handles the line break
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const BLANK_TOKENS = new Set(["", "-", "x", "X", "NA", "N/A", "na", "n/a"]);

function parseNumericCell(raw: string | undefined): number | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed === "" || BLANK_TOKENS.has(trimmed) || trimmed.startsWith("#")) {
    return null;
  }
  const cleaned = trimmed.replace(/,/g, "").replace(/%/g, "").trim();
  if (cleaned === "" || BLANK_TOKENS.has(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

// Known typos/inconsistencies in the source sheet, fixed for display only —
// the underlying grouping key is normalized the same way so series merge
// correctly regardless of which spelling a given row uses.
const LABEL_FIXES: Array<[RegExp, string]> = [
  [/\bDiigital\b/gi, "Digital"],
  [/\bAmmortization\b/gi, "Amortization"],
  [/\bMiilion\b/gi, "Million"],
  [/\bQuaterly\b/gi, "Quarterly"],
];

function cleanLabel(raw: string): string {
  return LABEL_FIXES.reduce((acc, [re, rep]) => acc.replace(re, rep), raw.trim());
}

const OPERATOR_ALIASES: Record<string, string> = {
  IOH: "Indosat/IOH",
  XLSmart: "XLS",
  TSEL: "Telkomsel",
};

function normalizeOperator(raw: string): string {
  const cleaned = cleanLabel(raw);
  return OPERATOR_ALIASES[cleaned] ?? cleaned;
}

export type SeriesView = "Cumulative" | "Quarterly" | "Snapshot";

export interface SummarySeries {
  operator: string;
  baseName: string;
  view: SeriesView;
  unit: string;
  values: (number | null)[];
}

export interface MetricInfo {
  baseName: string;
  unit: string;
  views: SeriesView[];
}

// Executive-summary commentary rows (Metrics column === "Commentary") are
// free text per operator/category/quarter, not numbers — parsed separately
// from the numeric series above so real text isn't run through
// parseNumericCell and silently nulled out.
export interface CommentarySeries {
  operator: string;
  category: string;
  values: (string | null)[];
}

export interface SummaryData {
  quarters: string[];
  operators: string[];
  series: SummarySeries[];
  commentary: CommentarySeries[];
  metrics: MetricInfo[];
  fetchedAt: string;
  sourceUrl: string;
}

function splitKpi(rawKpi: string): { baseName: string; view: SeriesView } {
  const kpi = rawKpi.trim();
  const cumulative = kpi.match(/^(.*?)\s*\(\s*cumulative\s*\)\s*$/i);
  if (cumulative) return { baseName: cleanLabel(cumulative[1]), view: "Cumulative" };
  const quarterly = kpi.match(/^(.*?)\s*\(\s*(?:quarterly|quaterly)\s*\)\s*$/i);
  if (quarterly) return { baseName: cleanLabel(quarterly[1]), view: "Quarterly" };
  return { baseName: cleanLabel(kpi), view: "Snapshot" };
}

// Column positions are looked up by header label, not by fixed index — the
// sheet has already had a column inserted/removed once, which silently
// shifted every value by one column when positions were hardcoded.
const QUARTER_LABEL_RE = /^[1-4]q\d{4}$/i;

// KPI names used in commentary rows at the bottom of the summary sheet.
// Rows whose KPI matches one of these are captured as free text regardless
// of what the Metrics column contains. Includes alternate spellings used in
// the xlsx alongside the canonical forms.
const COMMENTARY_KPI_KEYS = new Set([
  "Headline",
  "Headlines",
  "Strength",
  "Strengths",
  "Weakness",
  "Weaknesses",
  "Management Explanation",
  "Management Action",
  "Overall Assessment",
]);

// Map alternate KPI spellings from the xlsx to the canonical keys used by the
// adapter and the UI (EXEC_SUMMARY_CATEGORIES keys).
const COMMENTARY_CATEGORY_ALIASES: Record<string, string> = {
  Headline: "Headlines",
  Strengths: "Strength",
  Weaknesses: "Weakness",
  "Management Action": "Management Explanation",
};

function parseSummarySheet(csvText: string): Omit<SummaryData, "fetchedAt" | "sourceUrl"> {
  const rows = parseCsv(csvText);

  const headerIdx = rows.findIndex((r) => r.some((cell) => (cell ?? "").trim().toLowerCase() === "operator"));
  if (headerIdx === -1) {
    throw new Error('Could not find the header row (expected a column named "Operator").');
  }
  const header = rows[headerIdx];
  const operatorCol = header.findIndex((c) => (c ?? "").trim().toLowerCase() === "operator");
  const kpiCol = header.findIndex((c) => (c ?? "").trim().toLowerCase() === "kpi");
  const metricsCol = header.findIndex((c) => (c ?? "").trim().toLowerCase() === "metrics");
  if (kpiCol === -1 || metricsCol === -1) {
    throw new Error('Could not find the "KPI" and/or "Metrics" header columns.');
  }

  const quarterCols: number[] = [];
  const quarters: string[] = [];
  header.forEach((cell, c) => {
    const label = (cell ?? "").trim();
    if (QUARTER_LABEL_RE.test(label)) {
      quarterCols.push(c);
      quarters.push(label);
    }
  });

  const series: SummarySeries[] = [];
  const commentary: CommentarySeries[] = [];
  const operatorOrder: string[] = [];
  const seenOperators = new Set<string>();

  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    const operatorRaw = (row[operatorCol] ?? "").trim();
    const kpiRaw = (row[kpiCol] ?? "").trim();
    if (!operatorRaw || !kpiRaw) continue;

    const unit = cleanLabel((row[metricsCol] ?? "").trim());

    // Commentary rows contain free text, not numbers — detected either by the
    // Metrics column saying "Commentary" or by the KPI being one of the known
    // commentary category names.
    const kpiClean = cleanLabel(kpiRaw);
    const isCommentary = unit.toLowerCase() === "commentary" || COMMENTARY_KPI_KEYS.has(kpiClean);
    if (isCommentary) {
      const commentaryOp = normalizeOperator(operatorRaw);
      const normalizedCategory = COMMENTARY_CATEGORY_ALIASES[kpiClean] ?? kpiClean;

      const values: (string | null)[] = quarterCols.map((c) => {
        const raw = (row[c] ?? "").trim();
        return raw === "" ? null : raw;
      });
      commentary.push({ operator: commentaryOp, category: normalizedCategory, values });
      continue;
    }

    const operator = normalizeOperator(operatorRaw);

    const { baseName, view } = splitKpi(kpiRaw);
    const values = quarterCols.map((c) => parseNumericCell(row[c]));

    series.push({ operator, baseName, view, unit, values });

    if (!seenOperators.has(operator)) {
      seenOperators.add(operator);
      operatorOrder.push(operator);
    }
  }

  const metricMap = new Map<string, { unit: string; views: Set<SeriesView> }>();
  for (const s of series) {
    const entry = metricMap.get(s.baseName) ?? { unit: s.unit, views: new Set<SeriesView>() };
    entry.views.add(s.view);
    if (!entry.unit) entry.unit = s.unit;
    metricMap.set(s.baseName, entry);
  }
  const metrics: MetricInfo[] = [...metricMap.entries()]
    .map(([baseName, v]) => ({ baseName, unit: v.unit, views: [...v.views] }))
    .sort((a, b) => a.baseName.localeCompare(b.baseName));

  // Drop trailing quarters that have no numeric data at all — the xlsx
  // pre-creates future quarter columns (e.g. 1Q2026–3Q2026) with empty cells.
  // If those columns are present, the dashboard would default to the last
  // empty period and show n/a for every metric. Trim to the last quarter
  // that has at least one non-null value across any series.
  let lastDataIdx = quarters.length - 1;
  for (let qi = quarters.length - 1; qi >= 0; qi--) {
    const hasData = series.some((s) => s.values[qi] != null);
    if (hasData) { lastDataIdx = qi; break; }
  }
  const trimmedQuarters = quarters.slice(0, lastDataIdx + 1);
  const trimmedSeries = series.map((s) => ({ ...s, values: s.values.slice(0, lastDataIdx + 1) }));
  // Commentary values are aligned to trimmedQuarters. The xlsx stores the text
  // in the last quarter column (which may be beyond lastDataIdx); if trimming
  // drops the text, rescue it by placing it at the new last position instead.
  const trimmedCommentary = commentary.map((c) => {
    const sliced = new Array<string | null>(lastDataIdx + 1).fill(null);
    for (let i = 0; i <= lastDataIdx && i < c.values.length; i++) sliced[i] = c.values[i];
    if (!sliced.some((v) => v !== null)) {
      // Text was stored beyond the trim point — move it to the last slot.
      const rescued = c.values.slice(lastDataIdx + 1).find((v) => v !== null) ?? null;
      if (rescued) sliced[lastDataIdx] = rescued;
    }
    return { ...c, values: sliced };
  });

  return { quarters: trimmedQuarters, operators: operatorOrder, series: trimmedSeries, metrics, commentary: trimmedCommentary };
}

// The commentary tab has its own (much shorter) header row — just Operator |
// KPI | Metrics | whichever quarter columns actually have commentary so far
// — so its quarter columns are mapped by label into the master quarters
// list (from the main tab) rather than assumed to line up positionally.
function parseCommentarySheet(csvText: string, masterQuarters: string[]): CommentarySeries[] {
  const rows = parseCsv(csvText);
  const headerIdx = rows.findIndex((r) => r.some((cell) => (cell ?? "").trim().toLowerCase() === "operator"));
  if (headerIdx === -1) return [];

  const header = rows[headerIdx];
  const operatorCol = header.findIndex((c) => (c ?? "").trim().toLowerCase() === "operator");
  const kpiCol = header.findIndex((c) => (c ?? "").trim().toLowerCase() === "kpi");
  if (operatorCol === -1 || kpiCol === -1) return [];

  const colToMasterIdx = new Map<number, number>();
  header.forEach((cell, c) => {
    const label = (cell ?? "").trim();
    const masterIdx = masterQuarters.findIndex((q) => q.toLowerCase() === label.toLowerCase());
    if (masterIdx !== -1) colToMasterIdx.set(c, masterIdx);
  });

  const commentary: CommentarySeries[] = [];
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    const operatorRaw = (row[operatorCol] ?? "").trim();
    const kpiRaw = (row[kpiCol] ?? "").trim();
    if (!operatorRaw || !kpiRaw) continue;

    const operator = normalizeOperator(operatorRaw);
    const values: (string | null)[] = new Array(masterQuarters.length).fill(null);
    colToMasterIdx.forEach((masterIdx, col) => {
      const raw = (row[col] ?? "").trim();
      values[masterIdx] = raw === "" ? null : raw;
    });
    commentary.push({ operator, category: cleanLabel(kpiRaw), values });
  }
  return commentary;
}

// Runs in the BROWSER, not on the server: Google's gviz endpoint reflects
// CORS for any origin, so fetching it client-side works. (A server-side
// fetch from this Worker is blocked by the hosting platform for this
// workspace's plan, so this is not merely a style choice.)
export async function fetchSummaryData(): Promise<SummaryData> {
  const response = await fetch(summaryCsvUrl());
  if (!response.ok) {
    throw new Error(
      `Failed to load the live Google Sheet (HTTP ${response.status}). Make sure the sheet is shared as "Anyone with the link — Viewer".`,
    );
  }
  const csvText = await response.text();
  const parsed = parseSummarySheet(csvText);

  // Commentary rows at the bottom of the main sheet are preferred (parsed
  // above). Only fall back to the separate commentary tab when the main sheet
  // has none — keeping the separate tab as an optional override.
  let commentary = parsed.commentary;
  if (commentary.length === 0) {
    try {
      const commentaryResponse = await fetch(commentaryCsvUrl());
      if (commentaryResponse.ok) {
        commentary = parseCommentarySheet(await commentaryResponse.text(), parsed.quarters);
      }
    } catch {
      /* ignore — commentary is non-critical */
    }
  }

  return {
    ...parsed,
    commentary,
    fetchedAt: new Date().toISOString(),
    sourceUrl: `https://docs.google.com/spreadsheets/d/${SUMMARY_FILE_ID}/edit`,
  };
}
