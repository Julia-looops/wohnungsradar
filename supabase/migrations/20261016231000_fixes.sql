-- Nachträge (die Anhänge an 20261016230000 wurden nicht mehr ausgeführt, weil die Migration schon angewendet war)
delete from public.listings where source <> 'willhaben' and (title ilike '%ImmoScout24' or title ilike 'Wohnung kaufen in Wien%');
update public.listings set score_stale = true where id in (select listing_id from public.scores where score is null);
-- Modelle laut API-Modellliste vom 17.10.2026
update public.settings set value = '"claude-sonnet-5-5"'::jsonb, updated_at = now() where key in ('model_score','model_learn');
update public.settings set value = '"claude-haiku-5-5"'::jsonb, updated_at = now() where key = 'model_extract';
