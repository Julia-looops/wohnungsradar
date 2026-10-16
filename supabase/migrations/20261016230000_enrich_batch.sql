update public.settings set value = '6'::jsonb, updated_at = now() where key = 'enrich_batch';
delete from public.listings where source <> 'willhaben' and (title ilike '%ImmoScout24' or title ilike 'Wohnung kaufen in Wien%');
update public.listings set score_stale = true where id in (select listing_id from public.scores where score is null);
