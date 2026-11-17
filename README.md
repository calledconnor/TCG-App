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

## Bestand

Speichert Bild-URL, TCGdex-ID, Name, Set, Sprache, Zustand, Einkauf, Datum, Status, Verkauf, Notiz sowie den Preis-Snapshot mit Abrufdatum. Marktwert = Cardmarket-Feld (Standard `trend`) × Faktoren. Preise älter als 24 h werden beim Öffnen der App und alle 30 Minuten, solange sie offen ist, nachgeladen. Echte Hintergrund-Aktualisierung bei geschlossener App erlauben Browser für Web-Apps nicht zuverlässig. CSV-Export (Semikolon, Dezimalkomma, UTF-8 mit BOM für Excel) und JSON-Backup.

## Nicht enthalten

Bewusst weggelassen: Nutzerkonten, Marktplatz, Preisprognosen, Push-Benachrichtigungen, Bewertung gegradeter Karten, eBay-/Cardmarket-Abrufe. Der optionale Supabase-Sync ist nicht gebaut; alle Daten bleiben lokal auf dem Gerät (Backup per JSON).

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
