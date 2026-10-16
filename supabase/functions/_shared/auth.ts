import { secretKey } from "./env.ts";
import { getSetting } from "./db.ts";

export type Caller = "service" | "app" | null;

/**
 * Wer ruft? "service": Secret Key im apikey-Header (pg_cron, Function-Kette).
 * "app": gültiger App-Token (x-app-token) aus den Einstellungen.
 */
export async function authenticate(req: Request): Promise<Caller> {
  const apikey = req.headers.get("apikey") ?? "";
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const sk = secretKey();
  if (sk && (apikey === sk || bearer === sk)) return "service";
  const appToken = req.headers.get("x-app-token") ?? new URL(req.url).searchParams.get("t") ?? "";
  if (appToken) {
    const expected = await getSetting<string | null>("app_token", null);
    if (expected && timingSafeEqual(appToken, expected)) return "app";
  }
  return null;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-app-token, x-radar-cron",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

export function unauthorized(): Response {
  return json({ error: "unauthorized" }, 401);
}

/** Nächste Stufe der Kette anstoßen, ohne auf sie zu warten. */
export function triggerNext(fn: string, body: Record<string, unknown> = {}): void {
  const base = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
  const url = `${base}/functions/v1/${fn}`;
  const p = fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: secretKey() },
    body: JSON.stringify(body),
  }).then((r) => r.text()).catch((e) => console.error("triggerNext", fn, String(e)));
  // deno-lint-ignore no-explicit-any
  const er = (globalThis as any).EdgeRuntime;
  if (er?.waitUntil) er.waitUntil(p);
}
