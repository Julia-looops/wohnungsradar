// Web Push (VAPID) ohne Node-HTTPS: web-push baut Header+Body, gesendet wird mit fetch.
import webpush from "npm:web-push@3.6.7";
import { vapidPrivate, vapidPublic } from "./env.ts";

export interface PushSub { endpoint: string; keys: { p256dh: string; auth: string } }

export async function sendPush(sub: PushSub, payload: Record<string, unknown>, subject: string, ttl = 86400): Promise<{ ok: boolean; status: number; detail: string }> {
  const pub = vapidPublic(), priv = vapidPrivate();
  if (!pub || !priv) return { ok: false, status: 0, detail: "VAPID-Schlüssel fehlen" };
  let details: { endpoint: string; method: string; headers: Record<string, string>; body: Uint8Array | string };
  try {
    details = webpush.generateRequestDetails(sub, JSON.stringify(payload), {
      vapidDetails: { subject, publicKey: pub, privateKey: priv },
      TTL: ttl,
      urgency: "normal",
    });
  } catch (e) {
    return { ok: false, status: 0, detail: "generateRequestDetails: " + String(e).slice(0, 200) };
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const body = typeof details.body === "string" ? new TextEncoder().encode(details.body) : details.body;
    const res = await fetch(details.endpoint, { method: details.method ?? "POST", headers: details.headers, body: body as BodyInit, signal: ctrl.signal });
    const txt = await res.text().catch(() => "");
    return { ok: res.status >= 200 && res.status < 300, status: res.status, detail: txt.slice(0, 200) };
  } catch (e) {
    return { ok: false, status: 0, detail: String(e).slice(0, 200) };
  } finally {
    clearTimeout(t);
  }
}
