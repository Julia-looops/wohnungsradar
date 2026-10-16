// Generischer Sammler für Portale, Bauträger und Genossenschaften:
// 1) Listenseite laden, 2) Inserate über JSON-LD oder – als Fallback – über Claude (Haiku) aus Text+Links ziehen,
// 3) neue Detailseiten laden und strukturiert extrahieren.

import { fetchText, mapLimit } from "../http.ts";
import { extractImages, extractJsonLd, extractLinks, htmlToText, metaContent, titleOf } from "../html.ts";
import { askClaudeJson } from "../claude.ts";
import { Candidate, CollectContext, SourceRow, findPlz, parseEuro, parseNumber } from "./types.ts";

interface ListHit { url: string; title?: string; price?: number | null; area_m2?: number | null; rooms?: number | null; plz?: string | null; note?: string }

export async function collectGeneric(src: SourceRow, ctx: CollectContext): Promise<Candidate[]> {
  const pages = Math.max(1, Math.min(4, Number(src.config.pages ?? 1)));
  const urls: string[] = [];
  for (const u of src.urls) {
    if (u.includes("{page}")) for (let p = 1; p <= pages; p++) urls.push(u.replace("{page}", String(p)));
    else urls.push(u);
  }
  const hits = new Map<string, ListHit>();
  const errors: string[] = [];
  for (const u of urls) {
    const r = await fetchText(u, { timeoutMs: 25000 });
    if (!r.ok || r.text.length < 500) {
      errors.push(`${u}: HTTP ${r.status} (${r.text.length} Zeichen)`);
      continue;
    }
    const host = new URL(r.url).host;
    const fromLd = listFromJsonLd(r.text, r.url);
    for (const h of fromLd) if (sameSite(h.url, host) && !hits.has(h.url)) hits.set(h.url, h);
    if (fromLd.length < 3) {
      const fromAi = await listFromClaude(src, r.text, r.url, ctx);
      for (const h of fromAi) if (!hits.has(h.url)) hits.set(h.url, h);
    }
  }
  if (hits.size === 0 && errors.length) throw new Error(errors.join(" | ").slice(0, 900));
  ctx.log(`${src.id}: ${hits.size} Treffer auf Listenseiten`);

  // Vorfilter: Preis bekannt und zu hoch → weg; PLZ bekannt und nicht erlaubt → weg
  const list = [...hits.values()].filter((h) => {
    if (h.price && h.price > ctx.maxPrice * 1.02) return false;
    if (h.plz && !ctx.allowedPlz.has(h.plz)) return false;
    return true;
  });

  const known = list.filter((h) => ctx.knownUrls.has(h.url));
  const fresh = list.filter((h) => !ctx.knownUrls.has(h.url)).slice(0, Math.min(ctx.maxPerSource, 15));
  const out: Candidate[] = known.map((h) => ({ source: src.id, source_id: idOf(h.url), url: h.url }));

  const details = await mapLimit(fresh, 3, async (h) => {
    try {
      return await detail(src, h, ctx);
    } catch (e) {
      ctx.log(`${src.id}: Detail fehlgeschlagen ${h.url}: ${String(e).slice(0, 120)}`);
      return null;
    }
  });
  for (const d of details) if (d) out.push(d);
  if (errors.length) ctx.log(`${src.id}: Fehler ${errors.join(" | ").slice(0, 300)}`);
  return out;
}

function sameSite(u: string, host: string): boolean {
  try { return new URL(u).host.replace(/^www\./, "") === host.replace(/^www\./, ""); } catch { return false; }
}

export function idOf(url: string): string {
  // kurzer stabiler Hash der URL (FNV-1a 32bit ×2)
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < url.length; i++) {
    const c = url.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x9e3779b1) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

// deno-lint-ignore no-explicit-any
function listFromJsonLd(html: string, base: string): ListHit[] {
  const out: ListHit[] = [];
  const nodes = extractJsonLd(html) as any[];
  const visit = (n: any) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) { n.forEach(visit); return; }
    const type = String(n["@type"] ?? "");
    if (n.itemListElement) visit(n.itemListElement);
    if (n["@graph"]) visit(n["@graph"]);
    if (n.item) visit(n.item);
    const url = n.url ?? n["@id"];
    if (url && /RealEstateListing|Apartment|Product|Offer|Residence|Accommodation|House|SingleFamilyResidence/i.test(type)) {
      try {
        const abs = new URL(String(url), base).toString();
        const price = parseEuro(n.offers?.price ?? n.price ?? n.offers?.[0]?.price);
        const area = parseNumber(n.floorSize?.value ?? n.floorSize);
        const rooms = parseNumber(n.numberOfRooms);
        const plz = n.address?.postalCode ?? findPlz(JSON.stringify(n.address ?? ""));
        out.push({ url: abs, title: n.name, price, area_m2: area, rooms, plz: plz ? String(plz) : null });
      } catch { /* ignore */ }
    }
  };
  visit(nodes);
  return out;
}

async function listFromClaude(src: SourceRow, html: string, base: string, ctx: CollectContext): Promise<ListHit[]> {
  const text = htmlToText(html, 28000);
  const links = extractLinks(html, base)
    .filter((l) => sameSite(l.href, new URL(base).host))
    .filter((l) => !/\/(login|register|impressum|datenschutz|agb|kontakt|karriere|jobs|news|blog|magazin|presse)\b/i.test(l.href))
    .slice(0, 250)
    .map((l) => `${l.href} | ${l.text.slice(0, 90)}`)
    .join("\n");
  const hint = src.config.hint ? `Hinweis zur Quelle: ${src.config.hint}\n` : "";
  const project = src.config.project ? "Diese Seite ist eine Bauträger- oder Genossenschaftsseite: Projekte oder einzelne Wohnungen gelten als Inserat, wenn sie in Wien liegen und zum Kauf (Eigentum) angeboten werden.\n" : "";
  const prompt = `Du extrahierst Immobilieninserate aus einer Listenseite. Gesucht: Eigentumswohnungen zum KAUF in WIEN (keine Miete, keine Häuser, keine Gewerbeobjekte, keine Grundstücke, keine Anleger-/Vorsorgewohnungen falls erkennbar).
Kaufpreis-Obergrenze: ${ctx.maxPrice} EUR (höhere Preise weglassen; unbekannter Preis ist erlaubt). Mindestfläche ca. ${ctx.minArea} m² (unbekannt erlaubt).
${hint}${project}
Antworte NUR mit JSON: {"listings":[{"url":"...","title":"...","price":123000,"area_m2":55,"rooms":2,"plz":"1070","note":"..."}]}
- "url" muss exakt einer der unten gelisteten Links sein (Detailseite des Inserats/Projekts), sonst weglassen.
- Zahlen als Zahl oder null. plz als 4-stellige Wiener PLZ oder null.
- Maximal 40 Einträge. Wenn keine passenden Inserate: {"listings":[]}

=== SEITENTEXT (${new URL(base).host}) ===
${text}

=== LINKS (href | Linktext) ===
${links}`;
  const { value } = await askClaudeJson<{ listings: ListHit[] }>(prompt, { model: ctx.extractModel, maxTokens: 4000, temperature: 0 });
  const arr = Array.isArray(value?.listings) ? value!.listings : [];
  const out: ListHit[] = [];
  for (const h of arr) {
    if (!h?.url) continue;
    try {
      const abs = new URL(String(h.url), base).toString().replace(/#.*$/, "");
      out.push({ url: abs, title: h.title, price: parseEuro(h.price), area_m2: parseNumber(h.area_m2), rooms: parseNumber(h.rooms), plz: h.plz ? findPlz(String(h.plz)) : null, note: h.note });
    } catch { /* ignore */ }
  }
  return out;
}

interface DetailExtract {
  title?: string; price?: number | null; area_m2?: number | null; rooms?: number | null; plz?: string | null; address?: string | null;
  floor?: string | null; features?: string[]; seller_type?: string | null; is_sale?: boolean; is_vienna?: boolean; summary?: string | null;
}

async function detail(src: SourceRow, h: ListHit, ctx: CollectContext): Promise<Candidate | null> {
  const r = await fetchText(h.url, { timeoutMs: 25000 });
  if (!r.ok || r.text.length < 300) {
    // Detailseite nicht erreichbar: trotzdem mit Listendaten aufnehmen
    return baseCandidate(src, h, null, [], `${h.title ?? ""}\n${h.note ?? ""}`.trim());
  }
  const html = r.text;
  const text = htmlToText(html, 20000);
  const images = extractImages(html, r.url, 12);
  const og = metaContent(html, "og:title") ?? titleOf(html) ?? h.title;
  const prompt = `Extrahiere aus dem Text einer Immobilien-Detailseite die Fakten als JSON. Nichts erfinden; unbekannt = null.
{"title":"...","is_sale":true,"is_vienna":true,"price":123000,"area_m2":55.5,"rooms":2,"plz":"1070","address":"Straße Nr, 1070 Wien","floor":"3. Stock","features":["Lift","Balkon","Keller","Badewanne","Abstellraum","Loggia","Terrasse","Garage","provisionsfrei","Erstbezug","sanierungsbedürftig","vermietet","Anlegerwohnung"],"seller_type":"privat|makler|bauträger|genossenschaft|gericht|null","summary":"2 Sätze: worum es geht, Zustand, Besonderheiten"}
- price = Kaufpreis in EUR (bei Versteigerung der Schätzwert), nicht Miete, nicht Provision.
- features nur, wenn im Text belegt. is_sale = Kauf/Eigentum (nicht Miete). is_vienna = Objekt liegt in Wien.

=== TEXT ===
${text}`;
  let ex: DetailExtract | null = null;
  try {
    const { value } = await askClaudeJson<DetailExtract>(prompt, { model: ctx.extractModel, maxTokens: 1200, temperature: 0 });
    ex = value;
  } catch (e) {
    ctx.log(`${src.id}: Extraktion fehlgeschlagen ${h.url}: ${String(e).slice(0, 100)}`);
  }
  if (ex && (ex.is_sale === false || ex.is_vienna === false)) return null;
  const merged: ListHit = {
    url: h.url,
    title: ex?.title ?? og ?? h.title,
    price: parseEuro(ex?.price) ?? h.price ?? null,
    area_m2: parseNumber(ex?.area_m2) ?? h.area_m2 ?? null,
    rooms: parseNumber(ex?.rooms) ?? h.rooms ?? null,
    plz: (ex?.plz ? findPlz(String(ex.plz)) : null) ?? h.plz ?? findPlz(ex?.address) ?? findPlz(text.slice(0, 3000)),
  };
  const c = baseCandidate(src, merged, ex, images, text);
  return c;
}

function baseCandidate(src: SourceRow, h: ListHit, ex: DetailExtract | null, images: string[], text: string): Candidate {
  return {
    source: src.id,
    source_id: idOf(h.url),
    url: h.url,
    title: h.title ?? null,
    price: h.price ?? null,
    area_m2: h.area_m2 ?? null,
    rooms: h.rooms ?? null,
    plz: h.plz ?? null,
    address: ex?.address ?? null,
    floor: ex?.floor ?? null,
    features: Array.isArray(ex?.features) ? ex!.features!.map(String).slice(0, 30) : [],
    images,
    raw_text: text.slice(0, 20000),
    raw: ex ? { extract: ex, list: h } : { list: h },
    seller_type: ex?.seller_type ?? null,
  };
}
