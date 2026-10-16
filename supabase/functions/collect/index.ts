// collect: Inserate sammeln (willhaben via Apify, andere Quellen direkt).
// Arbeitet in Portionen: pro Aufruf bis zu N Quellen, dann ruft sie sich selbst erneut auf;
// sind alle Quellen für heute erledigt, startet sie "enrich".

import { admin, allowedDistricts, finishRun, getCriteria, getSetting, startRun } from "../_shared/db.ts";
import { authenticate, json, triggerNext, unauthorized, corsHeaders } from "../_shared/auth.ts";
import { collectWillhaben } from "../_shared/sources/apify_willhaben.ts";
import { collectGeneric } from "../_shared/sources/generic.ts";
import { Candidate, CollectContext, SourceRow, dedupeKey } from "../_shared/sources/types.ts";

const SOURCES_PER_CALL = 3;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const caller = await authenticate(req);
  if (!caller) return unauthorized();
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* leer */ }

  const db = admin();
  const runId = await startRun("collect");
  const logs: string[] = [];
  const log = (m: string) => { logs.push(m); console.log("[collect]", m); };
  try {
    const { doc: crit } = await getCriteria();
    const allowed = allowedDistricts(crit);
    const allowedPlz = new Set([...allowed].map((d) => `1${String(d).padStart(2, "0")}0`));
    const maxPerSource = await getSetting<number>("collect_max_per_source", 60);
    const extractModel = await getSetting<string>("model_extract", "claude-haiku-4-5");

    // Welche Quellen sind dran? Explizit angefragte, sonst alle aktiven, die heute noch nicht liefen.
    const force = Array.isArray(body.sources) ? (body.sources as string[]) : null;
    const { data: allSources } = await db.from("sources").select("*").eq("enabled", true).order("sort");
    const today = new Date().toISOString().slice(0, 10);
    const forceAll = body.all === true;
    let due = (allSources ?? []) as (SourceRow & { last_run_at: string | null })[];
    if (force) due = due.filter((s) => force.includes(s.id));
    else if (!forceAll) due = due.filter((s) => !s.last_run_at || s.last_run_at.slice(0, 10) !== today);
    const batch = due.slice(0, SOURCES_PER_CALL);
    const remaining = due.length - batch.length;

    const { data: urlRows } = await db.from("listings").select("url");
    const knownUrls = new Set((urlRows ?? []).map((r: { url: string }) => r.url));
    const ctx: CollectContext = { maxPrice: crit.hard.max_price, minArea: crit.hard.min_area_m2, allowedPlz, knownUrls, maxPerSource, extractModel, log };

    const summary: Record<string, unknown> = {};
    for (const src of batch) {
      const started = Date.now();
      let cands: Candidate[] = [];
      let error: string | null = null;
      try {
        cands = src.kind === "apify" ? await collectWillhaben(src, ctx) : await collectGeneric(src, ctx);
      } catch (e) {
        error = String((e as Error)?.message ?? e).slice(0, 900);
        log(`${src.id}: FEHLER ${error}`);
      }
      const stats = await storeCandidates(src.id, cands, crit, allowedPlz);
      summary[src.id] = { ...stats, error, ms: Date.now() - started };
      await db.from("sources").update({
        last_run_at: new Date().toISOString(),
        last_status: error ? "fehler" : "ok",
        last_count: cands.filter((c) => !c.expired).length,
        last_new: stats.inserted,
        last_error: error,
      }).eq("id", src.id);
    }

    // Veraltete Inserate deaktivieren (lange nicht gesehen)
    await db.from("listings").update({ active: false })
      .lt("last_seen", new Date(Date.now() - 30 * 86400000).toISOString()).eq("active", true);

    await finishRun(runId, true, { batch: batch.map((s) => s.id), remaining, summary, logs: logs.slice(-40) });
    if (remaining > 0 && !force) triggerNext("collect", {});
    else triggerNext("enrich", {});
    return json({ ok: true, batch: batch.map((s) => s.id), remaining, summary });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    await finishRun(runId, false, { logs }, msg);
    return json({ ok: false, error: msg }, 500);
  }
});

async function storeCandidates(sourceId: string, cands: Candidate[], crit: { hard: { max_price: number }; exclude_terms: string[] }, allowedPlz: Set<string>) {
  const db = admin();
  const stats = { inserted: 0, updated: 0, expired: 0, dropped: 0 };
  const excl = (crit.exclude_terms ?? []).map((t) => t.toLowerCase());
  for (const c of cands) {
    if (c.expired) {
      await db.from("listings").update({ active: false }).eq("source", sourceId).eq("source_id", c.source_id);
      stats.expired++;
      continue;
    }
    // Bekannte URL ohne neue Daten → nur „gesehen"
    if (!c.title && !c.price && !c.raw_text) {
      const { data } = await db.from("listings").update({ last_seen: new Date().toISOString(), active: true })
        .eq("source", sourceId).eq("source_id", c.source_id).select("id");
      if (data?.length) stats.updated++;
      continue;
    }
    if (c.price && c.price > crit.hard.max_price * 1.02) { stats.dropped++; continue; }
    if (c.plz && !allowedPlz.has(c.plz)) { stats.dropped++; continue; }
    const title = (c.title ?? "").toLowerCase();
    if (excl.some((t) => title.includes(t))) { stats.dropped++; continue; }

    const district = c.plz ? parseInt(c.plz.slice(1, 3), 10) : null;
    const row = {
      source: sourceId,
      source_id: c.source_id,
      url: c.url,
      title: c.title ?? null,
      price: c.price ?? null,
      area_m2: c.area_m2 ?? null,
      rooms: c.rooms ?? null,
      plz: c.plz ?? null,
      district,
      address: c.address ?? null,
      lat: c.lat ?? null,
      lng: c.lng ?? null,
      floor: c.floor ?? null,
      features: c.features ?? [],
      images: c.images ?? [],
      raw_text: c.raw_text ?? null,
      raw: c.raw ?? null,
      dedupe_key: dedupeKey(c),
      seller_type: c.seller_type ?? null,
      published_at: c.published_at ?? null,
      last_seen: new Date().toISOString(),
      active: true,
    };
    const { data: existing } = await db.from("listings").select("id, price, raw_text").eq("source", sourceId).eq("source_id", c.source_id).maybeSingle();
    if (existing) {
      const changed = existing.price !== row.price || (row.raw_text && existing.raw_text !== row.raw_text);
      const upd: Record<string, unknown> = { ...row, first_seen: undefined };
      delete upd.first_seen;
      if (changed) { upd.score_stale = true; upd.enriched_at = null; }
      await db.from("listings").update(upd).eq("id", existing.id);
      stats.updated++;
    } else {
      const { data: ins, error } = await db.from("listings").insert(row).select("id").single();
      if (error) { console.error("insert", error.message); stats.dropped++; continue; }
      stats.inserted++;
      // Duplikat über Quellen hinweg?
      if (row.dedupe_key && ins) {
        const { data: dup } = await db.from("listings").select("id").eq("dedupe_key", row.dedupe_key).neq("id", ins.id).is("duplicate_of", null).order("first_seen").limit(1);
        if (dup?.length) await db.from("listings").update({ duplicate_of: dup[0].id }).eq("id", ins.id);
      }
    }
  }
  return stats;
}
