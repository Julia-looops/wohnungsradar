export interface Candidate {
  source: string;
  source_id: string;
  url: string;
  title?: string | null;
  price?: number | null;
  area_m2?: number | null;
  rooms?: number | null;
  plz?: string | null;
  address?: string | null;
  lat?: number | null;
  lng?: number | null;
  floor?: string | null;
  features?: string[];
  images?: string[];
  raw_text?: string | null;
  raw?: unknown;
  seller_type?: string | null;
  published_at?: string | null;
  expired?: boolean;
}

export interface SourceRow {
  id: string;
  name: string;
  kind: "apify" | "html" | "ai";
  urls: string[];
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface CollectContext {
  maxPrice: number;
  minArea: number;
  allowedPlz: Set<string>;
  knownUrls: Set<string>;
  maxPerSource: number;
  extractModel: string;
  log: (msg: string) => void;
}

export function parseEuro(s: unknown): number | null {
  if (s === null || s === undefined) return null;
  if (typeof s === "number") return isFinite(s) ? Math.round(s) : null;
  const str = String(s).replace(/\s/g, "");
  const m = str.match(/(\d{1,3}(?:[.,]\d{3})+|\d{4,})(?:,\d+)?/);
  if (!m) return null;
  const n = parseInt(m[1].replace(/[.,]/g, ""), 10);
  return isFinite(n) ? n : null;
}

export function parseNumber(s: unknown): number | null {
  if (s === null || s === undefined) return null;
  if (typeof s === "number") return isFinite(s) ? s : null;
  const m = String(s).replace(/\s/g, "").match(/(\d+(?:[.,]\d+)?)/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(",", "."));
  return isFinite(n) ? n : null;
}

export function findPlz(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = s.match(/\b(1[0-2]\d0)\b/);
  return m ? m[1] : null;
}

export function dedupeKey(c: { plz?: string | null; area_m2?: number | null; price?: number | null }): string | null {
  if (!c.plz || !c.area_m2 || !c.price) return null;
  return `${c.plz}|${Math.round(c.area_m2)}|${Math.round(c.price / 1000)}`;
}
