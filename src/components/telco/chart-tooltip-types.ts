export interface Series {
  name: string;
  color: string;
  data: (number | null)[];
}

export interface TipRow {
  name: string;
  color: string;
  value: number | null;
}

export interface TipState {
  chart: string;
  idx: number;
  label: string;
  rows: TipRow[];
  vfmt: (v: number | null) => string;
  px: number;
  py: number;
}
