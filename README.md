# Kartenwert

Web-App zur Bewertung von Pokémon-Sammelkarten für den Wiederverkauf. Deutschsprachig, mobil zuerst, offline-fähig, ohne Login.

## Starten / Deployen

Reine statische Seite, kein Build-Schritt.

```bash
npm start          # http://localhost:8080  (python3 -m http.server)
npm test           # Rechenmodell-Tests (node --test)
```

Deploy: Ordner unverändert auf Cloudflare Pages, Netlify, GitHub Pages o. ä. hochladen.
Kamera und Service Worker brauchen HTTPS (bei allen genannten Hostern Standard).

## Datenquelle: TCGdex

- Basis `https://api.tcgdex.net/v2/{lang}`, kein Key.
- Zwei Schritte: `GET /cards?name=…` liefert nur CardBrief (id, localId, name, image), erst `GET /cards/{id}` liefert `pricing`.
- `pricing.cardmarket` (EUR): `avg, low, trend, avg1, avg7, avg30` und die Holo-Felder mit Bindestrich (`p["avg-holo"]` …). Wird nur per Klammerzugriff gelesen.
- `pricing.tcgplayer` (USD): Varianten-Objekte mit `lowPrice, midPrice, highPrice, marketPrice, directLowPrice`. Neben `normal`/`reverse` liefert die API in der Praxis auch `holofoil` u. a.; alle vorhandenen Varianten werden angezeigt (nur Info, nicht im Rechenmodell).
- **Alles in Euro:** TCGplayer-Werte werden zum EZB-Kurs (`api.frankfurter.dev`, kostenlos, CORS offen, 24 h gecacht) umgerechnet; Kurs und Kursdatum stehen daneben. Offline oder auf Wunsch gilt ein manueller Kurs aus den Einstellungen.
- Fehlende Marktplätze/Felder werden defensiv als „–“ behandelt.

Live geprüft am 17.11.2026:

| Punkt | Ergebnis |
|---|---|
| CORS | `Access-Control-Allow-Origin: *` auf API **und** Bildern → direkt aus dem Browser, kein Proxy nötig |
| Sprachen | en, de, fr, it, es, pt-br, ja, ko, zh-tw liefern Daten. Die App prüft das beim Start erneut (alle 7 Tage) und graut Sprachen mit 404 oder leerer Antwort aus |
| `localId=eq:97` | **liefert fälschlich 0 Treffer.** Mit Pipe-Liste (`eq:97\|097`) klappt es, deshalb fragt die App immer mehrere Schreibweisen ab |
| `name=glurak ex` vs. `glurak-ex` | unterschiedliche Treffer, die App fragt beide ab und führt sie zusammen |

Für den Notfall liegt in `proxy/cloudflare-worker.js` ein Minimal-Proxy (nur GET, 24 h Cache). URL in den Einstellungen unter „API-Basis-URL“ eintragen.

## Cardmarket / eBay

- Kein API-Abruf, kein Scraping. Nur Deep Links:
  - Cardmarket-Suche: `https://www.cardmarket.com/de/Pokemon/Products/Search?category=-1&searchString=…` mit dem **englischen** Kartennamen (Cardmarket-Produktnamen sind englisch; die App holt ihn über dieselbe TCGdex-ID aus `/v2/en`), zusätzlich mit dem lokalen Namen.
  - eBay verkauft: `https://www.ebay.de/sch/i.html?_nkw={suche}&LH_Sold=1&LH_Complete=1&_sop=13`, Suchbegriff editierbar.
- Gesehene Preise werden von Hand eingetragen oder als Text eingefügt („12,50 € 13,00 € …“).

## Navigation

Zurück-Pfeil oben links, „‹ Zurück“ in der Bewertung, Browser-Zurück und Wischen vom linken Bildschirmrand (wichtig in der Home-Bildschirm-App, die keine Safari-Geste hat).

## Live-Scanner

Suchen → Kamera → „Live-Scanner starten“: Kamerabild mit Kartenrahmen. Die App misst laufend Schärfe (Laplace-Varianz) und Bewegung im Nummernstreifen; ist das Bild scharf und ruhig, liest sie den Streifen per OCR. Zwei gleiche Lesungen = Treffer, dann startet die Nummernsuche automatisch. Wird der Schrägstrich als „7“/„1“ gelesen („0067165“), probiert die App die Trennstellen durch und akzeptiert nur Gesamtzahlen, die es als Set bei TCGdex gibt. Licht-Schalter, wenn das Gerät eine Taschenlampe anbietet. Alternativ „Foto aufnehmen“ oder „Aus Galerie“.

## Kamera-Eingabe

Foto → Ausschnitt der Unterkante bestätigen → OCR (Tesseract.js, **lokal in `vendor/` eingebunden**, funktioniert offline) → Nummer und Gesamtzahl werden zum Korrigieren angezeigt → Suche nach `localId`, gefiltert auf Sets mit passender Gesamtzahl (`cardCount.official` oder `total`). Erkennt die OCR nichts, springt die App zur Namenssuche.

## Rechenmodell

```
zustandsFaktor = CF[mein] / CF[Referenz]
sprachFaktor   = LF[mein] / LF[Referenz]
brutto  = referenz × zustandsFaktor × sprachFaktor
netto   = brutto × (1 − provision) − versand
maxGebot(p) = netto × p     p ∈ {85, 80, 75, 70 %}
gewinn(p)   = netto − maxGebot(p)
rendite(p)  = gewinn(p) / maxGebot(p)
```

Referenz: Median (Standard), Durchschnitt, Minimum der angehakten Angebote, `cardmarket.trend`/`avg7`/`avg30` (wahlweise Holo-Felder) oder ein eigener Wert. CF, LF, Provision, Versand und Netto-Minimum sind in den Einstellungen editierbar und werden lokal (IndexedDB) gespeichert. Versand ist standardmäßig 0 €, bitte eigenen Wert eintragen.

Gegenprobe (Test): englisch NM → deutsch LP = 0,45 × 0,63 = 0,2835. Rendite bei 70 % = 42,9 %.

## Preis je Zustand

TCGdex/Cardmarket-Preisindex hat **keine** getrennten Preise pro Zustand. Die Bewertung zeigt deshalb eine Tabelle MT … PO, abgeleitet aus der Referenz über `CF[Zustand] / CF[Referenzzustand]` × Sprachfaktor, mit Marktwert, Netto und Max. Gebot 80 %. Echte Angebote eines bestimmten Zustands (Cardmarket-Filter „Zustand“) trägst du unter „Angebote“ ein und stellst „Zustand der Referenz“ entsprechend ein.

## Bestand

Speichert Bild-URL, TCGdex-ID, Name, Set, Sprache, Zustand, Einkauf, Datum, Status, Verkauf, Notiz sowie den Preis-Snapshot mit Abrufdatum. Marktwert = Cardmarket-Feld (Standard `trend`) × Faktoren. Preise älter als 24 h werden beim Öffnen der App und alle 30 Minuten, solange sie offen ist, nachgeladen. Echte Hintergrund-Aktualisierung bei geschlossener App erlauben Browser für Web-Apps nicht zuverlässig. CSV-Export (Semikolon, Dezimalkomma, UTF-8 mit BOM für Excel) und JSON-Backup.

## Grading-Check

Eigener Reiter „Grading“: Foto vorne/hinten per Kamera oder aus der Galerie. Schritt „Begradigen“: die vier Kartenecken werden erkannt (Hintergrund-Maske, je Seite eine Ausgleichsgerade, Ecken = Schnittpunkte, klappt auch mit runden Ecken), lassen sich mit Lupe nachziehen, dann wird das Foto perspektivisch entzerrt (Homographie) und mit 4 % Rand gerade hingelegt. Test: schräg fotografierte Karte (9° gedreht, geschert) mit Soll 60/40 und 45/55 gemessen als 59,8/40,2 und 45/55. Danach automatische Erkennung von Außenkante und Innenrahmen (Startwerte), danach verschiebbare Linien mit Lupe. Zentrierung links/rechts und oben/unten in Prozent, Obergrenze nach PSA-Richtlinie (PSA 10 ≤ 60/40 vorne, ≤ 75/25 hinten; PSA 9 ≤ 65/35 und ≤ 90/10; …). Mängel per Antippen markieren (Oberfläche/Ecke/Kante, Art, leicht/mittel/stark, Notiz), Kantenfilter für Kratzer. Teilnoten automatisch (10 minus Abzüge 0,5/1,5/3), überschreibbar. Gesamtschätzung = niedrigste Teilnote, gedeckelt durch Zentrierung. Kein offizielles Grading.

Dokumentation: Fotos werden mit Messlinien und nummerierten Mängeln gespeichert; „Bericht teilen“ erzeugt ein PNG (Note, Teilnoten, Zentrierung, Fotos, Mängelliste) für das Teilen-Menü bzw. als Download. Im Bestand steht die Dokumentation bei der Karte.

Graded-Preise automatisch: über Pokemon Price Tracker (`/api/v2/cards?tcgPlayerId=…&includeEbay=true`, Antwort `ebay.salesByGrade` mit `psa10`, `psa9`, `cgc9_5`, `bgs10` …: Anzahl, Durchschnitt, Median, Min/Max, Trend, `smartMarketPrice`). Die exakte TCGplayer-ID liefert TCGdex mit (`pricing.tcgplayer.<variante>.productId`), daher keine Namensraterei; ohne ID Suche „Name Nummer/Gesamt“ mit `limit=1`. Kosten 2 Credits pro Karte (Free: 100/Tag), Abfrage nur per Knopf, Ergebnis 24 h im Gerät und im Worker gecacht. Der Schlüssel wird unter Optionen eingetragen und per Header `X-PPT-Key` an den eigenen Worker geschickt (alternativ als Worker-Secret `PPT_API_KEY`). Direkt aus dem Browser geht es nicht: die CORS-Vorabanfrage beantwortet die API mit 401.

Graded-Preise manuell: eBay-Deep-Link „verkauft“ mit Note (PSA 10, 9, … BGS, CGC), Preise je Note von Hand mit Median. Eine Graded-Preis-API ist nicht eingebunden (keine kostenlose ohne Anmeldung).

## Nicht enthalten

Bewusst weggelassen: Nutzerkonten, Marktplatz, Preisprognosen, Push-Benachrichtigungen, eBay-/Cardmarket-Abrufe. Der optionale Supabase-Sync ist nicht gebaut; alle Daten bleiben lokal auf dem Gerät (Backup per JSON).

## Struktur

```
index.html  css/app.css  sw.js  manifest.webmanifest  icons/
js/app.js    Oberfläche
js/api.js    TCGdex-Zugriff, Cache, pricing-Auslese
js/calc.js   Rechenmodell (rein, getestet)
js/db.js     IndexedDB
js/ocr.js    Texterkennung
vendor/tesseract/   Tesseract.js 5.1.1 + Kern + eng-Sprachdaten (Apache-2.0)
proxy/       optionaler Cloudflare Worker
tests/       node --test
```
