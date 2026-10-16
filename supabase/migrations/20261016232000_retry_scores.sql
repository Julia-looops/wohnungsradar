update public.listings set score_stale = true where id in (select listing_id from public.scores where score is null);
