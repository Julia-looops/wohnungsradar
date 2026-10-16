// api: einziger Endpunkt der PWA. Zugriff nur mit App-Token (x-app-token). Aktionen per POST {action, ...}.

import { admin, Criteria, getCriteria, getSetting } from "../_shared/db.ts";
import { authenticate, corsHeaders, json, triggerNext, unauthorized } from "../_shared/auth.ts";
import { secretKey, supabaseUrl } from "../_shared/env.ts";

const LIST_COLS = "id,source,url,title,price,area_m2,rooms,plz,district,address,lat,lng,floor,images,first_seen,last_seen,published_at,seller_type,active,duplicate_of,dedupe_key";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const caller = await authenticate(req);
  if (!caller) return unauthorized();
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* leer */ }
  const action = String(body.action ?? "");
  const db = admin();
  try {
    switch (action) {
      case "bootstrap": {
        const { doc, version } = await getCriteria();
        const [{ data: sources }, { data: proposals }, { data: note }, { data: lastRuns }, vapid, appUrl] = await Promise.all([
          db.from("sources").select("id,name,kind,enabled,last_run_at,last_status,last_count,last_new,last_error,sort").order("sort"),
          db.from("proposals").select("*").eq("status", "offen").order("created_at", { ascending: false }),
          db.from("learning_notes").select("note,created_at,kind,applied,insights").order("created_at", { ascending: false }).limit(1).maybeSingle(),
          db.from("runs").select("fn,started_at,finished_at,ok,error,summary").order("started_at", { ascending: false }).limit(12),
          getSetting<string | null>("vapid_public", null),
          getSetting<string>("app_url", ""),
        ]);
        const { count: active } = await db.from("listings").select("id", { count: "exact", head: true }).eq("active", true).is("duplicate_of", null);
        const { count: subs } = await db.from("push_subscriptions").select("id", { count: "exact", head: true }).eq("active", true);
        return json({ criteria: doc, version, sources, proposals, learning_note: note, runs: lastRuns, vapid_public: vapid, app_url: appUrl, counts: { active, subscriptions: subs } });
      }
      case "listings": {
        const status = String(body.status ?? "alle");
        const includeHardFail = body.include_hard_fail === true;
        const limit = Math.min(500, Number(body.limit ?? 300));
        let q = db.from("listings").select(`${LIST_COLS},scores(score,hard_ok,hard_fail,warnings,reasoning,updated_at),ratings(stars,status,note,updated_at)`)
          .eq("active", true).is("duplicate_of", null).limit(limit);
        const { data, error } = await q;
        if (error) throw error;
        let rows = (data ?? []).map(flatten);
        const imgCount = new Map<string, number>();
        for (const r of rows) if (r.image) imgCount.set(r.image, (imgCount.get(r.image) ?? 0) + 1);
        for (const r of rows) if (r.image && (imgCount.get(r.image) ?? 0) > 1) r.image = null;
        if (!includeHardFail) rows = rows.filter((r) => r.hard_ok !== false);
        if (status === "neu") rows = rows.filter((r) => !r.rating_status || r.rating_status === "neu");
        else if (status !== "alle") rows = rows.filter((r) => r.rating_status === status);
        rows.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || (b.first_seen > a.first_seen ? 1 : -1));
        return json({ listings: rows });
      }
      case "listing": {
        const id = String(body.id ?? "");
        const { data: l, error } = await db.from("listings").select(`${LIST_COLS},features,raw_text,scores(*),ratings(*),enrichments(*)`).eq("id", id).maybeSingle();
        if (error) throw error;
        if (!l) return json({ error: "nicht gefunden" }, 404);
        let dups: unknown[] = [];
        if (l.dedupe_key) {
          const { data } = await db.from("listings").select("id,source,url,price,title").eq("dedupe_key", l.dedupe_key).neq("id", id);
          dups = data ?? [];
        }
        return json({ listing: l, duplicates: dups });
      }
      case "rate": {
        const id = String(body.id ?? "");
        const stars = body.stars == null ? null : Math.max(1, Math.min(5, Number(body.stars)));
        const status = ["neu", "favorit", "besichtigt", "abgesagt"].includes(String(body.status)) ? String(body.status) : "neu";
        const note = body.note == null ? null : String(body.note).slice(0, 4000);
        const { error } = await db.from("ratings").upsert({ listing_id: id, stars, status, note, updated_at: new Date().toISOString() });
        if (error) throw error;
        return json({ ok: true });
      }
      case "criteria_update": {
        const incoming = body.doc as Criteria;
        if (!incoming || !incoming.hard || !Array.isArray(incoming.soft)) return json({ error: "ungültige Kriterien" }, 400);
        const { doc: current, version } = await getCriteria();
        const weightsOnly = JSON.stringify({ ...current, soft: current.soft.map((s) => ({ ...s, weight: 0 })), alert_threshold: 0 })
          === JSON.stringify({ ...incoming, soft: incoming.soft.map((s) => ({ ...s, weight: 0 })), alert_threshold: 0 });
        const { error } = await db.from("criteria").update({ doc: incoming, version: version + 1, updated_at: new Date().toISOString() }).eq("id", 1);
        if (error) throw error;
        if (weightsOnly) triggerNext("score", { mode: "recompute" });
        return json({ ok: true, version: version + 1, weights_only: weightsOnly, hint: weightsOnly ? "Gewichte neu angewendet." : "Änderungen wirken ab dem nächsten Lauf – oder jetzt mit „Jetzt neu bewerten“." });
      }
      case "rescore": {
        const mode = body.mode === "recompute" ? "recompute" : "rescore";
        triggerNext("score", { mode });
        return json({ ok: true, mode });
      }
      case "collect_now": {
        triggerNext("collect", { all: true });
        return json({ ok: true });
      }
      case "enrich_one": {
        triggerNext("enrich", { listing_id: String(body.id ?? ""), then: "score" });
        return json({ ok: true });
      }
      case "subscribe": {
        const sub = body.subscription as { endpoint: string; keys: { p256dh: string; auth: string } };
        if (!sub?.endpoint || !sub?.keys?.p256dh) return json({ error: "ungültige Subscription" }, 400);
        const { data, error } = await db.from("push_subscriptions").upsert({ endpoint: sub.endpoint, subscription: sub, label: body.label ? String(body.label).slice(0, 80) : null, active: true, failures: 0 }, { onConflict: "endpoint" }).select("id").single();
        if (error) throw error;
        return json({ ok: true, id: data.id });
      }
      case "unsubscribe": {
        await db.from("push_subscriptions").update({ active: false }).eq("endpoint", String(body.endpoint ?? ""));
        return json({ ok: true });
      }
      case "test_push": {
        const res = await fetch(`${supabaseUrl()}/functions/v1/notify`, { method: "POST", headers: { "Content-Type": "application/json", apikey: secretKey() }, body: JSON.stringify({ test: true, subscription_id: body.subscription_id }) });
        return json(await res.json(), res.status);
      }
      case "proposal_decide": {
        const id = String(body.id ?? "");
        const accept = body.accept === true;
        const { data: p } = await db.from("proposals").select("*").eq("id", id).single();
        if (!p) return json({ error: "nicht gefunden" }, 404);
        await db.from("proposals").update({ status: accept ? "angenommen" : "abgelehnt", decided_at: new Date().toISOString() }).eq("id", id);
        if (accept) {
          const { doc, version } = await getCriteria();
          const ch = p.change as Record<string, unknown>;
          let weightsOnly = false;
          if (ch.type === "weight") {
            const s = doc.soft.find((x) => x.key === ch.key);
            if (s) { s.weight = Math.max(doc.weight_band.min, Math.min(doc.weight_band.max, s.weight + Number(ch.delta))); weightsOnly = true; }
          } else if (ch.type === "district") {
            const d = String(ch.district);
            if (ch.action === "ausschliessen") delete doc.districts[d];
            else if (ch.action === "aufnehmen") doc.districts[d] = "ganz";
            else { doc.districts[d] = "teilweise"; if (ch.note) doc.district_notes[d] = String(ch.note); }
          } else if (ch.type === "notes" && ch.append) {
            doc.notes = ((doc.notes ?? "") + "\n" + String(ch.append)).trim();
          }
          await db.from("criteria").update({ doc, version: version + 1, updated_at: new Date().toISOString() }).eq("id", 1);
          triggerNext("score", { mode: weightsOnly ? "recompute" : "rescore" });
        }
        return json({ ok: true });
      }
      case "sources_update": {
        await db.from("sources").update({ enabled: body.enabled === true }).eq("id", String(body.id ?? ""));
        return json({ ok: true });
      }
      case "notes": {
        const { data } = await db.from("learning_notes").select("*").order("created_at", { ascending: false }).limit(20);
        return json({ notes: data ?? [] });
      }
      default:
        return json({ error: "unbekannte Aktion" }, 400);
    }
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});

// deno-lint-ignore no-explicit-any
function flatten(r: any) {
  const sc = Array.isArray(r.scores) ? r.scores[0] : r.scores;
  const rt = Array.isArray(r.ratings) ? r.ratings[0] : r.ratings;
  const { scores: _s, ratings: _r, ...rest } = r;
  return {
    ...rest,
    image: Array.isArray(r.images) && r.images.length ? r.images[0] : null,
    images: undefined,
    score: sc?.score ?? null, hard_ok: sc?.hard_ok ?? null, hard_fail: sc?.hard_fail ?? [], warnings: sc?.warnings ?? [], reasoning: sc?.reasoning ?? null,
    rating_stars: rt?.stars ?? null, rating_status: rt?.status ?? null, rating_note: rt?.note ?? null,
  };
}
