// Rechenmodell – exakt nach Vorgabe, nichts dazuerfunden.
// Reine Funktionen, keine DOM-Abhängigkeit (testbar mit node).

export const DEFAULT_CF = { MT: 1.15, NM: 1.0, EX: 0.8, GD: 0.55, LP: 0.45, PL: 0.35, PO: 0.22 };
export const DEFAULT_LF = { en: 1.0, ja: 0.85, de: 0.63, fr: 0.55, it: 0.5, es: 0.5, ko: 0.45, zh: 0.4 };
export const LADDER = [0.85, 0.8, 0.75, 0.7];
export const HIGHLIGHT_P = 0.8;

export const CONDITION_LABELS = {
  MT: 'Mint', NM: 'Near Mint', EX: 'Excellent', GD: 'Good', LP: 'Light Played', PL: 'Played', PO: 'Poor',
};
export const LANG_LABELS = {
  en: 'Englisch', ja: 'Japanisch', de: 'Deutsch', fr: 'Französisch', it: 'Italienisch',
  es: 'Spanisch', ko: 'Koreanisch', zh: 'Chinesisch',
};

export const DEFAULT_SETTINGS = {
  cf: { ...DEFAULT_CF },
  lf: { ...DEFAULT_LF },
  platforms: {
    cardmarket: { label: 'Cardmarket', provision: 0.05, versand: 0 },
    ebay: { label: 'eBay privat', provision: 0, versand: 0 },
  },
  platform: 'cardmarket',
  minNetto: 25,
  searchLang: 'de',
  apiBase: 'https://api.tcgdex.net/v2',
  usdEurManual: null,
};

/** Statistik über die angehakten Preise. */
export function stats(values) {
  const v = values.filter((x) => Number.isFinite(x)).slice().sort((a, b) => a - b);
  const n = v.length;
  if (!n) return { count: 0, min: null, median: null, mean: null, max: null };
  const mid = Math.floor(n / 2);
  const median = n % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  const mean = v.reduce((s, x) => s + x, 0) / n;
  return { count: n, min: v[0], median, mean, max: v[n - 1] };
}

export function zustandsFaktor(cf, mein, ref) {
  return cf[mein] / cf[ref];
}
export function sprachFaktor(lf, mein, ref) {
  return lf[mein] / lf[ref];
}

/**
 * Komplette Bewertung.
 * referenz: Preis in EUR; provision als Anteil (0.05); versand in EUR.
 */
export function evaluate({ referenz, cf, lf, meinZustand, refZustand, meineSprache, refSprache, provision, versand, minNetto }) {
  const zf = zustandsFaktor(cf, meinZustand, refZustand);
  const sf = sprachFaktor(lf, meineSprache, refSprache);
  const brutto = referenz * zf * sf;
  const netto = brutto * (1 - provision) - versand;
  const ladder = LADDER.map((p) => {
    const maxGebot = netto * p;
    const gewinn = netto - maxGebot;
    const rendite = maxGebot > 0 ? gewinn / maxGebot : null;
    return { p, maxGebot, gewinn, rendite, highlight: p === HIGHLIGHT_P };
  });
  return { zf, sf, faktor: zf * sf, brutto, netto, ladder, unterMindest: netto < minNetto };
}

/** Marktwert einer Bestandskarte nach Faktoren (brutto). */
export function marktwert({ referenz, cf, lf, zustand, sprache, refZustand = 'NM', refSprache = 'en' }) {
  if (!Number.isFinite(referenz) || cf[zustand] == null || lf[sprache] == null) return null;
  return referenz * zustandsFaktor(cf, zustand, refZustand) * sprachFaktor(lf, sprache, refSprache);
}

/** Preise aus eingefügtem Text ziehen: "12,50 €", "1.234,00", "€ 3.99", "7" … */
export function parsePrices(text) {
  const out = [];
  const re = /(\d{1,3}(?:[.\s]\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)/g;
  for (const line of String(text).split(/\n|;|\|/)) {
    let m;
    while ((m = re.exec(line))) {
      let s = m[1].replace(/\s/g, '');
      if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
      else s = s.replace(',', '.');
      const n = parseFloat(s);
      if (Number.isFinite(n) && n > 0) out.push(Math.round(n * 100) / 100);
    }
  }
  return out;
}

/** Kartennummer aus OCR-Text: "097/165", "TG05/TG30", "SV049/SV122", "4/102". */
export function parseCardNumber(text) {
  const t = String(text)
    .toUpperCase()
    .replace(/[|\\Il]/g, '/') // häufige OCR-Verwechslungen für den Schrägstrich
    .replace(/O(?=\d)|(?<=\d)O/g, '0');
  const m = t.match(/([A-Z]{0,3}\d{1,3})\s*\/\s*([A-Z]{0,3}\d{1,3})/);
  if (!m) return null;
  return { number: m[1], total: m[2] };
}

/** Pipe-Varianten für localId: TCGdex speichert teils "006", teils "6". */
export function localIdVariants(number) {
  const s = String(number).trim().toUpperCase();
  const m = s.match(/^([A-Z]*)(\d+)$/);
  if (!m) return [s];
  const [, pre, digits] = m;
  const n = String(parseInt(digits, 10));
  const set = new Set([s, pre + n, pre + n.padStart(2, '0'), pre + n.padStart(3, '0')]);
  return [...set];
}

/** Preise je Zustand: Referenz über CF-Verhältnis auf jeden Zustand umgerechnet (inkl. Sprachfaktor). */
export function preiseJeZustand({ referenz, cf, refZustand, sprachFaktor: sf = 1, provision, versand }) {
  return Object.keys(cf).map((z) => {
    const brutto = referenz * (cf[z] / cf[refZustand]) * sf;
    const netto = brutto * (1 - provision) - versand;
    return { zustand: z, brutto, netto, maxGebot80: netto * 0.8 };
  });
}

/**
 * Toleranter Parser für OCR-Text, wenn der Schrägstrich als 7/1/l/I gelesen wurde ("0067165" -> 006/165).
 * isValidTotal(n) prüft gegen echte Set-Größen; ohne Prüfer wird nichts geraten.
 */
export function parseCardNumberLoose(text, isValidTotal) {
  const strict = parseCardNumber(text);
  if (strict) return strict;
  if (!isValidTotal) return null;
  const t = String(text).toUpperCase().replace(/O(?=\d)|(?<=\d)O/g, '0');
  const tokens = t.match(/[0-9IL]{4,8}/g) || [];
  const cands = [];
  for (const tok of tokens) {
    for (let i = 1; i < tok.length - 1; i++) {
      if (!'71IL'.includes(tok[i])) continue;
      const left = tok.slice(0, i), right = tok.slice(i + 1);
      if (!/^\d{1,3}$/.test(left) || !/^\d{2,3}$/.test(right)) continue;
      const n = parseInt(left, 10), tot = parseInt(right, 10);
      if (n < 1 || !isValidTotal(tot) || n > tot + 120) continue;
      // gleich lange Hälften (006/165) bevorzugen
      cands.push({ number: left, total: right, score: (left.length === right.length ? 0 : 1) + (n > tot ? 1 : 0) });
    }
  }
  cands.sort((a, b) => a.score - b.score);
  return cands.length ? { number: cands[0].number, total: cands[0].total } : null;
}
