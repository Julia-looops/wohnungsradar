#!/usr/bin/env python3
"""Nach dem Deployment: Vault-Secrets, App-Token, VAPID-Schlüssel, Haltestellen-Referenzdaten.
Läuft in GitHub Actions. Spricht die Supabase Management API (SQL) an; gibt keine Geheimnisse aus."""
import csv, io, json, os, subprocess, sys, urllib.request

REF = os.environ["PROJECT_REF"]
TOKEN = os.environ["SUPABASE_ACCESS_TOKEN"]
SECRET_KEY = os.environ["SUPABASE_SECRET_KEY"]
APP_TOKEN = os.environ["APP_TOKEN"]
FUNCTIONS_URL = f"https://{REF}.supabase.co/functions/v1"


def sql(query, params=None):
    body = json.dumps({"query": query}).encode()
    req = urllib.request.Request(f"https://api.supabase.com/v1/projects/{REF}/database/query", data=body, method="POST",
                                 headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode() or "null")


def q(s):
    return "'" + s.replace("'", "''") + "'"


def vault_set(name, secret):
    rows = sql(f"select id from vault.secrets where name = {q(name)}")
    if rows:
        sql(f"select vault.update_secret({q(rows[0]['id'])}::uuid, {q(secret)})")
    else:
        sql(f"select vault.create_secret({q(secret)}, {q(name)})")


def vault_get(name):
    rows = sql(f"select decrypted_secret from vault.decrypted_secrets where name = {q(name)}")
    return rows[0]["decrypted_secret"] if rows else None


def main():
    print("Vault: Functions-URL und Secret Key für pg_cron")
    vault_set("radar_functions_url", FUNCTIONS_URL)
    vault_set("radar_secret_key", SECRET_KEY)

    print("Settings: App-Token")
    sql(f"insert into public.settings(key, value) values ('app_token', to_jsonb({q(APP_TOKEN)}::text)) "
        f"on conflict (key) do update set value = excluded.value, updated_at = now()")

    print("VAPID-Schlüssel")
    pub, priv = vault_get("vapid_public"), vault_get("vapid_private")
    if not pub or not priv:
        out = subprocess.run(["npx", "--yes", "web-push@3.6.7", "generate-vapid-keys", "--json"], capture_output=True, text=True, check=True).stdout
        keys = json.loads(out.strip().splitlines()[-1])
        pub, priv = keys["publicKey"], keys["privateKey"]
        vault_set("vapid_public", pub)
        vault_set("vapid_private", priv)
        print("  neu erzeugt")
    else:
        print("  vorhanden")
    sql(f"insert into public.settings(key, value) values ('vapid_public', to_jsonb({q(pub)}::text)) "
        f"on conflict (key) do update set value = excluded.value, updated_at = now()")
    subprocess.run(["supabase", "secrets", "set", f"VAPID_PUBLIC_KEY={pub}", f"VAPID_PRIVATE_KEY={priv}", f"RADAR_SECRET_KEY={SECRET_KEY}", "--project-ref", REF],
                   check=True, capture_output=True)

    print("Secrets prüfen (Anthropic, Apify)")
    lst = subprocess.run(["supabase", "secrets", "list", "--project-ref", REF], capture_output=True, text=True).stdout
    for name in ("ANTHROPIC_API_KEY", "APIFY_TOKEN"):
        print(f"  {name}: {'vorhanden' if name in lst else 'FEHLT'}")

    seed_stops()


def seed_stops():
    n = sql("select count(*)::int as n from public.transit_stops")[0]["n"]
    if n > 1000:
        print(f"Haltestellen: {n} vorhanden, kein Import")
        return
    print("Haltestellen: Wiener Linien OGD laden")
    base = "https://www.wienerlinien.at/ogd_realtime/doku/ogd/"

    def load(name):
        with urllib.request.urlopen(base + name, timeout=60) as r:
            raw = r.read().decode("utf-8-sig", errors="replace")
        sample = raw[:2000]
        delim = ";" if sample.count(";") > sample.count(",") else ","
        return list(csv.DictReader(io.StringIO(raw), delimiter=delim))

    try:
        stops = load("wienerlinien-ogd-haltepunkte.csv")
        lines = load("wienerlinien-ogd-linien.csv")
        routes = load("wienerlinien-ogd-fahrwegverlaeufe.csv")
    except Exception as e:  # noqa
        print("  Download fehlgeschlagen:", e)
        return
    line_by_id = {r.get("LineID"): r for r in lines}
    by_stop = {}
    for r in routes:
        sid = r.get("StopID")
        ln = line_by_id.get(r.get("LineID"))
        if not sid or not ln:
            continue
        d = by_stop.setdefault(sid, {"modes": set(), "lines": set()})
        d["modes"].add(ln.get("MeansOfTransport", ""))
        d["lines"].add(ln.get("LineText", ""))
    values = []
    for s in stops:
        sid = s.get("StopID")
        try:
            lat, lng = float(s.get("Latitude", "").replace(",", ".")), float(s.get("Longitude", "").replace(",", "."))
        except ValueError:
            continue
        if not sid or not (47.9 < lat < 48.6 and 15.9 < lng < 16.9):
            continue
        d = by_stop.get(sid, {"modes": set(), "lines": set()})
        modes = [m for m in d["modes"] if m]
        if not modes:
            continue
        arr = lambda xs: "array[" + ",".join(q(x) for x in sorted(xs)) + "]::text[]" if xs else "'{}'::text[]"
        values.append(f"({q(sid)},{q(s.get('DIVA',''))},{q(s.get('StopText',''))},{lat},{lng},{arr(modes)},{arr([l for l in d['lines'] if l])})")
    print(f"  {len(values)} Haltepunkte mit Linien")
    for i in range(0, len(values), 800):
        chunk = ",".join(values[i:i + 800])
        sql("insert into public.transit_stops(stop_id,diva,name,lat,lng,modes,lines) values " + chunk +
            " on conflict (stop_id) do update set name=excluded.name, lat=excluded.lat, lng=excluded.lng, modes=excluded.modes, lines=excluded.lines")
    print("  importiert")


if __name__ == "__main__":
    try:
        main()
    except urllib.error.HTTPError as e:
        print("HTTP-Fehler", e.code, e.read().decode()[:500])
        sys.exit(1)
