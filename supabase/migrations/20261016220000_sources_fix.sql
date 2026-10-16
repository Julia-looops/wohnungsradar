-- Quellen-URLs nach erstem Testlauf korrigiert (16.10.2026)
update public.sources set urls = array['https://www.immowelt.at/suche/wien/wohnungen/kaufen'] where id = 'immowelt';
update public.sources set urls = array['https://www.findmyhome.at/'] , config = config || '{"hint":"Startseite: Links zu Eigentumswohnungen in Wien verfolgen; Mietwohnungen ignorieren."}'::jsonb where id = 'findmyhome';
update public.sources set urls = array['https://www.buwog.at/'] where id = 'buwog';
update public.sources set urls = array['https://www.are.at/'] where id = 'are';
update public.sources set urls = array['https://www.glorit.at/'] where id = 'glorit';
update public.sources set urls = array['https://www.3si.at/'] where id = '3si';
update public.sources set urls = array['https://www.jpi.at/'] where id = 'jpi';
update public.sources set urls = array['https://www.sozialbau.at/'] where id = 'sozialbau';
update public.sources set urls = array['https://www.oevw.at/'] where id = 'oevw';
update public.sources set urls = array['https://www.wiensued.at/'] where id = 'wiensued';
update public.sources set urls = array['https://edikte.justiz.gv.at/'] , config = config || '{"hint":"Justiz-Ediktsdatei: nur Versteigerungen von Wohnungseigentum in Wien; Schätzwert als Preis."}'::jsonb where id = 'edikte';
update public.sources set enabled = false, last_error = 'Website-Adresse unbekannt – bitte in den Quellen eintragen' where id = 'wkw';
-- Übersichtsseiten, die fälschlich als Inserat gespeichert wurden, entfernen
delete from public.listings where source <> 'willhaben' and price is null and area_m2 is null and rooms is null;
