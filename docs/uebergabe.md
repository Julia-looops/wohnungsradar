# Wohnungsradar Wien – so funktioniert er

Stand: 16. Oktober 2026

## Dein Link

**https://julia-looops.github.io/wohnungsradar/?t=M2tcUrW50PxaKxlu3xBFKFDCMeHL**

Der Link enthält deinen Zugangsschlüssel. Einmal geöffnet, merkt sich das Gerät den Zugang; danach reicht die Adresse ohne den Teil hinter dem Fragezeichen. Gib den Link nicht weiter – wer ihn hat, sieht alles und kann bewerten.

## Auf dem Handy installieren

iPhone: Link in Safari öffnen → unten das Teilen-Symbol → „Zum Home-Bildschirm“ → „Hinzufügen“. Push-Nachrichten funktionieren auf dem iPhone nur in der so installierten App, nicht im Safari-Tab.

Android: Link in Chrome öffnen → Menü (drei Punkte) → „App installieren“ oder „Zum Startbildschirm hinzufügen“.

Danach in der App unter **Einstellungen** auf „Push einschalten“ tippen und die Nachfrage erlauben. Mit „Test“ kommt sofort eine Probenachricht.

## Was der Radar jeden Tag macht

Jeden Morgen gegen halb sieben sammelt er neue Eigentumswohnungen aus willhaben und weiteren Portalen, Bauträger- und Genossenschaftsseiten. Er behält nur, was in deinen Bezirken liegt und höchstens 350.000 € kostet. Dann schaut er für jede Wohnung nach, wie laut es dort ist (Lärmkarte), wie weit U-Bahn und Bim sind, wie viel Grün in der Nähe ist, ob der Preis pro m² über oder unter dem Bezirksschnitt liegt, ob die Adresse in einer Hochwasserzone liegt und wie das Grundstück gewidmet ist. Zum Schluss liest Claude das Inserat samt diesen Daten und vergibt einen Score von 0 bis 100 mit einer Begründung in drei Sätzen und Warnsignalen (zum Beispiel „Anlegerwohnung“, „vermietet“, „laute Straße“, „Sanierungsbedarf“).

Liegt der Score über deiner Schwelle (anfangs 60 – die Bewertung ist streng, weil Unbelegtes nie als erfüllt zählt), bekommst du eine Push-Nachricht – pro Wohnung genau eine. Antippen öffnet die Detailansicht.

## Die App

**Liste** – sortiert nach Score. Oben die Filter: Neu (noch nicht bewertet), Favoriten, Besichtigt, Abgesagt, Alle. „Ausgeschlossene“ zeigt zusätzlich Wohnungen, die ein hartes Kriterium verletzen (zum Beispiel vermietet oder kein Lift und nicht Erdgeschoss).

**Karte** – jede Wohnung ein Pin, Farbe = Score (grün gut, rot schlecht), gelber Rand = schon von dir bewertet. Oben rechts lassen sich Lärm, Öffis und Grünflächen einblenden.

**Detail** – Fotos, Fakten, Claudes Begründung mit Häkchen pro Kriterium, Umfeld-Daten, Links „Zum Inserat“, „Street View“, „Lärmkarte“, „Flächenwidmung“, „HORA Hochwasser“. Darunter deine Bewertung.

**Einstellungen** – alle Kriterien, Gewichte, Bezirke, die Push-Schwelle, Vorschläge aus dem Lernen, Quellen und die letzten Läufe.

## Bewerten – und was die Sterne bewirken

Gib Sterne (1 = gar nicht, 5 = sofort besichtigen), setze den Status (Favorit, Besichtigt, Abgesagt) und schreib in den Freitext, was dir gefällt oder stört – zwei, drei ehrliche Sätze reichen („zu dunkel, Hinterhof“, „Lage super, aber Küche müsste neu“).

Daraus lernt der Radar jeden Tag: Ab drei Bewertungen entsteht eine Lernnotiz („mag helle Altbauten mit Balkon, fällt bei Gürtelnähe durch“), die Claude bei jeder weiteren Bewertung mitliest. Kleine Anpassungen der Gewichte (um einen Punkt) macht er selbst; größere Änderungen und Fragen wie „Soll ich den 5. Bezirk künftig ausschließen?“ erscheinen als Vorschlag in den Einstellungen, wo du mit Ja oder Nein antwortest. Sonntags gibt es einen Wochenrückblick als Push, danach werden alle Wohnungen mit dem neuen Wissen neu bewertet.

Deine Sterne ändern nicht den Score der bewerteten Wohnung selbst – sie ändern, wie der Radar neue Wohnungen beurteilt.

## Einstellungen ändern

Gewichte wirken sofort auf alle Scores. Andere Änderungen (Bezirke, Preis, Hinweise) wirken ab dem nächsten Lauf – oder sofort mit „Jetzt neu bewerten“ (dauert ein paar Minuten). „Jetzt sammeln“ holt außerplanmäßig neue Inserate.

Bezirke antippen: aus → ganz → teilweise. Bei „teilweise“ schreib ins Notizfeld, welche Grätzl gemeint sind (eine Zeile pro Bezirk, z. B. „2: nur Prater-Nähe und Karmeliterviertel“) – Claude beurteilt die Lage dann danach.

## Was du wissen solltest

- willhaben ist die verlässlichste Quelle. Die anderen Portale und Bauträgerseiten liest der Radar direkt; wenn eine Seite nichts liefert oder sich umbaut, steht das in den Einstellungen bei „Quellen“ (Punkt rot). Der Lauf geht dann mit den übrigen Quellen weiter.
- Lärm-, Öffi- und Grünwerte sind automatisch ermittelt und eine Orientierung, keine Garantie. Bei Inseraten ohne genaue Adresse wird der Bezirksmittelpunkt genommen; das steht dann bei „Koordinaten“ (plz).
- Preisvergleich: Angebotspreise je Bezirk (derStandard Immobilien, Stand April 2026). Jährlich aktualisieren.
- Alles läuft automatisch in der Cloud (Supabase, GitHub Pages, Anthropic, Apify) und kostet im Monat wenige Euro an API-Guthaben. Bewertet wird mit Claude Sonnet 5.5, Seiten liest Claude Haiku 5.5; fällt ein Modellname weg, nimmt der Radar automatisch das neueste der Familie.
- Push wurde am 17.10.2026 in Julias Chrome erfolgreich getestet; am iPhone bitte nach der Installation einmal „Test“ drücken.

## Für Julia: Technik in Kürze

Code und Deployment: github.com/Julia-looops/wohnungsradar – jeder Push auf main deployt Datenbank und Functions (Workflow „Deploy Supabase“) und die App (Workflow „Deploy App“). Jeder Deploy schreibt einen Bericht mit Funktionstest, Quellenstatus und Top-Inseraten in Issue #1 „Deploy-Log“. Commit-Marker „[collect]“ startet danach einen Sammellauf, „[enrich]“ die Kette Anreicherung → Bewertung → Push. Secrets liegen als GitHub-Secrets (Deploy) und Supabase-Secrets (Functions), nie im Code. Zeitpläne laufen per pg_cron in UTC. Eine Kopie des Codes liegt in diesem Ordner unter „wohnungsradar“; die Datei „Betrieb“ im Claude-Projekt „Privat“ (claude/wohnungsradar-betrieb.md) hat alle Details.
