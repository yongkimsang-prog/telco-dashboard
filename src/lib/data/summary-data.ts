// ---------------------------------------------------------------------------
// Live data source: IRO telco stats V3.xlsx stored in Google Drive, shared
// as "Anyone with the link — Viewer". The Summary sheet is the single source
// of truth; editing it there is reflected here on the next fetch.
// ---------------------------------------------------------------------------
const SUMMARY_FILE_ID = "1_tBU2uRyVcNOu1r7LcYhwqYJRPYR6p9w";
const SUMMARY_SHEET_NAME = "Summary";

function summaryCsvUrl(): string {
  return `https://docs.google.com/spreadsheets/d/${SUMMARY_FILE_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(SUMMARY_SHEET_NAME)}`;
}

// gviz infers column types from dominant data. Quarter columns (D–AD) are
// mostly numeric, so gviz strips text values in commentary rows. Fix: fetch
// only the commentary rows in isolation — in that narrow range all quarter
// cells are text, so gviz types them as text and returns them correctly.
// 3 operators × 5 categories = 15 commentary rows at the bottom of the sheet.
const COMMENTARY_ROW_COUNT = 15;

function commentaryRangeUrl(rangeStart: number, rangeEnd: number, lastCol: string): string {
  return (
    `https://docs.google.com/spreadsheets/d/${SUMMARY_FILE_ID}/gviz/tq` +
    `?tqx=out:csv&sheet=${encodeURIComponent(SUMMARY_SHEET_NAME)}` +
    `&range=A${rangeStart}:${lastCol}${rangeEnd}&headers=0`
  );
}

// Convert 1-based column number to Excel letter(s): 1→A, 26→Z, 27→AA, 30→AD
function columnLetter(n: number): string {
  let s = "";
  while (n > 0) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); }
  return s;
}

// Parse commentary rows from a headerless gviz range response.
// Columns: 0=Operator, 1=KPI, 2=Metrics, 3..=(quarter values in master order).
function parseCommentaryRows(rows: string[][], masterQuarters: string[]): CommentarySeries[] {
  const result: CommentarySeries[] = [];
  for (const row of rows) {
    const operatorRaw = (row[0] ?? "").trim();
    const kpiRaw = (row[1] ?? "").trim();
    if (!operatorRaw || !kpiRaw) continue;
    const kpiClean = cleanLabel(kpiRaw);
    const unit = cleanLabel((row[2] ?? "").trim());
    if (unit.toLowerCase() !== "commentary" && !COMMENTARY_KPI_KEYS.has(kpiClean)) continue;
    const operator = normalizeOperator(operatorRaw);
    const normalizedCategory = COMMENTARY_CATEGORY_ALIASES[kpiClean] ?? kpiClean;
    const values: (string | null)[] = new Array(masterQuarters.length).fill(null);
    for (let qi = 0; qi < masterQuarters.length; qi++) {
      const raw = (row[qi + 3] ?? "").trim();
      if (raw) values[qi] = raw;
    }
    result.push({ operator, category: normalizedCategory, values });
  }
  return result;
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



// Runs in the BROWSER: Google's gviz endpoint supports CORS for public files.
export async function fetchSummaryData(): Promise<SummaryData> {
  const response = await fetch(summaryCsvUrl());
  if (!response.ok) {
    throw new Error(
      `Failed to load the live Google Sheet (HTTP ${response.status}). Make sure the sheet is shared as "Anyone with the link — Viewer".`,
    );
  }
  const csvText = await response.text();
  const rawRows = parseCsv(csvText);
  const totalSheetRows = rawRows.length; // header row + data rows + commentary rows
  const parsed = parseSummarySheet(csvText);

  // gviz strips text values from numeric-typed columns (quarter columns are
  // typed numeric since most rows have numbers), so commentary text arrays
  // from parseSummarySheet are empty. Fix: re-fetch just the last
  // COMMENTARY_ROW_COUNT rows in a separate gviz range query. In that narrow
  // range every quarter cell is text, so gviz types those columns as text and
  // returns the values correctly.
  let commentary = parsed.commentary;
  if (totalSheetRows > COMMENTARY_ROW_COUNT) {
    const rangeStart = totalSheetRows - COMMENTARY_ROW_COUNT + 1;
    const lastCol = columnLetter(3 + parsed.quarters.length); // "AD" for 27 quarters
    const url = commentaryRangeUrl(rangeStart, totalSheetRows, lastCol);
    try {
      const r = await fetch(url);
      if (r.ok) {
        commentary = parseCommentaryRows(parseCsv(await r.text()), parsed.quarters);
      }
    } catch {
      /* non-critical — fall back to empty commentary */
    }
  }

  return {
    ...parsed,
    commentary,
    fetchedAt: new Date().toISOString(),
    sourceUrl: `https://docs.google.com/spreadsheets/d/${SUMMARY_FILE_ID}/edit`,
  };
}
