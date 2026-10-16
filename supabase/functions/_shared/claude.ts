// Anthropic Messages API, direkt per fetch (kein SDK nötig)

import { anthropicKey } from "./env.ts";

export interface ClaudeOptions {
  model: string;
  system?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

export interface ClaudeResult { text: string; usage?: { input_tokens: number; output_tokens: number }; model: string }

export async function askClaude(user: string, opts: ClaudeOptions): Promise<ClaudeResult> {
  const key = anthropicKey();
  if (!key) throw new Error("ANTHROPIC_API_KEY fehlt");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 90000);
  try {
    let lastErr = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: opts.model,
          max_tokens: opts.maxTokens ?? 1500,
          temperature: opts.temperature ?? 0.2,
          system: opts.system,
          messages: [{ role: "user", content: user }],
        }),
      });
      if (res.status === 429 || res.status >= 500 || res.status === 529) {
        lastErr = `${res.status} ${await res.text()}`;
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 500)}`);
      const data = await res.json();
      const text = (data.content ?? []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("\n");
      return { text, usage: data.usage, model: data.model ?? opts.model };
    }
    throw new Error("Anthropic nicht erreichbar: " + lastErr.slice(0, 300));
  } finally {
    clearTimeout(t);
  }
}

/** JSON aus einer Modellantwort holen – toleriert Codefences und Text drumherum. */
export function parseJson<T = unknown>(text: string): T | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fence?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const s = c.trim();
    try { return JSON.parse(s) as T; } catch { /* weiter */ }
    const start = Math.min(...["{", "["].map((ch) => { const i = s.indexOf(ch); return i < 0 ? Infinity : i; }));
    if (!isFinite(start)) continue;
    const endObj = s.lastIndexOf("}"), endArr = s.lastIndexOf("]");
    const end = Math.max(endObj, endArr);
    if (end > start) {
      try { return JSON.parse(s.slice(start, end + 1)) as T; } catch { /* weiter */ }
    }
  }
  return null;
}

export async function askClaudeJson<T = unknown>(user: string, opts: ClaudeOptions): Promise<{ value: T | null; raw: ClaudeResult }> {
  const raw = await askClaude(user, opts);
  return { value: parseJson<T>(raw.text), raw };
}
