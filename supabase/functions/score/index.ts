// score: harte Filter + Claude-Bewertung. Modi:
//  (leer)       → offene/veraltete Scores aktiver Inserate in Portionen bewerten, danach "notify"
//  recompute    → nur Gewichte neu anwenden (ohne Claude), z. B. nach Änderung der Gewichte in der App
//  rescore      → alle aktiven Inserate als veraltet markieren und neu bewerten (nach Kriterien-/Lernnotiz-Änderung)
//  listing_id   → ein einzelnes Inserat

import { admin, finishRun, getCriteria, getSetting, startRun } from "../_shared/db.ts";
import { authenticate, corsHeaders, json, triggerNext, unauthorized } from "../_shared/auth.ts";
import { askClaudeStructured, resolveModel } from "../_shared/claude.ts";
import { mapLimit } from "../_shared/http.ts";
import { Assessment, ListingForScore, buildScorePrompt, computeScore, hardPrecheck, scoreSchema } from "../_shared/scoring.ts";

const COLS = "id,title,price,area_m2,rooms,plz,district,address,floor,features,raw_text,seller_type,url,source";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const caller = await authenticate(req);
  if (!caller) return unauthorized();
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* leer */ }
  const db = admin();
  const runId = await startRun("score");
  try {
    const { doc: crit, version } = await getCriteria();
    const model = await resolveModel(await getSetting<string>("model_score", "claude-sonnet-4-5"), "sonnet");
    const batch = await getSetting<number>("score_batch", 10);

    if (body.mode === "recompute") {
      const { data: rows } = await db.from("scores").select("listing_id, assessment, hard_fail, claude_score").not("assessment", "is", null);
      let n = 0;
      for (const r of rows ?? []) {
        const a = r.assessment as Assessment;
        const pre = (r.hard_fail as string[]).filter((f) => ["preis", "flaeche", "zimmer", "bezirk"].includes(f));
        const s = computeScore(a, crit, pre);
        await db.from("scores").update({ score: s.score, hard_ok: s.hard_ok, hard_fail: s.hard_fail, warnings: s.warnings, criteria_version: version, updated_at: new Date().toISOString() }).eq("listing_id", r.listing_id);
        n++;
      }
      await finishRun(runId, true, { mode: "recompute", updated: n });
      return json({ ok: true, updated: n });
    }
    if (body.mode === "rescore") {
      await db.from("listings").update({ score_stale: true }).eq("active", true);
    }

    // Fehlgeschlagene Bewertungen (ohne Score) nach 20 Minuten erneut versuchen
    const retryBefore = new Date(Date.now() - 20 * 60000).toISOString();
    const { data: failed } = await db.from("scores").select("listing_id").is("score", null).lt("updated_at", retryBefore).limit(50);
    if (failed?.length) await db.from("listings").update({ score_stale: true }).in("id", failed.map((f) => f.listing_id));

    const { data: noteRow } = await db.from("learning_notes").select("note").order("created_at", { ascending: false }).limit(1).maybeSingle();
    const learningNote = noteRow?.note ?? null;

    const { data: rows, error } = typeof body.listing_id === "string"
      ? await db.from("listings").select(COLS).eq("id", body.listing_id)
      : await db.from("listings").select(COLS).eq("active", true).is("duplicate_of", null).not("enriched_at", "is", null).eq("score_stale", true)
        .order("first_seen", { ascending: false }).limit(batch);
    if (error) throw error;
    const listings = (rows ?? []) as ListingForScore[];

    const results = await mapLimit(listings, 3, async (l) => {
      try {
        const { data: en } = await db.from("enrichments").select("*").eq("listing_id", l.id).maybeSingle();
        const pre = hardPrecheck(l, crit);
        const { system, user } = buildScorePrompt(l, en ?? null, crit, learningNote);
        const { value, raw } = await askClaudeStructured<Assessment>(user, scoreSchema(crit), { system, model, maxTokens: 2000 });
        if (!value || !value.hart) throw new Error("Antwort ohne JSON: " + raw.text.slice(0, 200));
        const s = computeScore(value, crit, pre.fails);
        await db.from("scores").upsert({
          listing_id: l.id, score: s.score, claude_score: Math.round(Number(value.score) || 0), hard_ok: s.hard_ok, hard_fail: s.hard_fail,
          assessment: value, reasoning: String(value.begruendung ?? "").slice(0, 1500), warnings: s.warnings,
          model: raw.model, criteria_version: version, updated_at: new Date().toISOString(),
        });
        await db.from("listings").update({ scored_at: new Date().toISOString(), score_stale: false }).eq("id", l.id);
        return { id: l.id, score: s.score, hard_ok: s.hard_ok };
      } catch (e) {
        const msg = String((e as Error)?.message ?? e).slice(0, 300);
        console.error("score", l.id, msg);
        // nicht endlos wiederholen: als bewertet markieren, Fehler festhalten
        await db.from("scores").upsert({ listing_id: l.id, score: null, hard_ok: null, reasoning: "Bewertung fehlgeschlagen: " + msg, model, criteria_version: version, updated_at: new Date().toISOString() });
        await db.from("listings").update({ scored_at: new Date().toISOString(), score_stale: false }).eq("id", l.id);
        return { id: l.id, error: msg };
      }
    });

    const { count } = await db.from("listings").select("id", { count: "exact", head: true })
      .eq("active", true).is("duplicate_of", null).not("enriched_at", "is", null).eq("score_stale", true);
    await finishRun(runId, true, { processed: listings.length, remaining: count ?? 0, results });
    if (!body.listing_id) {
      if ((count ?? 0) > 0 && listings.length > 0) triggerNext("score", {});
      else triggerNext("notify", {});
    }
    return json({ ok: true, processed: listings.length, remaining: count ?? 0, results });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    await finishRun(runId, false, null, msg);
    return json({ ok: false, error: msg }, 500);
  }
});
