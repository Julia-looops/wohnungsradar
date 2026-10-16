// learn: aus Sternen und Freitext lernen. Täglich: Lernnotiz + Gewichtsvorschläge (kleine Änderungen automatisch,
// größere als Vorschlag in der App), Scores mit neuen Gewichten neu berechnen. Sonntags: Wochen-Digest + volle Neubewertung.

import { admin, Criteria, finishRun, getCriteria, getSetting, startRun } from "../_shared/db.ts";
import { authenticate, corsHeaders, json, triggerNext, unauthorized } from "../_shared/auth.ts";
import { askClaudeJson, resolveModel } from "../_shared/claude.ts";
import { sendPush } from "../_shared/push.ts";

interface LearnOut {
  note: string;
  weight_changes: Array<{ key: string; delta: number; reason: string }>;
  district_proposals: Array<{ district: number; action: "ausschliessen" | "aufnehmen" | "einschraenken"; reason: string; note?: string }>;
  other_proposals: Array<{ text: string; change: Record<string, unknown> }>;
  digest?: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const caller = await authenticate(req);
  if (!caller) return unauthorized();
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* leer */ }
  const mode = body.mode === "weekly" ? "weekly" : "daily";
  const db = admin();
  const runId = await startRun("learn");
  try {
    const model = await resolveModel(await getSetting<string>("model_learn", "claude-sonnet-4-5"), "sonnet");
    const { doc: crit, version } = await getCriteria();

    const { data: ratings } = await db.from("ratings")
      .select("stars,note,status,updated_at,listings!inner(id,title,price,area_m2,rooms,district,plz,address,features,scores(score,assessment,reasoning,warnings))")
      .order("updated_at", { ascending: false }).limit(150);
    const rated = (ratings ?? []).filter((r) => r.stars || (r.note && r.note.trim().length > 0) || r.status !== "neu");

    const { data: lastNote } = await db.from("learning_notes").select("note,created_at").order("created_at", { ascending: false }).limit(1).maybeSingle();

    if (rated.length < 3 && mode === "daily") {
      await finishRun(runId, true, { skipped: "weniger als 3 Bewertungen", ratings: rated.length });
      return json({ ok: true, skipped: true, ratings: rated.length });
    }

    // Wochenstatistik für den Digest
    let weekStats = "";
    if (mode === "weekly") {
      const since = new Date(Date.now() - 7 * 86400000).toISOString();
      const { count: newCount } = await db.from("listings").select("id", { count: "exact", head: true }).gte("first_seen", since);
      const { data: top } = await db.from("listings").select("title,price,area_m2,district,scores!inner(score)").eq("active", true).gte("first_seen", since).order("score", { referencedTable: "scores", ascending: false }).limit(5);
      weekStats = `Neue Inserate in den letzten 7 Tagen: ${newCount ?? 0}\nBeste neue Inserate: ${JSON.stringify(top ?? []).slice(0, 1500)}`;
    }

    const ratingText = rated.map((r) => {
      // deno-lint-ignore no-explicit-any
      const l = r.listings as any;
      const sc = Array.isArray(l?.scores) ? l.scores[0] : l?.scores;
      return `- ${r.stars ?? "-"} Sterne | Status ${r.status} | ${l?.title ?? ""} | ${l?.district ?? "?"}. Bezirk, ${l?.price ?? "?"} €, ${l?.area_m2 ?? "?"} m², ${l?.rooms ?? "?"} Zi | Merkmale: ${JSON.stringify(l?.features ?? [])} | Radar-Score ${sc?.score ?? "-"} | Kriterien: ${JSON.stringify(sc?.assessment?.weich ?? {})} | Kommentar: ${r.note ?? "-"}`;
    }).join("\n");

    const prompt = `Du hilfst einer Wohnungssuchenden in Wien, ihre Bewertungskriterien zu schärfen. Es gibt kein Persönlichkeitsprofil – du lernst ausschließlich aus Sternen (1–5) und Freitext.

AKTUELLE KRITERIEN
Harte Filter: ${JSON.stringify(crit.hard)}
Bezirke: ${JSON.stringify(crit.districts)} (Notizen: ${JSON.stringify(crit.district_notes)})
Weiche Kriterien mit Gewicht (Band ${crit.weight_band.min}–${crit.weight_band.max}): ${JSON.stringify(crit.soft)}
Bisherige Lernnotiz: ${lastNote?.note ?? "keine"}

BEWERTUNGEN DER NUTZERIN (neueste zuerst)
${ratingText || "(noch keine)"}

${weekStats}

AUFGABE
Antworte NUR mit JSON:
{
 "note": "Lernnotiz in höchstens 8 Sätzen: welche Eigenschaften gefallen, welche nicht, welche Gegenden/Lagen durchfallen, welche Warnsignale sie ernst nimmt. Nur, was aus Sternen und Texten wirklich hervorgeht. Beim ersten Mal ohne Vorgeschichte ruhig knapp.",
 "weight_changes": [{"key":"balkon","delta":1,"reason":"..."}],
 "district_proposals": [{"district":5,"action":"ausschliessen","reason":"..."}],
 "other_proposals": [{"text":"Vorschlag in einem Satz, als Frage formuliert","change":{"type":"notes","append":"..."}}]${mode === "weekly" ? ',\n "digest": "Wochenrückblick in 4–6 Sätzen für die Nutzerin: was neu kam, was gut war, was sie bewertet hat, was sich geändert hat."' : ""}
}
- delta nur -2..2; nur Kriterien aus der Liste; keine Änderung ohne klaren Beleg in den Bewertungen.
- district_proposals nur bei wiederholten Mustern (mindestens 2 Bewertungen).`;

    const { value, raw } = await askClaudeJson<LearnOut>(prompt, { model, maxTokens: 2500, temperature: 0.2 });
    if (!value || typeof value.note !== "string") throw new Error("Lernantwort ohne JSON: " + raw.text.slice(0, 200));

    // Gewichte: kleine Änderungen automatisch innerhalb der Bandbreite, große als Vorschlag
    const applied: Array<Record<string, unknown>> = [];
    const newSoft = crit.soft.map((s) => ({ ...s }));
    const step = Number(crit.weight_band?.auto_step ?? 1);
    for (const wc of value.weight_changes ?? []) {
      const s = newSoft.find((x) => x.key === wc.key);
      if (!s || !wc.delta) continue;
      const delta = Math.max(-2, Math.min(2, Math.round(Number(wc.delta))));
      if (Math.abs(delta) <= step) {
        const nw = Math.max(crit.weight_band.min, Math.min(crit.weight_band.max, s.weight + delta));
        if (nw !== s.weight) { applied.push({ key: s.key, from: s.weight, to: nw, reason: wc.reason }); s.weight = nw; }
      } else {
        await db.from("proposals").insert({ text: `Soll „${s.label}" von Gewicht ${s.weight} auf ${Math.max(crit.weight_band.min, Math.min(crit.weight_band.max, s.weight + delta))} gehen? (${wc.reason})`, change: { type: "weight", key: s.key, delta } });
      }
    }
    for (const dp of value.district_proposals ?? []) {
      if (!dp?.district) continue;
      const text = dp.action === "ausschliessen" ? `Soll ich den ${dp.district}. Bezirk künftig ausschließen? (${dp.reason})`
        : dp.action === "aufnehmen" ? `Soll ich den ${dp.district}. Bezirk aufnehmen? (${dp.reason})`
        : `Soll ich den ${dp.district}. Bezirk auf „teilweise" einschränken? (${dp.reason})`;
      await db.from("proposals").insert({ text, change: { type: "district", district: dp.district, action: dp.action, note: dp.note ?? null } });
    }
    for (const op of value.other_proposals ?? []) {
      if (op?.text) await db.from("proposals").insert({ text: op.text, change: op.change ?? {} });
    }

    let newVersion = version;
    if (applied.length) {
      const newDoc: Criteria = { ...crit, soft: newSoft };
      newVersion = version + 1;
      await db.from("criteria").update({ doc: newDoc, version: newVersion, updated_at: new Date().toISOString() }).eq("id", 1);
    }
    await db.from("learning_notes").insert({
      kind: mode, note: value.note, insights: { weight_changes: value.weight_changes, district_proposals: value.district_proposals, other_proposals: value.other_proposals, digest: value.digest ?? null },
      applied, based_on_ratings: rated.length, model: raw.model,
    });

    // Neue Gewichte anwenden (ohne Claude); sonntags volle Neubewertung mit neuer Lernnotiz
    if (applied.length) triggerNext("score", { mode: "recompute" });
    if (mode === "weekly") {
      triggerNext("score", { mode: "rescore" });
      if (value.digest) {
        const subject = await getSetting<string>("push_subject", "mailto:wohnungsradar@example.org");
        const appUrl = await getSetting<string>("app_url", "");
        const { data: subs } = await db.from("push_subscriptions").select("subscription").eq("active", true);
        for (const s of subs ?? []) await sendPush(s.subscription, { title: "Wohnungsradar – Wochenrückblick", body: value.digest.slice(0, 180), url: appUrl + "#/settings", tag: "digest" }, subject);
      }
    }
    await finishRun(runId, true, { mode, ratings: rated.length, applied, proposals: (value.district_proposals?.length ?? 0) + (value.other_proposals?.length ?? 0), version: newVersion });
    return json({ ok: true, mode, note: value.note, applied });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    await finishRun(runId, false, null, msg);
    return json({ ok: false, error: msg }, 500);
  }
});
