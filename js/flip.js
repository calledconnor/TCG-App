// Flip-Kalkulation: Preisempfehlung je Karte, Verkaufsergebnis, Kasse (Pott) und Kennzahlen.
// Reine Funktionen (testbar mit node).

/** Preis auf „,x9“ abrunden (6,17 → 6,09), unter 1 € auf Cent. */
export function roundPrice(v) {
  if (!Number.isFinite(v) || v <= 0) return null;
  if (v < 1) return Math.round(v * 100) / 100;
  // größter Preis mit ,x9 Cent, der nicht über v liegt (in ganzen Cent rechnen)
  const c = Math.floor((Math.round(v * 100) - 9) / 10) * 10 + 9;
  return Math.max(0.99, c / 100);
}

/**
 * Preiskalkulation für eine Karte im Bestand.
 * markt: aktueller Marktwert deiner Karte (Zustand/Sprache berücksichtigt), provision als Anteil, versand in €.
 * undercut: so viel unter Markt anbieten, dass es realistisch verkauft (Anteil). marge: Wunschmarge auf den Einkauf.
 */
export function kalkulation({ einkauf, markt, provision, versand, undercut = 0.05, marge = 0.2 }) {
  const ek = Number.isFinite(einkauf) ? einkauf : 0;
  const breakEven = (ek + versand) / (1 - provision);
  const zielpreis = (ek * (1 + marge) + versand) / (1 - provision);
  const angebot = Number.isFinite(markt) ? roundPrice(markt * (1 - undercut)) : null;
  if (angebot == null) return { breakEven, zielpreis, angebot: null };
  const netto = angebot * (1 - provision) - versand;
  const db = netto - ek;
  return {
    breakEven, zielpreis, angebot, netto, db,
    dbQuote: angebot > 0 ? db / angebot : null,
    roi: ek > 0 ? db / ek : null,
    verlust: angebot < breakEven,
    unterZiel: angebot < zielpreis,
  };
}

/** Ergebnis eines Verkaufs. */
export function verkaufsErgebnis({ verkauf, provision, versand, einkauf }) {
  const ek = Number.isFinite(einkauf) ? einkauf : 0;
  const netto = verkauf * (1 - provision) - versand;
  const db = netto - ek;
  return { netto, db, dbQuote: verkauf > 0 ? db / verkauf : null, roi: ek > 0 ? db / ek : null };
}

const dayDiff = (a, b) => {
  const da = new Date(a), dbb = new Date(b);
  if (isNaN(da) || isNaN(dbb)) return null;
  return Math.max(0, Math.round((dbb - da) / 86400000));
};

/**
 * Kasse und Kennzahlen.
 * items: Sammlung; marktwert(it) → aktueller Wert; platform(it) → { provision, versand } für den Verkauf.
 * erloes(it) optional: realistischer Netto-Erlös (Angebotspreis nach Gebühr/Versand) statt Marktwert.
 * Beobachtete Karten zählen nicht (nicht gekauft).
 */
export function portfolio(items, { start = 0, marktwert, platform, erloes = null }) {
  let einkaufGesamt = 0, gebunden = 0, lagerwert = 0, lagerOhnePreis = 0, erloese = 0, umsatz = 0, dbSumme = 0;
  const verkauft = [], halte = [];
  for (const it of items) {
    if (it.status === 'beobachtet') continue;
    const ek = Number.isFinite(it.einkauf) ? it.einkauf : 0;
    einkaufGesamt += ek;
    if (it.status === 'verkauft' && Number.isFinite(it.verkauf)) {
      const p = platform(it);
      const r = verkaufsErgebnis({ verkauf: it.verkauf, provision: p.provision, versand: Number.isFinite(it.vkVersand) ? it.vkVersand : p.versand, einkauf: ek });
      erloese += r.netto;
      umsatz += it.verkauf;
      dbSumme += r.db;
      verkauft.push(r);
      const d = dayDiff(it.datum, it.vkDatum);
      if (d != null) halte.push(d);
    } else if (it.status !== 'verkauft') {
      gebunden += ek;
      const m = erloes ? erloes(it) : marktwert(it);
      if (Number.isFinite(m)) lagerwert += m;
      else lagerOhnePreis++;
    }
  }
  const kasse = start - einkaufGesamt + erloese;
  const gesamt = kasse + lagerwert;
  const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  return {
    start, kasse, gebunden, lagerwert, lagerOhnePreis, einkaufGesamt, erloese, umsatz,
    dbSumme, anzahlVerkauft: verkauft.length,
    dbSchnitt: avg(verkauft.map((r) => r.db)),
    roiSchnitt: avg(verkauft.map((r) => r.roi).filter((x) => x != null)),
    halteSchnitt: avg(halte),
    gesamt,
    rendite: start > 0 ? (gesamt - start) / start : null,
  };
}
