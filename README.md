# Wohnungsradar Wien

Private Suche nach einer Eigentumswohnung in Wien zum Selbstbezug: Sammler, Anreicherung, Bewertung durch Claude, PWA mit Karte und Push, Lernen aus Sternen und Freitext.

## Aufbau

- `supabase/migrations` – Datenbank (Postgres), pg_cron-Zeitpläne, Startdaten (Kriterien, Quellen, Bezirkspreise)
- `supabase/functions` – Edge Functions: `collect`, `enrich`, `score`, `notify`, `learn`, `api` (+ `_shared`)
- `app` – PWA (reines HTML/JS, Leaflet), veröffentlicht über GitHub Pages
- `scripts/post_deploy.py` – Vault-Secrets, App-Token, VAPID, Haltestellen-Import (läuft in GitHub Actions)
- `docs` – Übergabe und Betrieb

## Ablauf (täglich, Zeiten UTC)

1. 04:30 `collect` – willhaben (Apify) und direkte Quellen, in Portionen; filtert auf Bezirksliste und Preisobergrenze
2. danach automatisch `enrich` → `score` → `notify` (Kette; Auffang-Zeitpläne 05–07 Uhr)
3. 08:00 `learn` (täglich), sonntags 09:00 Wochen-Digest mit voller Neubewertung

## Deployment

Push auf `main` löst zwei GitHub-Actions-Workflows aus: *Deploy Supabase* (Migrationen, Functions, Secrets) und *Deploy App* (GitHub Pages).
Benötigte Repo-Secrets: `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, `SUPABASE_SECRET_KEY`, `APP_TOKEN`.
Supabase-Secrets (im Dashboard gesetzt): `ANTHROPIC_API_KEY`, `APIFY_TOKEN`; `VAPID_*` werden beim ersten Deployment erzeugt.

Geheimnisse stehen nie im Code. Die App erreicht die Daten ausschließlich über die Function `api` mit dem App-Token aus dem Link.
