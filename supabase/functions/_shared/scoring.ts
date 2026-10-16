// Bewertungslogik: harte Vorprüfung, Prompt, Score-Berechnung aus Claude-Einschätzung und Gewichten

import { Criteria } from "./db.ts";

export type Tri = "ja" | "nein" | "unklar";
export type SoftTri = "erfuellt" | "nicht" | "unklar";

export interface Assessment {
  hart: Record<string, Tri>;
  weich: Record<string, SoftTri>;
  score: number;
  begruendung: string;
  warnsignale: string[];
}

export interface ListingForScore {
  id: string; title: string | null; price: number | null; area_m2: number | null; rooms: number | null; plz: string | null; district: number | null;
  address: string | null; floor: string | null; features: unknown; raw_text: string | null; seller_type: string | null; url: string; source: string;
}

export function hardPrecheck(l: ListingForScore, c: Criteria): { fails: string[]; unknown: string[] } {
  const fails: string[] = [], unknown: string[] = [];
  if (l.price == null) unknown.push("preis"); else if (l.price > c.hard.max_price) fails.push("preis");
  if (l.area_m2 == null) unknown.push("flaeche"); else if (l.area_m2 < c.hard.min_area_m2 * 0.96) fails.push("flaeche");
  if (l.rooms == null) unknown.push("zimmer"); else if (l.rooms < c.hard.min_rooms) fails.push("zimmer");
  if (l.district == null) unknown.push("bezirk"); else if (!c.districts[String(l.district)]) fails.push("bezirk");
  return { fails, unknown };
}

export function buildScorePrompt(l: ListingForScore, enrich: Record<string, unknown> | null, c: Criteria, learningNote: string | null): { system: string; user: string } {
  const districtsText = Object.entries(c.districts).map(([d, mode]) => `${d}. Bezirk: ${mode}${c.district_notes?.[d] ? " – " + c.district_notes[d] : ""}`).join("\n");
  const softText = c.soft.map((s) => `- ${s.key}: ${s.label} (Gewicht ${s.weight})`).join("\n");
  const system = `Du bewertest Inserate für eine Eigentumswohnung in Wien zum Selbstbezug. Du bist nüchtern, skeptisch gegenüber Maklersprache und urteilst nur auf Basis des Textes und der Zusatzdaten.
Grundregel: Was nicht belegt ist, gilt als "unklar" – niemals als erfüllt. Erfinde nichts.`;
  const soft = c.soft.map((s) => s.key);
  const user = `HARTE KRITERIEN
- Kaufpreis höchstens ${c.hard.max_price} €
- Eigentum zum Selbstbezug: keine Anleger-/Vorsorgewohnung, nicht vermietet (auch nicht befristet), kein Bauherrenmodell, kein Zinshaus-Anteil
- mindestens ${c.hard.min_rooms} Zimmer
- mindestens ca. ${c.hard.min_area_m2} m²
- Lift oder Erdgeschoss (Lift ist besser)
- Bezirk/Grätzl laut Liste:
${districtsText}
${c.district_notes?._allgemein ? "Allgemein: " + c.district_notes._allgemein : ""}

WEICHE KRITERIEN (Schlüssel: Bedeutung)
${softText}
${c.notes ? "\nZUSÄTZLICHE HINWEISE DER NUTZERIN:\n" + c.notes : ""}
${learningNote ? "\nWAS DIE NUTZERIN BISHER MOCHTE UND NICHT MOCHTE (Lernnotiz):\n" + learningNote : ""}

INSERAT
Quelle: ${l.source} | URL: ${l.url}
Titel: ${l.title ?? "-"}
Preis: ${l.price ?? "unbekannt"} € | Fläche: ${l.area_m2 ?? "unbekannt"} m² | Zimmer: ${l.rooms ?? "unbekannt"} | PLZ: ${l.plz ?? "unbekannt"} | Stock: ${l.floor ?? "unbekannt"}
Adresse: ${l.address ?? "unbekannt"} | Anbieter: ${l.seller_type ?? "unbekannt"}
Merkmale laut Inserat: ${Array.isArray(l.features) && l.features.length ? (l.features as string[]).join(", ") : "-"}

VOLLTEXT
${(l.raw_text ?? "").slice(0, 12000)}

ZUSATZDATEN (automatisch ermittelt)
${enrich ? JSON.stringify(stripEnrich(enrich)).slice(0, 4000) : "keine"}

AUFGABE
Antworte NUR mit JSON in genau dieser Form:
{
 "hart": {"selbstbezug":"ja|nein|unklar","lift_oder_eg":"ja|nein|unklar","zimmer":"ja|nein|unklar","flaeche":"ja|nein|unklar","preis":"ja|nein|unklar","bezirk_graetzl":"ja|nein|unklar"},
 "weich": {${soft.map((k) => `"${k}":"erfuellt|nicht|unklar"`).join(",")}},
 "score": 0,
 "begruendung": "Genau drei Sätze auf Deutsch mit den entscheidenden Gründen, konkret und ohne Floskeln.",
 "warnsignale": ["z.B. Anlegerwohnung, befristet vermietet, Sanierungsbedarf, Hinterhof-Blick, laute Straße, Provision, hohe Betriebskosten, unplausibler Preis"]
}
- "score" ist dein Gesamteindruck 0–100 für die Nutzerin (100 = sofort besichtigen). Harte Verstöße drücken den Score unter 30.
- "bezirk_graetzl": bei "teilweise"-Bezirken anhand von Adresse/Lage beurteilen; ohne Lagehinweis "unklar".
- Bei Lärm: Zusatzdaten (Lärmzonen in dB, Hauptstraßen, Bahn) berücksichtigen; Inserat-Behauptung "ruhig" allein reicht nicht.`;
  return { system, user };
}

function stripEnrich(e: Record<string, unknown>): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const k of ["noise", "transit", "green", "price_ctx", "zoning", "flood", "orientation"]) {
    if (e[k] !== undefined && e[k] !== null) o[k] = e[k];
  }
  // Rohproperties entfernen, die nur Platz kosten
  const noise = o.noise as Record<string, Record<string, unknown>> | undefined;
  if (noise) for (const k of Object.keys(noise)) if (noise[k] && typeof noise[k] === "object" && "props" in noise[k]) delete (noise[k] as Record<string, unknown>).props;
  const zoning = o.zoning as Record<string, unknown> | undefined;
  if (zoning?.props) delete zoning.props;
  return o;
}

export interface ScoreOut { score: number; hard_ok: boolean; hard_fail: string[]; warnings: string[] }

export function computeScore(a: Assessment, c: Criteria, precheckFails: string[]): ScoreOut {
  const hardFail = new Set<string>(precheckFails);
  for (const [k, v] of Object.entries(a.hart ?? {})) if (v === "nein") hardFail.add(k);
  const warnings = [...(a.warnsignale ?? [])].map(String).slice(0, 8);
  let penalty = 0;
  for (const k of ["selbstbezug", "lift_oder_eg", "bezirk_graetzl"]) {
    if ((a.hart ?? {})[k] === "unklar") { penalty += 5; if (!warnings.some((w) => w.toLowerCase().includes(k.split("_")[0]))) warnings.push(`${k} unklar`); }
  }
  let wsum = 0, wtot = 0;
  for (const s of c.soft) {
    const w = Math.max(0, Number(s.weight) || 0);
    wtot += w;
    const v = (a.weich ?? {})[s.key];
    if (v === "erfuellt") wsum += w;
    else if (v === "unklar") wsum += w * 0.25; // leichte Gutschrift, aber nie "erfüllt"
  }
  const weighted = wtot > 0 ? (wsum / wtot) * 100 : 50;
  const claude = Math.max(0, Math.min(100, Number(a.score) || 0));
  let score = Math.round(0.6 * weighted + 0.4 * claude) - penalty;
  const hard_ok = hardFail.size === 0;
  if (!hard_ok) score = Math.min(score, 25);
  score = Math.max(0, Math.min(100, score));
  return { score, hard_ok, hard_fail: [...hardFail], warnings };
}
