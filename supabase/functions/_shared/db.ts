import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import { secretKey, supabaseUrl } from "./env.ts";

let _admin: SupabaseClient | null = null;

/** Admin-Client (Secret Key, umgeht RLS). Nur serverseitig. */
export function admin(): SupabaseClient {
  if (!_admin) {
    _admin = createClient(supabaseUrl(), secretKey(), {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { "x-radar": "edge" } },
    });
  }
  return _admin;
}

export async function getSetting<T = unknown>(key: string, fallback: T): Promise<T> {
  const { data } = await admin().from("settings").select("value").eq("key", key).maybeSingle();
  if (!data || data.value === null || data.value === undefined) return fallback;
  return data.value as T;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await admin().from("settings").upsert({ key, value, updated_at: new Date().toISOString() });
}

export async function getCriteria(): Promise<{ doc: Criteria; version: number }> {
  const { data, error } = await admin().from("criteria").select("doc, version").eq("id", 1).single();
  if (error || !data) throw new Error("criteria fehlen: " + (error?.message ?? ""));
  return { doc: data.doc as Criteria, version: data.version as number };
}

export interface SoftCriterion { key: string; label: string; weight: number }
export interface Criteria {
  hard: { max_price: number; min_rooms: number; min_area_m2: number; selbstbezug: boolean; lift_or_ground: boolean };
  districts: Record<string, "ganz" | "teilweise">;
  district_notes: Record<string, string>;
  soft: SoftCriterion[];
  weight_band: { min: number; max: number; auto_step: number };
  alert_threshold: number;
  notes: string;
  exclude_terms: string[];
}

/** Lauf-Protokoll */
export async function startRun(fn: string): Promise<string> {
  // Hängengebliebene Läufe (Zeitlimit der Edge Runtime) als abgebrochen markieren
  await admin().from("runs").update({ ok: false, finished_at: new Date().toISOString(), error: "abgebrochen (Zeitlimit oder Neustart)" })
    .is("finished_at", null).lt("started_at", new Date(Date.now() - 8 * 60000).toISOString());
  const { data } = await admin().from("runs").insert({ fn }).select("id").single();
  return data?.id as string;
}
export async function finishRun(id: string, ok: boolean, summary: unknown, error?: string) {
  await admin().from("runs").update({
    finished_at: new Date().toISOString(), ok, summary, error: error ?? null,
  }).eq("id", id);
}

export function plzToDistrict(plz: string | number | null | undefined): number | null {
  if (plz === null || plz === undefined) return null;
  const s = String(plz).trim();
  const m = s.match(/^1(\d\d)0$/);
  if (!m) return null;
  const d = parseInt(m[1], 10);
  return d >= 1 && d <= 23 ? d : null;
}

export function allowedDistricts(c: Criteria): Set<number> {
  return new Set(Object.keys(c.districts).map((k) => parseInt(k, 10)).filter((n) => !isNaN(n)));
}
