-- Wohnungsradar Wien – Grundschema
-- Alle Tabellen sind RLS-geschützt und ohne Policies: Zugriff ausschließlich über
-- Edge Functions mit dem Secret Key. Die App spricht nur mit der Function "api".

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ---------------------------------------------------------------------------
-- Einstellungen (Key/Value)
-- ---------------------------------------------------------------------------
create table if not exists public.settings (
  key text primary key,
  value jsonb not null default 'null'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.settings enable row level security;

-- ---------------------------------------------------------------------------
-- Kriterien (genau eine Zeile, id = 1)
-- ---------------------------------------------------------------------------
create table if not exists public.criteria (
  id int primary key default 1 check (id = 1),
  doc jsonb not null,
  version int not null default 1,
  updated_at timestamptz not null default now()
);
alter table public.criteria enable row level security;

-- ---------------------------------------------------------------------------
-- Quellen
-- ---------------------------------------------------------------------------
create table if not exists public.sources (
  id text primary key,
  name text not null,
  kind text not null check (kind in ('apify','html','ai')),
  urls text[] not null default '{}',
  enabled boolean not null default true,
  config jsonb not null default '{}'::jsonb,
  last_run_at timestamptz,
  last_status text,
  last_count int,
  last_new int,
  last_error text,
  sort int not null default 100
);
alter table public.sources enable row level security;

-- ---------------------------------------------------------------------------
-- Inserate
-- ---------------------------------------------------------------------------
create table if not exists public.listings (
  id uuid primary key default gen_random_uuid(),
  source text not null references public.sources(id),
  source_id text not null,
  url text not null,
  title text,
  price integer,
  area_m2 numeric,
  rooms numeric,
  plz text,
  district int,
  address text,
  lat double precision,
  lng double precision,
  floor text,
  features jsonb not null default '[]'::jsonb,
  images text[] not null default '{}',
  raw_text text,
  raw jsonb,
  dedupe_key text,
  duplicate_of uuid references public.listings(id) on delete set null,
  seller_type text,
  published_at timestamptz,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  active boolean not null default true,
  enriched_at timestamptz,
  scored_at timestamptz,
  notified_at timestamptz,
  score_stale boolean not null default true,
  unique (source, source_id)
);
create index if not exists listings_dedupe_idx on public.listings(dedupe_key);
create index if not exists listings_active_idx on public.listings(active) where active;
create index if not exists listings_url_idx on public.listings(url);
alter table public.listings enable row level security;

-- ---------------------------------------------------------------------------
-- Anreicherung
-- ---------------------------------------------------------------------------
create table if not exists public.enrichments (
  listing_id uuid primary key references public.listings(id) on delete cascade,
  geocode jsonb,
  noise jsonb,
  transit jsonb,
  green jsonb,
  price_ctx jsonb,
  zoning jsonb,
  flood jsonb,
  links jsonb,
  orientation text,
  errors jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.enrichments enable row level security;

-- ---------------------------------------------------------------------------
-- Bewertung durch Claude
-- ---------------------------------------------------------------------------
create table if not exists public.scores (
  listing_id uuid primary key references public.listings(id) on delete cascade,
  score int,
  claude_score int,
  hard_ok boolean,
  hard_fail text[] not null default '{}',
  assessment jsonb,          -- pro Kriterium: erfuellt | unklar | nicht
  reasoning text,
  warnings text[] not null default '{}',
  model text,
  criteria_version int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists scores_score_idx on public.scores(score desc);
alter table public.scores enable row level security;

-- ---------------------------------------------------------------------------
-- Bewertung durch die Nutzerin
-- ---------------------------------------------------------------------------
create table if not exists public.ratings (
  listing_id uuid primary key references public.listings(id) on delete cascade,
  stars int check (stars between 1 and 5),
  note text,
  status text not null default 'neu' check (status in ('neu','favorit','besichtigt','abgesagt')),
  updated_at timestamptz not null default now()
);
alter table public.ratings enable row level security;

-- ---------------------------------------------------------------------------
-- Lernen
-- ---------------------------------------------------------------------------
create table if not exists public.learning_notes (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  kind text not null default 'daily' check (kind in ('daily','weekly')),
  note text not null,
  insights jsonb,
  applied jsonb,
  based_on_ratings int not null default 0,
  model text
);
alter table public.learning_notes enable row level security;

create table if not exists public.proposals (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  text text not null,
  change jsonb not null,
  status text not null default 'offen' check (status in ('offen','angenommen','abgelehnt')),
  decided_at timestamptz
);
alter table public.proposals enable row level security;

-- ---------------------------------------------------------------------------
-- Push
-- ---------------------------------------------------------------------------
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  endpoint text not null unique,
  subscription jsonb not null,
  label text,
  created_at timestamptz not null default now(),
  last_ok timestamptz,
  failures int not null default 0,
  active boolean not null default true
);
alter table public.push_subscriptions enable row level security;

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.listings(id) on delete cascade,
  subscription_id uuid references public.push_subscriptions(id) on delete set null,
  sent_at timestamptz not null default now(),
  ok boolean not null,
  detail text
);
alter table public.notifications enable row level security;

-- ---------------------------------------------------------------------------
-- Läufe
-- ---------------------------------------------------------------------------
create table if not exists public.runs (
  id uuid primary key default gen_random_uuid(),
  fn text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  ok boolean,
  summary jsonb,
  error text
);
create index if not exists runs_started_idx on public.runs(started_at desc);
alter table public.runs enable row level security;

-- ---------------------------------------------------------------------------
-- Referenzdaten
-- ---------------------------------------------------------------------------
create table if not exists public.transit_stops (
  stop_id text primary key,
  diva text,
  name text,
  lat double precision not null,
  lng double precision not null,
  modes text[] not null default '{}',
  lines text[] not null default '{}'
);
alter table public.transit_stops enable row level security;

create table if not exists public.district_prices (
  district int primary key,
  plz text not null,
  name text not null,
  avg_eur_m2 int not null,
  size_51_80 int,
  as_of text not null,
  source text not null
);
alter table public.district_prices enable row level security;

create table if not exists public.geocode_cache (
  address text primary key,
  lat double precision,
  lng double precision,
  display text,
  created_at timestamptz not null default now()
);
alter table public.geocode_cache enable row level security;

-- ---------------------------------------------------------------------------
-- Nächste Haltestellen (Haversine, kein PostGIS nötig)
-- ---------------------------------------------------------------------------
create or replace function public.nearest_stops(p_lat double precision, p_lng double precision, p_limit int default 6)
returns table(stop_id text, name text, modes text[], lines text[], dist_m int)
language sql stable as $$
  select s.stop_id, s.name, s.modes, s.lines,
    round(6371000 * acos(least(1.0,
      cos(radians(p_lat)) * cos(radians(s.lat)) * cos(radians(s.lng) - radians(p_lng))
      + sin(radians(p_lat)) * sin(radians(s.lat)))))::int as dist_m
  from public.transit_stops s
  where s.lat between p_lat - 0.02 and p_lat + 0.02
    and s.lng between p_lng - 0.03 and p_lng + 0.03
  order by dist_m asc
  limit p_limit;
$$;

-- ---------------------------------------------------------------------------
-- Aufruf einer Edge Function aus pg_cron (Secrets aus Vault)
-- ---------------------------------------------------------------------------
create or replace function public.radar_call(fn text, body jsonb default '{}'::jsonb)
returns bigint
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  v_url text;
  v_key text;
  v_id bigint;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'radar_functions_url' limit 1;
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'radar_secret_key' limit 1;
  if v_url is null or v_key is null then
    raise warning 'radar_call: Vault-Secrets radar_functions_url / radar_secret_key fehlen';
    return null;
  end if;
  select net.http_post(
    url := v_url || '/' || fn,
    headers := jsonb_build_object('Content-Type', 'application/json', 'apikey', v_key, 'x-radar-cron', '1'),
    body := body,
    timeout_milliseconds := 150000
  ) into v_id;
  return v_id;
end;
$$;
revoke all on function public.radar_call(text, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Zeitpläne (UTC). 04:30 UTC = 06:30 MESZ / 05:30 MEZ.
-- ---------------------------------------------------------------------------
do $$
declare j record;
begin
  for j in select jobname from cron.job where jobname like 'radar_%' loop
    perform cron.unschedule(j.jobname);
  end loop;
end $$;

select cron.schedule('radar_collect',        '30 4 * * *',  $$select public.radar_call('collect')$$);
select cron.schedule('radar_enrich_catchup', '*/15 5-7 * * *', $$select public.radar_call('enrich')$$);
select cron.schedule('radar_score_catchup',  '5,35 5-7 * * *', $$select public.radar_call('score')$$);
select cron.schedule('radar_notify_catchup', '10,40 5-7 * * *', $$select public.radar_call('notify')$$);
select cron.schedule('radar_learn_daily',    '0 8 * * *',   $$select public.radar_call('learn', '{"mode":"daily"}'::jsonb)$$);
select cron.schedule('radar_learn_weekly',   '0 9 * * 0',   $$select public.radar_call('learn', '{"mode":"weekly"}'::jsonb)$$);
select cron.schedule('radar_runs_cleanup',   '0 3 * * *',   $$delete from public.runs where started_at < now() - interval '60 days'$$);
