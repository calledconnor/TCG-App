// TCGdex-Zugriff. Zwei-Schritt-Ablauf: Liste (CardBrief, ohne Preise) -> Detail (mit pricing).
import { db, kvGet, kvSet } from './db.js';
import { localIdVariants } from './calc.js';

export const ALL_LANGS = [
  { code: 'de', label: 'Deutsch' },
  { code: 'en', label: 'Englisch' },
  { code: 'fr', label: 'Französisch' },
  { code: 'it', label: 'Italienisch' },
  { code: 'es', label: 'Spanisch' },
  { code: 'pt-br', label: 'Portugiesisch (BR)' },
  { code: 'ja', label: 'Japanisch' },
  { code: 'ko', label: 'Koreanisch' },
  { code: 'zh-tw', label: 'Chinesisch (trad.)' },
];
// Laut Doku sicher; ja/ko/zh-tw werden zur Laufzeit geprüft.
const DOC_LANGS = ['en', 'de', 'fr', 'it', 'es', 'pt-br'];

const DEFAULT_BASE = 'https://api.tcgdex.net/v2';
let BASE = DEFAULT_BASE;
export function setApiBase(b) {
  BASE = (b || 'https://api.tcgdex.net/v2').replace(/\/+$/, '');
}

const DAY = 24 * 3600 * 1000;

export class ApiError extends Error {}

/**
 * GET mit IndexedDB-Cache.
 * maxAge: wenn Cache jünger, kein Netz. Bei Netzfehler -> Cache (auch alt).
 * Rückgabe: { data, fetchedAt, fromCache, status }
 */
export async function getJSON(path, { maxAge = 0, force = false } = {}) {
  const url = BASE + path;
  let cached;
  try {
    cached = await db.get('cache', url);
  } catch {}
  if (!force && cached && maxAge && Date.now() - cached.fetchedAt < maxAge) {
    return { data: cached.data, fetchedAt: cached.fetchedAt, fromCache: true, status: cached.status };
  }
  try {
    let res;
    try {
      res = await fetch(url, { headers: { Accept: 'application/json' } });
    } catch (netErr) {
      // Fallback: eigener Cloudflare-Worker (same origin), falls der Browser TCGdex direkt blockt
      if (BASE !== DEFAULT_BASE || location.protocol !== 'https:') throw netErr;
      res = await fetch(location.origin + '/api/tcgdex' + path, { headers: { Accept: 'application/json' } });
      if (!(res.headers.get('content-type') || '').includes('json') && res.status !== 404) throw netErr;
    }
    if (res.status === 404) {
      const rec = { url, data: null, status: 404, fetchedAt: Date.now() };
      db.put('cache', rec).catch(() => {});
      return { data: null, fetchedAt: rec.fetchedAt, fromCache: false, status: 404 };
    }
    if (!res.ok) throw new ApiError(`HTTP ${res.status}`);
    const data = await res.json();
    const rec = { url, data, status: 200, fetchedAt: Date.now() };
    db.put('cache', rec).catch(() => {});
    return { data, fetchedAt: rec.fetchedAt, fromCache: false, status: 200 };
  } catch (e) {
    if (cached) return { data: cached.data, fetchedAt: cached.fetchedAt, fromCache: true, stale: true, status: cached.status };
    throw new ApiError(navigator.onLine === false ? 'Offline und nichts im Cache.' : `TCGdex nicht erreichbar (${e.message}).`);
  }
}

const qs = (o) =>
  Object.entries(o)
    .map(([k, v]) => `${k}=${encodeURIComponent(v).replace(/%7C/gi, '|').replace(/%3A/gi, ':').replace(/%2A/gi, '*')}`)
    .join('&');

/** Prüft, welche Sprachen TCGdex wirklich liefert (404/leer -> ausgegraut). 7 Tage gecacht. */
export async function probeLanguages() {
  const saved = await kvGet('langProbe', null);
  if (saved && Date.now() - saved.at < 7 * DAY) return saved.result;
  const result = {};
  await Promise.all(
    ALL_LANGS.map(async ({ code }) => {
      try {
        const r = await getJSON(`/${code}/sets?pagination:itemsPerPage=1`, { force: true });
        result[code] = r.status === 200 && Array.isArray(r.data) && r.data.length > 0;
      } catch {
        result[code] = DOC_LANGS.includes(code); // offline: Doku-Sprachen annehmen
      }
    }),
  );
  await kvSet('langProbe', { at: Date.now(), result });
  return result;
}

const setsMem = {};
/** Alle Sets einer Sprache (für Set-Namen und Gesamtzahl-Abgleich). 7 Tage gecacht. */
export async function getSets(lang) {
  if (setsMem[lang]) return setsMem[lang];
  const r = await getJSON(`/${lang}/sets`, { maxAge: 7 * DAY });
  const map = {};
  for (const s of r.data || []) map[s.id] = s;
  setsMem[lang] = map;
  return map;
}

/** Set-ID aus Karten-ID ableiten: "sv03.5-006" + localId "006" -> "sv03.5". */
export function setIdOf(brief) {
  const suf = '-' + brief.localId;
  if (brief.id.endsWith(suf)) return brief.id.slice(0, -suf.length);
  const i = brief.id.lastIndexOf('-');
  return i > 0 ? brief.id.slice(0, i) : '';
}

function enrich(list, sets) {
  return (list || []).map((c) => {
    const setId = setIdOf(c);
    const s = sets[setId];
    return { ...c, setId, setName: s ? s.name : setId, setCount: s ? s.cardCount : null };
  });
}

/**
 * Breite Namenssuche: gewählte Sprache + Englisch + Deutsch, Leerzeichen/Bindestrich-Varianten,
 * bei wenigen Treffern zusätzlich Einzelwörter und Wortanfang (fängt Tippfehler am Ende ab).
 * Ergebnis nach Relevanz sortiert, jedes Element trägt seine Sprache (lang).
 */
export async function searchSmart(lang, name, available = {}) {
  const q = name.trim();
  if (!q) return [];
  const langs = [...new Set([lang, 'en', 'de'])].filter((l) => available[l] !== false);
  const variants = new Set([q]);
  if (/\s/.test(q)) variants.add(q.replace(/\s+/g, '-'));
  if (/-/.test(q)) variants.add(q.replace(/-/g, ' '));

  const merged = new Map(); // id -> brief (bevorzugt gewählte Sprache)
  const runRound = async (terms, ls) => {
    const jobs = [];
    for (const l of ls) for (const t of terms) jobs.push(searchByName(l, t, false).then((list) => list.map((c) => ({ ...c, lang: l }))).catch(() => []));
    for (const list of await Promise.all(jobs)) {
      for (const c of list) {
        const had = merged.get(c.id);
        if (!had || (had.lang !== lang && c.lang === lang)) merged.set(c.id, { ...c, image: c.image || had?.image });
        else if (!had.image && c.image) had.image = c.image; // Bild aus anderer Sprache übernehmen
      }
    }
  };
  await runRound([...variants], langs);

  if (merged.size < 15) {
    const words = q.toLowerCase().split(/[\s-]+/).filter((w) => w.length >= 3);
    const extra = new Set(words);
    const first = words[0] || q.toLowerCase();
    if (first.length >= 5) extra.add(first.slice(0, Math.max(4, first.length - 2)));
    for (const v of variants) extra.delete(v.toLowerCase());
    if (extra.size) await runRound([...extra], [...new Set([lang, 'en'])].filter((l) => available[l] !== false));
  }

  const ql = q.toLowerCase();
  const norm = (x) => x.toLowerCase().replace(/[-\s]+/g, ' ');
  const qn = norm(q);
  const words = qn.split(' ').filter(Boolean);
  const score = (c) => {
    const n = norm(c.name);
    if (n === qn) return 0;
    if (n.startsWith(qn)) return 1;
    if (n.includes(qn)) return 2;
    if (words.every((w) => n.includes(w))) return 3;
    return 4;
  };
  return [...merged.values()]
    .map((c) => ({ ...c, _s: score(c) + (c.lang === lang ? 0 : 0.5) }))
    .sort((a, b) => a._s - b._s || (b.image ? 1 : 0) - (a.image ? 1 : 0) || a.name.localeCompare(b.name, 'de'))
    .slice(0, 250);
}

/** Namenssuche (enthält, case-insensitive). Leerzeichen/Bindestrich-Varianten werden zusammengeführt. */
export async function searchByName(lang, name, withVariants = true) {
  const q = name.trim();
  if (!q) return [];
  const variants = new Set([q]);
  if (withVariants && /\s/.test(q)) variants.add(q.replace(/\s+/g, '-'));
  if (withVariants && /-/.test(q)) variants.add(q.replace(/-/g, ' '));
  const [sets, ...results] = await Promise.all([
    getSets(lang).catch(() => ({})),
    ...[...variants].map((v) => getJSON(`/${lang}/cards?${qs({ name: v })}`, { maxAge: DAY })),
  ]);
  const seen = new Map();
  for (const r of results) for (const c of r.data || []) if (!seen.has(c.id)) seen.set(c.id, c);
  return enrich([...seen.values()], sets);
}

/**
 * Suche über Kartennummer + Gesamtzahl (aus OCR).
 * Hinweis: ein einzelnes "eq:" auf localId liefert bei TCGdex 0 Treffer – mit Pipe-Liste klappt es,
 * deshalb immer mehrere Schreibweisen ("97|097").
 */
export async function searchByNumber(lang, number, total) {
  let variants = localIdVariants(number);
  if (variants.length === 1) variants = [variants[0], variants[0]];
  const [sets, r] = await Promise.all([
    getSets(lang),
    getJSON(`/${lang}/cards?localId=eq:${variants.map(encodeURIComponent).join('|')}`, { maxAge: DAY }),
  ]);
  const all = enrich(r.data, sets);
  if (!total) return { exact: all, others: [] };
  const t = String(total).toUpperCase();
  const tNum = parseInt(t.replace(/^[A-Z]+/, ''), 10);
  const matches = (c) => {
    if (!c.setCount) return false;
    return c.setCount.official === tNum || c.setCount.total === tNum;
  };
  const exact = all.filter(matches);
  return { exact, others: all.filter((c) => !matches(c)) };
}

/** Kartendetail inkl. pricing. Netz zuerst, bei Fehler Cache. */
export function getCard(lang, id, { force = true } = {}) {
  return getJSON(`/${lang}/cards/${encodeURIComponent(id)}`, { force, maxAge: force ? 0 : DAY });
}

const CM_FIELDS = ['avg', 'low', 'trend', 'avg1', 'avg7', 'avg30', 'avg-holo', 'low-holo', 'trend-holo', 'avg1-holo', 'avg7-holo', 'avg30-holo'];
const TP_FIELDS = ['lowPrice', 'midPrice', 'highPrice', 'marketPrice', 'directLowPrice'];

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

/** pricing defensiv lesen. Fehlt ein Marktplatz, fehlt der ganze Schlüssel. Holo-Felder nur per Klammerzugriff. */
export function extractPricing(card) {
  const p = (card && card.pricing) || {};
  let cardmarket = null;
  const cm = p.cardmarket;
  if (cm && typeof cm === 'object') {
    cardmarket = { updated: cm.updated || null, unit: cm.unit || 'EUR', idProduct: cm.idProduct || null };
    for (const f of CM_FIELDS) cardmarket[f] = num(cm[f]);
  }
  let tcgplayer = null;
  const tp = p.tcgplayer;
  if (tp && typeof tp === 'object') {
    const variants = [];
    const keys = Object.keys(tp).filter((k) => tp[k] && typeof tp[k] === 'object');
    const order = ['normal', 'reverse'];
    keys.sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
    for (const k of keys) {
      const fields = {};
      for (const f of TP_FIELDS) fields[f] = num(tp[k][f]);
      variants.push({ key: k, fields });
    }
    tcgplayer = { updated: tp.updated || null, unit: tp.unit || 'USD', variants };
  }
  return { cardmarket, tcgplayer };
}

/** Englischer Name derselben Karte (gleiche ID über alle Sprachen) – für Cardmarket-/eBay-Suche. */
export async function englishName(id) {
  try {
    const r = await getJSON(`/en/cards/${encodeURIComponent(id)}`, { maxAge: 30 * DAY });
    return r.data ? { name: r.data.name, set: r.data.set && r.data.set.name, image: r.data.image || null } : null;
  } catch {
    return null;
  }
}

/**
 * USD->EUR-Kurs. Quellen der Reihe nach: eigener Worker (/api/fx, holt EZB-Kurs serverseitig),
 * frankfurter.dev (EZB), jsDelivr currency-api. 24 h in IndexedDB gecacht.
 */
export async function usdEur({ force = false } = {}) {
  const key = 'fx:usd-eur';
  let cached;
  try { cached = await db.get('cache', key); } catch {}
  if (!force && cached && Date.now() - cached.fetchedAt < DAY) return cached.data;
  const sources = [
    location.protocol === 'https:' ? [location.origin + '/api/fx', (d) => d.rate && { rate: d.rate, date: d.date, source: d.source || 'EZB' }] : null,
    ['https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR', (d) => d.rates?.EUR && { rate: d.rates.EUR, date: d.date, source: 'EZB' }],
    ['https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json', (d) => d.usd?.eur && { rate: d.usd.eur, date: d.date, source: 'currency-api' }],
  ].filter(Boolean);
  for (const [url, parse] of sources) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 6000);
      const res = await fetch(url, { signal: ctl.signal });
      clearTimeout(t);
      if (!res.ok || !(res.headers.get('content-type') || '').includes('json')) continue;
      const data = parse(await res.json());
      if (data && data.rate > 0) {
        db.put('cache', { url: key, data, status: 200, fetchedAt: Date.now() }).catch(() => {});
        return data;
      }
    } catch {}
  }
  return cached ? { ...cached.data, stale: true } : null;
}
