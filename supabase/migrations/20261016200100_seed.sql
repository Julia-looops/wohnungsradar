-- Startdaten: Kriterien, Quellen, Bezirkspreise, Einstellungen

insert into public.settings (key, value) values
  ('model_score',   '"claude-sonnet-4-5"'),
  ('model_extract', '"claude-haiku-4-5"'),
  ('model_learn',   '"claude-sonnet-4-5"'),
  ('app_url',       '"https://julia-looops.github.io/wohnungsradar/"'),
  ('push_subject',  '"mailto:wohnungsradar@example.org"'),
  ('vapid_public',  'null'),
  ('noise_api',     '"https://gis.lfrz.gv.at/api/geodata/i000804/ogc/features/v1"'),
  ('wien_wfs',      '"https://data.wien.gv.at/daten/geo"'),
  ('collect_max_per_source', '60'),
  ('score_batch', '10'),
  ('enrich_batch', '20')
on conflict (key) do nothing;

insert into public.criteria (id, doc, version) values (1, $json$
{
  "hard": {
    "max_price": 350000,
    "min_rooms": 2,
    "min_area_m2": 50,
    "selbstbezug": true,
    "lift_or_ground": true
  },
  "districts": {
    "1": "ganz", "3": "ganz", "4": "ganz", "5": "ganz", "6": "ganz", "7": "ganz", "8": "ganz", "9": "ganz",
    "13": "ganz", "18": "ganz", "19": "ganz",
    "2": "teilweise", "12": "teilweise", "14": "teilweise", "16": "teilweise", "17": "teilweise"
  },
  "district_notes": {
    "2": "nur Prater-Nähe und Karmeliterviertel",
    "12": "nur gute Grätzl nahe Westbahn/Wienerwald-Seite, nicht Meidlinger Hauptstraße Süd",
    "14": "nur gute Grätzl nahe Westbahn/Wienerwald (Hütteldorf, Hadersdorf, Baumgarten)",
    "16": "nur gute Grätzl Richtung Wilhelminenberg/Ottakringer Bad, nicht Gürtelnähe",
    "17": "nur gute Grätzl Richtung Dornbach/Neuwaldegg, nicht Gürtelnähe",
    "_allgemein": "Nur westlich der Donau. 21. und 22. Bezirk nie. 10, 11, 15, 20, 23 nicht."
  },
  "soft": [
    {"key": "balkon",        "label": "Balkon, Loggia oder Terrasse",             "weight": 3},
    {"key": "badewanne",     "label": "Badewanne",                                 "weight": 2},
    {"key": "keller",        "label": "Keller",                                    "weight": 2},
    {"key": "abstellraum",   "label": "Abstellraum",                               "weight": 1},
    {"key": "ruhig",         "label": "Ruhige Lage",                               "weight": 3},
    {"key": "ausblick",      "label": "Ausblick, nicht direkt aufs Nachbarfenster","weight": 2},
    {"key": "zustand",       "label": "Guter Zustand, wenig Sanierungsbedarf",     "weight": 3},
    {"key": "provisionsfrei","label": "Provisionsfrei",                            "weight": 2},
    {"key": "betriebskosten","label": "Betriebskosten höchstens ca. 4 €/m²",       "weight": 2},
    {"key": "lift",          "label": "Lift (besser als Erdgeschoss)",             "weight": 1},
    {"key": "oeffi",         "label": "U-Bahn oder Bim in höchstens 8 Gehminuten", "weight": 2},
    {"key": "gruen",         "label": "Grünraum in der Nähe",                      "weight": 1},
    {"key": "preis_m2",      "label": "Preis pro m² unter dem Bezirksschnitt",     "weight": 2}
  ],
  "weight_band": {"min": 0, "max": 5, "auto_step": 1},
  "alert_threshold": 70,
  "notes": "",
  "exclude_terms": ["Anlegerwohnung", "Vorsorgewohnung", "Bauherrenmodell", "Zinshaus", "Rohdachboden", "Wohnungspaket"]
}
$json$::jsonb, 1)
on conflict (id) do nothing;

insert into public.sources (id, name, kind, urls, enabled, config, sort) values
  ('willhaben', 'willhaben.at (über Apify)', 'apify',
    array['https://www.willhaben.at/iad/immobilien/eigentumswohnung/eigentumswohnung-angebote?areaId=900&PRICE_TO=350000&ESTATE_SIZE/LIVING_AREA_FROM=50&rows=60&page=1&sort=1'],
    true, '{"actor":"blackfalcondata~willhaben-all-scraper","maxResults":60,"incremental":true,"stateKey":"wohnungsradar-wien"}', 1),
  ('derstandard', 'derStandard Immobilien', 'ai',
    array['https://immobilien.derstandard.at/immobiliensuche/wien/kaufen-wohnung?priceTo=350000&sort=new'], true, '{"pages":2}', 10),
  ('immowelt', 'immowelt.at', 'ai',
    array['https://www.immowelt.at/suche/kaufen/wohnung/wien/wien?sort=relevanz'], true, '{"pages":2}', 11),
  ('findmyhome', 'findmyhome.at', 'ai',
    array['https://www.findmyhome.at/wohnung-kaufen-in-wien'], true, '{"pages":2}', 12),
  ('wohnnet', 'wohnnet.at', 'ai',
    array['https://www.wohnnet.at/immobilien/eigentumswohnungen/wien'], true, '{"pages":2}', 13),
  ('immoscout24', 'immobilienscout24.at', 'ai',
    array['https://www.immobilienscout24.at/regional/wien/wien/wohnung-kaufen'], true, '{"pages":2}', 14),
  ('edikte', 'edikte.justiz.gv.at (Zwangsversteigerungen)', 'ai',
    array['https://edikte.justiz.gv.at/edikte/ex/exedi3.nsf/suchedi?OpenForm&subf=e'], true, '{"pages":1,"hint":"Versteigerungsedikte: Wohnungseigentum in Wien. Schätzwert als Preis verwenden."}', 20),
  ('buwog', 'BUWOG', 'ai', array['https://www.buwog.at/de/wohnen/kaufen'], true, '{"pages":1,"project":true}', 30),
  ('are', 'ARE Austrian Real Estate', 'ai', array['https://www.are.at/wohnen/'], true, '{"pages":1,"project":true}', 31),
  ('glorit', 'Glorit', 'ai', array['https://www.glorit.at/wohnungen/'], true, '{"pages":1,"project":true}', 32),
  ('3si', '3SI Immogroup', 'ai', array['https://www.3si.at/projekte/'], true, '{"pages":1,"project":true}', 33),
  ('jpi', 'JP Immobilien', 'ai', array['https://www.jpi.at/wohnen/kaufen'], true, '{"pages":1,"project":true}', 34),
  ('wkw', 'Wiener Komfortwohnungen', 'ai', array['https://www.wiener-komfortwohnungen.at/'], true, '{"pages":1,"project":true}', 35),
  ('sozialbau', 'Sozialbau (Eigentum)', 'ai', array['https://www.sozialbau.at/wohnungsangebot/'], true, '{"pages":1,"project":true,"hint":"Nur Eigentumswohnungen, keine Mietwohnungen."}', 40),
  ('oevw', 'ÖVW (Eigentum)', 'ai', array['https://www.oevw.at/wohnungssuche/'], true, '{"pages":1,"project":true,"hint":"Nur Eigentumswohnungen, keine Mietwohnungen."}', 41),
  ('wiensued', 'Wien-Süd (Eigentum)', 'ai', array['https://www.wiensued.at/wohnungsangebot'], true, '{"pages":1,"project":true,"hint":"Nur Eigentumswohnungen, keine Mietwohnungen."}', 42),
  ('privatimmobilien', 'privatimmobilien.at', 'ai', array['https://www.privatimmobilien.at/'], true, '{"pages":1}', 50)
on conflict (id) do nothing;

-- Preisspiegel Wohnungen Kauf, Angebotspreise, Durchschnitt €/m² (derStandard/immopreise.at, Datenbasis April 2026)
insert into public.district_prices (district, plz, name, avg_eur_m2, size_51_80, as_of, source) values
  (1,'1010','Innere Stadt',18281,14653,'2026-04','derStandard immopreise.at'),
  (2,'1020','Leopoldstadt',8467,7627,'2026-04','derStandard immopreise.at'),
  (3,'1030','Landstraße',7938,7462,'2026-04','derStandard immopreise.at'),
  (4,'1040','Wieden',10720,10271,'2026-04','derStandard immopreise.at'),
  (5,'1050','Margareten',8000,8280,'2026-04','derStandard immopreise.at'),
  (6,'1060','Mariahilf',8358,8371,'2026-04','derStandard immopreise.at'),
  (7,'1070','Neubau',8539,7784,'2026-04','derStandard immopreise.at'),
  (8,'1080','Josefstadt',8170,6425,'2026-04','derStandard immopreise.at'),
  (9,'1090','Alsergrund',9734,9454,'2026-04','derStandard immopreise.at'),
  (10,'1100','Favoriten',5516,5152,'2026-04','derStandard immopreise.at'),
  (11,'1110','Simmering',5641,5444,'2026-04','derStandard immopreise.at'),
  (12,'1120','Meidling',6236,6061,'2026-04','derStandard immopreise.at'),
  (13,'1130','Hietzing',9632,9426,'2026-04','derStandard immopreise.at'),
  (14,'1140','Penzing',6610,6408,'2026-04','derStandard immopreise.at'),
  (15,'1150','Rudolfsheim-Fünfhaus',5625,5530,'2026-04','derStandard immopreise.at'),
  (16,'1160','Ottakring',6384,6297,'2026-04','derStandard immopreise.at'),
  (17,'1170','Hernals',7243,6858,'2026-04','derStandard immopreise.at'),
  (18,'1180','Währing',8324,7736,'2026-04','derStandard immopreise.at'),
  (19,'1190','Döbling',8745,8043,'2026-04','derStandard immopreise.at'),
  (20,'1200','Brigittenau',6434,6037,'2026-04','derStandard immopreise.at'),
  (21,'1210','Floridsdorf',6328,6089,'2026-04','derStandard immopreise.at'),
  (22,'1220','Donaustadt',6809,6574,'2026-04','derStandard immopreise.at'),
  (23,'1230','Liesing',6468,6371,'2026-04','derStandard immopreise.at')
on conflict (district) do update set avg_eur_m2 = excluded.avg_eur_m2, size_51_80 = excluded.size_51_80, as_of = excluded.as_of, source = excluded.source;
