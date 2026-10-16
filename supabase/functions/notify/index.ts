// notify: Web Push an alle Abonnenten für neue, gut bewertete Inserate – einmal pro Inserat.
// Mit {test: true} wird eine Testnachricht an alle (oder an {subscription_id}) geschickt.

import { admin, finishRun, getCriteria, getSetting, startRun } from "../_shared/db.ts";
import { authenticate, corsHeaders, json, unauthorized } from "../_shared/auth.ts";
import { PushSub, sendPush } from "../_shared/push.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const caller = await authenticate(req);
  if (!caller) return unauthorized();
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* leer */ }
  const db = admin();
  const runId = await startRun("notify");
  try {
    const subject = await getSetting<string>("push_subject", "mailto:wohnungsradar@example.org");
    const appUrl = (await getSetting<string>("app_url", "")).replace(/\/$/, "") + "/";
    let subsQ = db.from("push_subscriptions").select("*").eq("active", true);
    if (typeof body.subscription_id === "string") subsQ = subsQ.eq("id", body.subscription_id);
    const { data: subs } = await subsQ;
    const subscriptions = subs ?? [];

    const send = async (sub: { id: string; subscription: PushSub }, payload: Record<string, unknown>) => {
      const r = await sendPush(sub.subscription, payload, subject);
      if (r.ok) await db.from("push_subscriptions").update({ last_ok: new Date().toISOString(), failures: 0 }).eq("id", sub.id);
      else {
        const dead = r.status === 404 || r.status === 410;
        const { data: cur } = await db.from("push_subscriptions").select("failures").eq("id", sub.id).single();
        const failures = (cur?.failures ?? 0) + 1;
        await db.from("push_subscriptions").update({ failures, active: !(dead || failures >= 5) }).eq("id", sub.id);
      }
      return r;
    };

    if (body.test === true) {
      const results = [];
      for (const s of subscriptions) {
        const r = await send(s, { title: "Wohnungsradar Wien", body: "Push funktioniert. Neue Inserate kommen so an.", url: appUrl, tag: "test" });
        results.push({ id: s.id, ...r });
      }
      await finishRun(runId, true, { test: true, results });
      return json({ ok: true, results });
    }

    const { doc: crit } = await getCriteria();
    const threshold = Number(crit.alert_threshold ?? 70);
    const { data: pending } = await db.from("listings")
      .select("id,title,price,area_m2,rooms,district,plz,scores!inner(score,hard_ok,reasoning)")
      .eq("active", true).is("duplicate_of", null).is("notified_at", null)
      .eq("scores.hard_ok", true).gte("scores.score", threshold)
      .order("first_seen", { ascending: false }).limit(20);
    const sent: unknown[] = [];
    for (const l of pending ?? []) {
      // deno-lint-ignore no-explicit-any
      const sc = (Array.isArray((l as any).scores) ? (l as any).scores[0] : (l as any).scores) as { score: number; reasoning: string };
      const firstSentence = (sc.reasoning ?? "").split(/(?<=[.!?])\s+/)[0]?.slice(0, 140) ?? "";
      const payload = {
        title: `Score ${sc.score} · ${l.district ? l.district + ". Bezirk" : l.plz ?? "Wien"} · ${l.price ? l.price.toLocaleString("de-AT") + " €" : "Preis?"}`,
        body: `${l.area_m2 ? Math.round(l.area_m2) + " m²" : ""}${l.rooms ? ", " + l.rooms + " Zi" : ""} – ${firstSentence}`,
        url: `${appUrl}#/detail/${l.id}`,
        tag: `listing-${l.id}`,
      };
      // einmal pro Inserat: zuerst markieren, dann senden
      await db.from("listings").update({ notified_at: new Date().toISOString() }).eq("id", l.id);
      for (const s of subscriptions) {
        const r = await send(s, payload);
        await db.from("notifications").insert({ listing_id: l.id, subscription_id: s.id, ok: r.ok, detail: `${r.status} ${r.detail}`.slice(0, 300) });
        sent.push({ listing: l.id, sub: s.id, ok: r.ok, status: r.status });
      }
    }
    await finishRun(runId, true, { threshold, subscriptions: subscriptions.length, listings: (pending ?? []).length, sent });
    return json({ ok: true, listings: (pending ?? []).length, subscriptions: subscriptions.length, sent });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    await finishRun(runId, false, null, msg);
    return json({ ok: false, error: msg }, 500);
  }
});
