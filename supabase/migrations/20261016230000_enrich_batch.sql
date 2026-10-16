update public.settings set value = '6'::jsonb, updated_at = now() where key = 'enrich_batch';
