// HTML → Text, Links, JSON-LD, Bilder. Ohne DOM-Bibliothek, robust gegen kaputtes Markup.

export function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&euro;/g, "€")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&ouml;/g, "ö").replace(/&auml;/g, "ä").replace(/&uuml;/g, "ü").replace(/&szlig;/g, "ß")
    .replace(/&Ouml;/g, "Ö").replace(/&Auml;/g, "Ä").replace(/&Uuml;/g, "Ü");
}

/** Sichtbaren Text extrahieren (Skripte/Styles raus, Blockelemente als Zeilenumbruch). */
export function htmlToText(html: string, maxLen = 60000): string {
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|br|dd|dt|td|th|header|footer|ul|ol|table)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  s = decodeEntities(s)
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

export interface Link { href: string; text: string }

/** Alle Links mit Linktext, absolut gemacht. */
export function extractLinks(html: string, baseUrl: string): Link[] {
  const out: Link[] = [];
  const re = /<a\b[^>]*?href\s*=\s*["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  const seen = new Set<string>();
  while ((m = re.exec(html)) !== null) {
    let href = decodeEntities(m[1].trim());
    if (/^(javascript:|mailto:|tel:)/i.test(href)) continue;
    try { href = new URL(href, baseUrl).toString(); } catch { continue; }
    href = href.replace(/#.*$/, "");
    if (seen.has(href)) continue;
    seen.add(href);
    const text = htmlToText(m[2], 300).replace(/\n+/g, " ").trim();
    out.push({ href, text });
    if (out.length > 800) break;
  }
  return out;
}

export function extractJsonLd(html: string): unknown[] {
  const out: unknown[] = [];
  const re = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      const v = JSON.parse(m[1].trim());
      if (Array.isArray(v)) out.push(...v); else out.push(v);
    } catch { /* ignore */ }
  }
  return out;
}

export function extractImages(html: string, baseUrl: string, max = 12): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /<(?:img|source)\b[^>]*?(?:src|data-src|srcset)\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < max) {
    let src = m[1].split(",")[0].trim().split(" ")[0];
    if (!src || src.startsWith("data:")) continue;
    try { src = new URL(src, baseUrl).toString(); } catch { continue; }
    if (!/\.(jpe?g|png|webp|avif)(\?|$)/i.test(src) && !/image|photo|bild|media/i.test(src)) continue;
    if (/logo|icon|sprite|placeholder|pixel|svg|avatar|flag|badge/i.test(src)) continue;
    if (seen.has(src)) continue;
    seen.add(src);
    out.push(src);
  }
  // og:image zuerst
  const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1];
  if (og) {
    try {
      const u = new URL(og, baseUrl).toString();
      if (!seen.has(u)) out.unshift(u);
    } catch { /* ignore */ }
  }
  return out.slice(0, max);
}

export function metaContent(html: string, name: string): string | null {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]+content=["']([^"']*)["']`, "i");
  const m = html.match(re);
  return m ? decodeEntities(m[1]) : null;
}

export function titleOf(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? htmlToText(m[1], 300).replace(/\n+/g, " ").trim() : null;
}
