// enrich: Geocoding, Lärm, Öffis, Grünraum, Preisvergleich, Widmung, Hochwasser, Links.
// Verarbeitet pro Aufruf eine Portion und ruft sich selbst erneut auf; danach "score".

import { admin, finishRun, getSetting, startRun } from "../_shared/db.ts";
import { authenticate, corsHeaders, json, triggerNext, unauthorized } from "../_shared/auth.ts";
import { sleep } from "../_shared/http.ts";
import { DISTRICT_CENTROIDS, GeoPoint, bboxAround, haversine, noiseFeatures, noiseLevel, nominatim, overpass, walkMinutes, wienWfs } from "../_shared/geo.ts";

interface Listing {
  id: string; title: string | null; price: number | null; area_m2: number | null; plz: string | null; district: number | null;
  address: string | null; lat: number | null; lng: number | null; raw_text: string | null; floor: string | null; raw: Record<string, unknown> | null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const caller = await authenticate(req);
  if (!caller) return unauthorized();
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* leer */ }

  const db = admin();
  const runId = await startRun("enrich");
  try {
    const batchSize = await getSetting<number>("enrich_batch", 6);
    const noiseApi = await getSetting<string>("noise_api", "https://gis.lfrz.gv.at/api/geodata/i000804/ogc/features/v1");
    const wfsBase = await getSetting<string>("wien_wfs", "https://data.wien.gv.at/daten/geo");

    let q = db.from("listings").select("id,title,price,area_m2,plz,district,address,lat,lng,raw_text,floor,raw")
      .eq("active", true).is("duplicate_of", null).order("first_seen", { ascending: false }).limit(batchSize);
    if (typeof body.listing_id === "string") q = db.from("listings").select("id,title,price,area_m2,plz,district,address,lat,lng,raw_text,floor,raw").eq("id", body.listing_id);
    else q = q.is("enriched_at", null);
    const { data: rows, error } = await q;
    if (error) throw error;
    const listings = (rows ?? []) as Listing[];

    const { data: prices } = await db.from("district_prices").select("*");
    const priceByDistrict = new Map<number, { avg_eur_m2: number; size_51_80: number | null; as_of: string; source: string }>();
    for (const p of prices ?? []) priceByDistrict.set(p.district, p);

    const results: Record<string, unknown> = {};
    for (const l of listings) {
      const errors: string[] = [];
      const e: Record<string, unknown> = {};
      try {
        // 1) Geocoding
        let point: GeoPoint | null = null;
        if (l.lat && l.lng) point = { lat: l.lat, lng: l.lng, precision: "given" };
        else point = await geocode(l, errors);
        if (point) {
          e.geocode = point;
          if (!l.lat || !l.lng) await db.from("listings").update({ lat: point.lat, lng: point.lng }).eq("id", l.id);
          const [lat, lng] = [point.lat, point.lng];

          // 2) Lärm (parallel), 3) Öffis, 4) Grün, 6) Widmung, 7) Hochwasser
          const [noise, transit, green, zoning, flood] = await Promise.all([
            noise_(noiseApi, lat, lng).catch((x) => { errors.push("noise: " + x); return null; }),
            transit_(lat, lng).catch((x) => { errors.push("transit: " + x); return null; }),
            green_(wfsBase, lat, lng).catch((x) => { errors.push("green: " + x); return null; }),
            zoning_(wfsBase, lat, lng).catch((x) => { errors.push("zoning: " + x); return null; }),
            flood_(wfsBase, lat, lng).catch((x) => { errors.push("flood: " + x); return null; }),
          ]);
          e.noise = noise; e.transit = transit; e.green = green; e.zoning = zoning; e.flood = flood;
          e.links = {
            streetview: `https://www.google.com/maps?q=&layer=c&cbll=${lat},${lng}&cbp=11,0,0,0,0`,
            maps: `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`,
            osm: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=18/${lat}/${lng}`,
            flaechenwidmung: `https://www.wien.gv.at/flaechenwidmung/public/`,
            stadtplan: `https://www.wien.gv.at/stadtplan/`,
            laermkarte: `https://www.laerminfo.at/laermkarten.html`,
            hora: `https://www.hora.gv.at/`,
          };
        } else {
          e.links = { flaechenwidmung: "https://www.wien.gv.at/flaechenwidmung/public/", laermkarte: "https://www.laerminfo.at/laermkarten.html", hora: "https://www.hora.gv.at/" };
        }
        // 5) Preis pro m² im Bezirksvergleich
        e.price_ctx = priceCtx(l, priceByDistrict);
        // 8) Himmelsrichtung/Stock aus dem Text
        e.orientation = orientation(l.raw_text ?? "");
      } catch (x) {
        errors.push("allgemein: " + String(x));
      }
      await db.from("enrichments").upsert({ listing_id: l.id, ...e, errors, updated_at: new Date().toISOString() });
      await db.from("listings").update({ enriched_at: new Date().toISOString(), score_stale: true }).eq("id", l.id);
      results[l.id] = { ok: errors.length === 0, errors: errors.slice(0, 5) };
    }

    const { count } = await db.from("listings").select("id", { count: "exact", head: true })
      .eq("active", true).is("duplicate_of", null).is("enriched_at", null);
    await finishRun(runId, true, { processed: listings.length, remaining: count ?? 0, results });
    if (!body.listing_id) {
      if ((count ?? 0) > 0 && listings.length > 0) triggerNext("enrich", {});
      else triggerNext("score", {});
    } else if (body.then === "score") triggerNext("score", { listing_id: body.listing_id });
    return json({ ok: true, processed: listings.length, remaining: count ?? 0 });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    await finishRun(runId, false, null, msg);
    return json({ ok: false, error: msg }, 500);
  }
});

async function geocode(l: Listing, errors: string[]): Promise<GeoPoint | null> {
  const db = admin();
  const candidates: string[] = [];
  const addr = (l.address ?? "").replace(/\s+/g, " ").trim();
  const textAddr = streetFromText(l.raw_text ?? "");
  if (addr && /\d/.test(addr)) candidates.push(addr.includes("Wien") ? addr : `${addr}, ${l.plz ?? ""} Wien`);
  if (textAddr) candidates.push(`${textAddr}, ${l.plz ?? ""} Wien`);
  if (addr && !/\d/.test(addr) && !/Bezirk/i.test(addr)) candidates.push(`${addr}, ${l.plz ?? ""} Wien`);
  if (l.plz) candidates.push(`${l.plz} Wien, Österreich`);
  for (const c of candidates) {
    const key = c.toLowerCase();
    const { data: cached } = await db.from("geocode_cache").select("*").eq("address", key).maybeSingle();
    if (cached) {
      if (cached.lat && cached.lng) return { lat: cached.lat, lng: cached.lng, display: cached.display, precision: c.includes("Österreich") ? "plz" : "exact" };
      continue;
    }
    await sleep(1100); // Nominatim-Regel: höchstens 1 Anfrage pro Sekunde
    const p = await nominatim(c);
    await db.from("geocode_cache").upsert({ address: key, lat: p?.lat ?? null, lng: p?.lng ?? null, display: p?.display ?? null });
    if (p) {
      if (c.includes("Österreich")) p.precision = "plz";
      return p;
    }
  }
  if (l.district && DISTRICT_CENTROIDS[l.district]) {
    const [lat, lng] = DISTRICT_CENTROIDS[l.district];
    errors.push("geocode: Adresse nicht gefunden, Bezirksmittelpunkt verwendet");
    return { lat, lng, display: `${l.district}. Bezirk (Mittelpunkt)`, precision: "plz" };
  }
  errors.push("geocode: keine Koordinaten für " + candidates.join(" / "));
  return null;
}

function streetFromText(t: string): string | null {
  const m = t.match(/\b([A-ZÄÖÜ][\wäöüß.-]{2,}(?:gasse|straße|strasse|platz|weg|ring|zeile|allee|promenade|steig|markt|hof|kai|lände|gürtel))\s+(\d{1,4}[a-zA-Z]?)\b/);
  return m ? `${m[1]} ${m[2]}` : null;
}

async function noise_(api: string, lat: number, lng: number) {
  const bbox = bboxAround(lat, lng, 25);
  const out: Record<string, unknown> = {};
  const colls: [string, string][] = [
    ["strasse_tag", "i000804:laerm_2022_strasse_lden"], ["strasse_nacht", "i000804:laerm_2022_strasse_lnight"],
    ["schiene_tag", "i000804:laerm_2022_schiene_lden"], ["schiene_nacht", "i000804:laerm_2022_schiene_lnight"],
  ];
  const res = await Promise.all(colls.map(([, c]) => noiseFeatures(api, c, bbox).catch(() => null)));
  res.forEach((feats, i) => {
    const [k] = colls[i];
    if (feats === null) { out[k] = null; return; }
    const lv = noiseLevel(feats);
    out[k] = feats.length ? { db: lv.db, label: lv.label, props: lv.props } : { db: null, label: "keine Lärmzone (unter Kartierungsschwelle)" };
  });
  // Straßen- und Bahnnähe aus OSM als zweiter Indikator
  const q = `[out:json][timeout:12];(way(around:70,${lat},${lng})[highway~"^(motorway|trunk|primary|secondary|tertiary)$"];way(around:150,${lat},${lng})[railway~"^(rail|light_rail|tram)$"];);out tags center;`;
  const osm = await overpass(q);
  if (osm) {
    const roads = osm.elements.filter((e) => (e.tags as Record<string, string>)?.highway).map((e) => {
      const t = e.tags as Record<string, string>;
      const c = e.center as { lat: number; lon: number } | undefined;
      return { name: t.name ?? "", type: t.highway, dist_m: c ? Math.round(haversine(lat, lng, c.lat, c.lon)) : null };
    });
    const rails = osm.elements.filter((e) => (e.tags as Record<string, string>)?.railway).map((e) => {
      const t = e.tags as Record<string, string>;
      const c = e.center as { lat: number; lon: number } | undefined;
      return { name: t.name ?? "", type: t.railway, dist_m: c ? Math.round(haversine(lat, lng, c.lat, c.lon)) : null };
    });
    out.osm = { hauptstrassen: roads.slice(0, 5), bahn: rails.slice(0, 5) };
    const maxDb = Math.max(...["strasse_tag", "schiene_tag"].map((k) => ((out[k] as { db: number | null })?.db) ?? 0));
    out.einschaetzung = maxDb >= 65 || roads.some((r) => /motorway|trunk|primary/.test(r.type) && (r.dist_m ?? 99) < 50)
      ? "laut" : maxDb >= 55 || roads.length > 0 || rails.length > 0 ? "mittel" : "ruhig";
  } else {
    const maxDb = Math.max(...["strasse_tag", "schiene_tag"].map((k) => ((out[k] as { db: number | null })?.db) ?? 0));
    out.einschaetzung = maxDb >= 65 ? "laut" : maxDb >= 55 ? "mittel" : maxDb > 0 ? "eher ruhig" : "unbekannt";
  }
  return out;
}

async function transit_(lat: number, lng: number) {
  const db = admin();
  const { data } = await db.rpc("nearest_stops", { p_lat: lat, p_lng: lng, p_limit: 12 });
  const stops = (data ?? []) as Array<{ stop_id: string; name: string; modes: string[]; lines: string[]; dist_m: number }>;
  const pick = (pred: (m: string[]) => boolean) => {
    const s = stops.filter((x) => pred(x.modes ?? []))[0];
    return s ? { name: s.name, lines: s.lines, dist_m: s.dist_m, minuten: walkMinutes(s.dist_m) } : null;
  };
  let ubahn = pick((m) => m.includes("ptMetro"));
  let bim = pick((m) => m.some((x) => /tram/i.test(x)));
  let bus = pick((m) => m.some((x) => /bus/i.test(x)));
  if (!stops.length) {
    // Fallback über OSM
    const q = `[out:json][timeout:12];(node(around:1200,${lat},${lng})[station=subway];node(around:1200,${lat},${lng})[railway=station][station=subway];node(around:800,${lat},${lng})[railway=tram_stop];);out body;`;
    const osm = await overpass(q);
    if (osm) {
      const els = osm.elements.map((e) => ({ tags: e.tags as Record<string, string>, lat: e.lat as number, lon: e.lon as number }))
        .map((e) => ({ name: e.tags?.name ?? "", kind: e.tags?.station === "subway" || e.tags?.subway === "yes" ? "U" : "Bim", dist_m: Math.round(haversine(lat, lng, e.lat, e.lon)) }))
        .sort((a, b) => a.dist_m - b.dist_m);
      const u = els.find((e) => e.kind === "U"), b = els.find((e) => e.kind === "Bim");
      ubahn = u ? { name: u.name, lines: [], dist_m: u.dist_m, minuten: walkMinutes(u.dist_m) } : null;
      bim = b ? { name: b.name, lines: [], dist_m: b.dist_m, minuten: walkMinutes(b.dist_m) } : null;
      bus = null;
    }
  }
  return { ubahn, bim, bus, quelle: stops.length ? "Wiener Linien OGD" : "OpenStreetMap" };
}

async function green_(wfs: string, lat: number, lng: number) {
  const feats = await wienWfs(wfs, "ogdwien:OEFFGRUENFLOGD", bboxAround(lat, lng, 300), 100);
  const trees = await wienWfs(wfs, "ogdwien:BAUMKATOGD", bboxAround(lat, lng, 120), 150).catch(() => null);
  if (feats === null) return null;
  const names = feats.map((f) => String(f.properties?.ANL_NAME ?? f.properties?.NAME ?? f.properties?.BEZEICHNUNG ?? f.properties?.KATEGORIE ?? "Grünfläche")).filter(Boolean);
  const uniq = [...new Set(names)].slice(0, 8);
  return {
    gruenflaechen_300m: feats.length,
    namen: uniq,
    baeume_120m: trees ? trees.length : null,
    einschaetzung: feats.length >= 3 ? "viel Grün" : feats.length >= 1 ? "etwas Grün" : "wenig Grün",
  };
}

async function zoning_(wfs: string, lat: number, lng: number) {
  const feats = await wienWfs(wfs, "ogdwien:GENFLWIDMUNGOGD", bboxAround(lat, lng, 8), 5);
  if (feats === null) return null;
  const f = feats[0];
  if (!f) return { widmung: null };
  const p = f.properties ?? {};
  return { widmung: p.WIDMUNG ?? p.WIDMUNG_TXT ?? p.NUTZUNG ?? p.BEZEICHNUNG ?? null, props: p };
}

async function flood_(wfs: string, lat: number, lng: number) {
  const [gef, flut] = await Promise.all([
    wienWfs(wfs, "ogdwien:HWGEFAHROGD", bboxAround(lat, lng, 10), 5).catch(() => null),
    wienWfs(wfs, "ogdwien:HWASSERFLUTOGD", bboxAround(lat, lng, 10), 5).catch(() => null),
  ]);
  if (gef === null && flut === null) return null;
  const zone = gef?.[0]?.properties ?? null;
  const ueberflutung = flut?.[0]?.properties ?? null;
  return {
    gefahrenzone: zone ? (zone.ZONE ?? zone.GEFAHRENZONE ?? zone.BEZEICHNUNG ?? JSON.stringify(zone).slice(0, 120)) : null,
    ueberflutungsflaeche: ueberflutung ? (ueberflutung.BEZEICHNUNG ?? ueberflutung.NAME ?? JSON.stringify(ueberflutung).slice(0, 120)) : null,
    einschaetzung: zone || ueberflutung ? "in Hochwasserzone/-fläche laut Wien OGD" : "keine Hochwasserzone laut Wien OGD",
  };
}

function priceCtx(l: Listing, prices: Map<number, { avg_eur_m2: number; size_51_80: number | null; as_of: string; source: string }>) {
  if (!l.price || !l.area_m2 || !l.district) return null;
  const p = prices.get(l.district);
  if (!p) return null;
  const eur_m2 = Math.round(l.price / l.area_m2);
  const ref = (l.area_m2 >= 51 && l.area_m2 <= 80 && p.size_51_80) ? p.size_51_80 : p.avg_eur_m2;
  const ratio = eur_m2 / ref;
  return {
    eur_m2, bezirk_schnitt: p.avg_eur_m2, bezirk_referenz: ref, verhaeltnis: Math.round(ratio * 100) / 100,
    einschaetzung: ratio <= 0.75 ? "deutlich unter Bezirksschnitt" : ratio <= 0.95 ? "unter Bezirksschnitt" : ratio <= 1.1 ? "im Bezirksschnitt" : "über Bezirksschnitt",
    stand: p.as_of, quelle: p.source,
  };
}

function orientation(t: string): string | null {
  const m = t.match(/\b(Süd(?:west|ost)?|Nord(?:west|ost)?|West|Ost)(?:ausrichtung|seite|lage|-?orientiert|balkon|terrasse)?\b/i);
  const s = t.match(/\b(\d{1,2})\.\s*(Stock|OG|Obergeschoss|Etage|Liftstock)\b/i) ?? t.match(/\b(Erdgeschoss|EG|Dachgeschoss|DG|Hochparterre|Mezzanin)\b/i);
  const parts = [];
  if (m) parts.push("Ausrichtung " + m[1]);
  if (s) parts.push(s[2] ? `${s[1]}. Stock` : s[1]);
  return parts.length ? parts.join(", ") : null;
}
