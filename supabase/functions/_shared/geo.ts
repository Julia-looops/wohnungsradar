// Geodaten-Hilfen: Nominatim, Wien-WFS, Lärm (Umgebungslärmkartierung), Overpass

import { fetchJson, fetchText } from "./http.ts";

const NOMINATIM_UA = "wohnungsradar-wien/1.0 (private Wohnungssuche; Kontakt über GitHub Julia-looops/wohnungsradar)";

export interface GeoPoint { lat: number; lng: number; display?: string; precision: "exact" | "street" | "plz" | "given" }

export async function nominatim(query: string): Promise<GeoPoint | null> {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=at&addressdetails=1&q=${encodeURIComponent(query)}`;
  const r = await fetchJson<Array<{ lat: string; lon: string; display_name: string; type?: string; class?: string; addresstype?: string }>>(url, {
    headers: { "User-Agent": NOMINATIM_UA, "Accept-Language": "de" }, timeoutMs: 15000,
  });
  if (!r || !r.length) return null;
  const hit = r[0];
  const lat = parseFloat(hit.lat), lng = parseFloat(hit.lon);
  if (!isFinite(lat) || !isFinite(lng)) return null;
  const at = hit.addresstype ?? hit.type ?? "";
  const precision: GeoPoint["precision"] = /house|building|residential|apartments/.test(at) ? "exact" : /road|street|pedestrian/.test(at) ? "street" : "plz";
  return { lat, lng, display: hit.display_name, precision };
}

export function bboxAround(lat: number, lng: number, meters: number): [number, number, number, number] {
  const dLat = meters / 111320;
  const dLng = meters / (111320 * Math.cos((lat * Math.PI) / 180));
  return [lng - dLng, lat - dLat, lng + dLng, lat + dLat];
}

export interface WfsFeature { id?: string; properties: Record<string, unknown>; geometry?: unknown }

/** Wien Open Data WFS (GeoServer), WFS 1.0.0 → bbox immer lon,lat */
export async function wienWfs(base: string, layer: string, bbox: [number, number, number, number], max = 200): Promise<WfsFeature[] | null> {
  const url = `${base}?service=WFS&version=1.0.0&request=GetFeature&typeName=${encodeURIComponent(layer)}&srsName=EPSG:4326&outputFormat=json&maxFeatures=${max}&bbox=${bbox.map((n) => n.toFixed(6)).join(",")}`;
  const r = await fetchJson<{ features?: WfsFeature[] }>(url, { timeoutMs: 20000 });
  if (!r || !Array.isArray(r.features)) return null;
  return r.features;
}

/** OGC API Features (LFRZ, Umgebungslärmkartierung 2022) */
export async function noiseFeatures(api: string, collection: string, bbox: [number, number, number, number]): Promise<WfsFeature[] | null> {
  const url = `${api.replace(/\/$/, "")}/collections/${encodeURIComponent(collection)}/items?f=json&limit=10&bbox=${bbox.map((n) => n.toFixed(6)).join(",")}`;
  const r = await fetchJson<{ features?: WfsFeature[] }>(url, { timeoutMs: 20000, headers: { Accept: "application/geo+json, application/json" } });
  if (!r || !Array.isArray(r.features)) return null;
  return r.features;
}

/** Aus Lärmzonen-Properties den dB-Wert (Untergrenze der Klasse) herausziehen */
export function noiseLevel(features: WfsFeature[]): { db: number | null; label: string | null; props: Record<string, unknown> | null } {
  let best: number | null = null;
  let label: string | null = null;
  let props: Record<string, unknown> | null = null;
  for (const f of features) {
    const p = f.properties ?? {};
    let val: number | null = null;
    let lab: string | null = null;
    for (const [k, v] of Object.entries(p)) {
      const key = k.toLowerCase();
      if (/(db_lo|dblow|db_low|pegel_von|lden|lnight|db|pegel|klasse|category|noise|wert|low)/.test(key)) {
        if (typeof v === "number" && v >= 35 && v <= 90) { val = Math.max(val ?? 0, v); }
        else if (typeof v === "string") {
          const m = v.match(/(\d{2})/);
          if (m) { const n = parseInt(m[1], 10); if (n >= 35 && n <= 90) { val = Math.max(val ?? 0, n); lab = v; } }
        }
      }
    }
    if (val !== null && (best === null || val > best)) { best = val; label = lab; props = p; }
  }
  return { db: best, label, props };
}

/** Overpass: Hauptstraßen und Bahn in der Nähe (Lärm-Indikator) und Öffi-Haltestellen als Fallback */
export async function overpass(query: string): Promise<{ elements: Array<Record<string, unknown>> } | null> {
  const r = await fetchText("https://overpass-api.de/api/interpreter", {
    method: "POST", timeoutMs: 15000, body: "data=" + encodeURIComponent(query),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  if (!r.ok) return null;
  try { return JSON.parse(r.text); } catch { return null; }
}

export function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function walkMinutes(meters: number): number {
  return Math.round((meters * 1.25) / 80); // Umwegfaktor 1,25 und 4,8 km/h
}
