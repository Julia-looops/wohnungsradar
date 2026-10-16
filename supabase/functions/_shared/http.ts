// HTTP-Hilfen: Abruf mit Timeout, Browser-ähnlichem User-Agent und Fehlertoleranz

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

export interface FetchResult { ok: boolean; status: number; text: string; url: string; contentType: string }

export async function fetchText(url: string, opts: { timeoutMs?: number; headers?: Record<string, string>; method?: string; body?: string } = {}): Promise<FetchResult> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20000);
  try {
    const res = await fetch(url, {
      method: opts.method ?? "GET",
      redirect: "follow",
      signal: ctrl.signal,
      body: opts.body,
      headers: {
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "Accept-Language": "de-AT,de;q=0.9,en;q=0.6",
        ...(opts.headers ?? {}),
      },
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text, url: res.url || url, contentType: res.headers.get("content-type") ?? "" };
  } catch (e) {
    return { ok: false, status: 0, text: "", url, contentType: "" + (e as Error)?.message };
  } finally {
    clearTimeout(t);
  }
}

export async function fetchJson<T = unknown>(url: string, opts: Parameters<typeof fetchText>[1] = {}): Promise<T | null> {
  const r = await fetchText(url, { ...opts, headers: { Accept: "application/json", ...(opts.headers ?? {}) } });
  if (!r.ok) return null;
  try { return JSON.parse(r.text) as T; } catch { return null; }
}

export function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

/** Begrenzte Parallelität */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
