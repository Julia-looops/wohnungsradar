-- Push-Schwelle auf 60: die Bewertung ist bewusst streng (Unbelegtes zählt nicht), 70 wird selten erreicht
update public.criteria set doc = jsonb_set(doc, '{alert_threshold}', '60'::jsonb), updated_at = now() where id = 1 and (doc->>'alert_threshold')::int = 70;
