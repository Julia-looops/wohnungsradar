-- immowelt: Such-URL korrigiert (alte Form liefert HTTP 410)
update public.sources set urls = array['https://www.immowelt.at/suche/wien/wohnungen/kaufen'] where id = 'immowelt';
