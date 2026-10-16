// willhaben.at über den Apify-Actor blackfalcondata/willhaben-all-scraper
// Getestet am 16.10.2026: startUrls mit willhaben-Suchfiltern werden übernommen,
// Felder: title, price, postCode, coordinates, immoRooms, immoLivingArea, immoFloor, immoFeatures, ...

import { apifyToken } from "../env.ts";
import { Candidate, CollectContext, SourceRow, parseNumber } from "./types.ts";

interface ApifyItem {
  listingId: string;
  title?: string;
  price?: number;
  priceText?: string;
  location?: string;
  postCode?: string;
  coordinates?: string;
  imageUrl?: string;
  imageUrls?: string[];
  isPrivateSeller?: boolean;
  sellerType?: string;
  sellerName?: string;
  publishedAt?: string;
  portalUrl?: string;
  immoType?: string;
  immoRooms?: number;
  immoLivingArea?: number;
  immoFloor?: number;
  immoOutdoorArea?: number;
  immoFeatures?: string[];
  immoOwnageType?: string;
  immoDescription?: string;
  descriptionMarkdown?: string;
  immoAvailableDate?: string;
  changeType?: string;
  expiredAt?: string;
  [k: string]: unknown;
}

export async function collectWillhaben(src: SourceRow, ctx: CollectContext): Promise<Candidate[]> {
  const token = apifyToken();
  if (!token) throw new Error("APIFY_TOKEN fehlt");
  const actor = String(src.config.actor ?? "blackfalcondata~willhaben-all-scraper");
  const maxResults = Number(src.config.maxResults ?? ctx.maxPerSource);
  const incremental = src.config.incremental !== false;
  const input: Record<string, unknown> = {
    startUrls: src.urls,
    maxResults,
    includeDetails: true,
    descriptionFormat: "text",
    excludeEmptyFields: true,
    incrementalMode: incremental,
    stateKey: String(src.config.stateKey ?? "wohnungsradar-wien"),
    emitUnchanged: false,
    emitExpired: incremental,
  };
  const url = `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}&timeout=170&memory=1024&clean=true&format=json`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 175000);
  let items: ApifyItem[] = [];
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Apify ${res.status}: ${text.slice(0, 300)}`);
    items = JSON.parse(text);
  } finally {
    clearTimeout(t);
  }
  ctx.log(`willhaben: ${items.length} Datensätze vom Actor`);
  const out: Candidate[] = [];
  for (const it of items) {
    if (!it.listingId) continue;
    if (it.changeType === "EXPIRED" || it.expiredAt) {
      out.push({ source: src.id, source_id: it.listingId, url: it.portalUrl ?? "", expired: true });
      continue;
    }
    if (!it.portalUrl) continue;
    const plz = it.postCode ?? null;
    const [lat, lng] = (it.coordinates ?? "").split(",").map((x) => parseFloat(x));
    const features = Array.isArray(it.immoFeatures) ? it.immoFeatures : [];
    const descr = it.immoDescription ?? it.descriptionMarkdown ?? "";
    const raw_text = [
      it.title, "", `Preis: ${it.priceText ?? it.price}`, `Ort: ${it.location ?? ""}`,
      it.immoType ? `Objekttyp: ${it.immoType}` : "",
      it.immoRooms ? `Zimmer: ${it.immoRooms}` : "",
      it.immoLivingArea ? `Wohnfläche: ${it.immoLivingArea} m²` : "",
      it.immoFloor !== undefined ? `Stockwerk: ${it.immoFloor}` : "",
      it.immoOutdoorArea ? `Freifläche: ${it.immoOutdoorArea} m²` : "",
      features.length ? `Ausstattung: ${features.join(", ")}` : "",
      it.sellerType ? `Anbieter: ${it.sellerType}${it.sellerName ? " – " + it.sellerName : ""}` : "",
      it.immoAvailableDate ? `Verfügbar: ${it.immoAvailableDate}` : "",
      "", descr,
    ].filter((x) => x !== undefined && x !== null).join("\n");
    out.push({
      source: src.id,
      source_id: it.listingId,
      url: it.portalUrl,
      title: it.title ?? null,
      price: typeof it.price === "number" ? Math.round(it.price) : parseNumber(it.priceText),
      area_m2: it.immoLivingArea ?? null,
      rooms: it.immoRooms ?? null,
      plz,
      address: it.location ?? null,
      lat: isFinite(lat) ? lat : null,
      lng: isFinite(lng) ? lng : null,
      floor: it.immoFloor !== undefined && it.immoFloor !== null ? String(it.immoFloor) : null,
      features,
      images: (it.imageUrls ?? (it.imageUrl ? [it.imageUrl] : [])).slice(0, 15),
      raw_text,
      raw: stripRaw(it),
      seller_type: it.isPrivateSeller ? "privat" : (it.sellerType ?? null),
      published_at: it.publishedAt ?? null,
    });
  }
  return out;
}

function stripRaw(it: ApifyItem): Record<string, unknown> {
  const drop = new Set(["immoContactPhone", "immoContactEmail", "extractedPhones", "immoContactName", "sellerId", "socialProfiles", "descriptionHtml"]);
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(it)) if (!drop.has(k)) o[k] = v;
  return o;
}
