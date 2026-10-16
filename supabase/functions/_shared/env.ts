// Umgebungsvariablen und Schlüssel der Edge Functions

export function secretKey(): string {
  const multi = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (multi) {
    try {
      const obj = JSON.parse(multi);
      if (obj?.default) return obj.default;
      const first = Object.values(obj)[0];
      if (typeof first === "string") return first;
    } catch { /* ignore */ }
  }
  return Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
}

export function supabaseUrl(): string {
  return Deno.env.get("SUPABASE_URL") ?? "";
}

export function functionsUrl(): string {
  // Innerhalb der Edge Runtime zeigt SUPABASE_URL auf das Projekt; Functions laufen unter /functions/v1
  const base = supabaseUrl().replace(/\/$/, "");
  return `${base}/functions/v1`;
}

export function anthropicKey(): string {
  return Deno.env.get("ANTHROPIC_API_KEY") ?? "";
}

export function apifyToken(): string {
  return Deno.env.get("APIFY_TOKEN") ?? "";
}

export function vapidPrivate(): string {
  return Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
}
export function vapidPublic(): string {
  return Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
}
