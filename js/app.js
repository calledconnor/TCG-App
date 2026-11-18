import {
  DEFAULT_SETTINGS, CONDITION_LABELS, CONDITION_DE, LANG_LABELS, LADDER,
  stats, evaluate, marktwert, parsePrices, parseCardNumber, parseCardNumberLoose, preiseJeZustand, combine, CM_TO_TCG,
} from './calc.js';
import {
  ALL_LANGS, setApiBase, probeLanguages, searchByName, searchByNumber,
  getCard, extractPricing, englishName, setIdOf, getSets, usdEur, searchSmart, gradedPrices, getJSON,
} from './api.js';
import { db, kvGet, kvSet } from './db.js';
import { createGrading, shareReport, checklistLines } from './grading.js';
import { createScanner } from './scanner.js';
import { kalkulation, verkaufsErgebnis, portfolio, roundPrice } from './flip.js';

// ---------- Helfer ----------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtEur = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const eur = (v) => (v == null || !Number.isFinite(v) ? '–' : fmtEur.format(v));
const n2 = (v) => (v == null || !Number.isFinite(v) ? '–' : v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const fmt1 = (v) => (v == null ? '–' : v.toLocaleString('de-DE', { maximumFractionDigits: 1 }));
const pct = (v) => (v == null || !Number.isFinite(v) ? '–' : (v * 100).toLocaleString('de-DE', { maximumFractionDigits: 1 }) + ' %');
const dt = (v) => {
  if (!v) return 'unbekannt';
  const d = new Date(v);
  return isNaN(d) ? 'unbekannt' : d.toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
};
const parseNum = (s) => {
  const v = parseFloat(String(s).replace(/\s/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
  return Number.isFinite(v) ? v : null;
};
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const today = () => new Date().toISOString().slice(0, 10);
const img = (url, q, alt) =>
  url ? `<img loading="lazy" src="${esc(url)}/${q}.webp" alt="${esc(alt)}" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'thumb-ph',textContent:'kein Bild'}))">`
      : `<div class="thumb-ph">kein Bild</div>`;
const tcgLangToLf = (l) => ({ en: 'en', de: 'de', fr: 'fr', it: 'it', es: 'es', ja: 'ja', ko: 'ko', 'zh-tw': 'zh', 'zh-cn': 'zh' }[l] || null);

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2600);
}

// ---------- Verständliche Bezeichnungen ----------
const CM_LABEL = { trend: 'Trendpreis', avg: 'Ø Verkaufspreis', low: 'Günstigstes Angebot', avg1: 'Ø letzter Tag', avg7: 'Ø 7 Tage', avg30: 'Ø 30 Tage' };
const cmLabel = (f) => {
  const holo = f.endsWith('-holo');
  const base = holo ? f.slice(0, -5) : f;
  return `Cardmarket ${CM_LABEL[base] || base}${holo ? ' (Reverse Holo)' : ''}`;
};
const TP_VARIANT = {
  normal: 'Normal', reverse: 'Reverse Holo', reverseHolofoil: 'Reverse Holo', holofoil: 'Holo',
  '1stEdition': '1. Edition', '1stEditionNormal': '1. Edition', '1stEditionHolofoil': '1. Edition Holo',
  unlimited: 'Unlimited', unlimitedHolofoil: 'Unlimited Holo',
};
const tpVariant = (k) => TP_VARIANT[k] || String(k).replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/^./, (x) => x.toUpperCase());
const LANG_NAME = {
  de: 'Deutsch', en: 'Englisch', fr: 'Französisch', it: 'Italienisch', es: 'Spanisch', 'pt-br': 'Portugiesisch (BR)', pt: 'Portugiesisch',
  ja: 'Japanisch', ko: 'Koreanisch', 'zh-tw': 'Chinesisch (traditionell)', 'zh-cn': 'Chinesisch (vereinfacht)', id: 'Indonesisch', th: 'Thailändisch',
};
const condText = (k) => `${k} · ${CONDITION_LABELS[k] || k}${CONDITION_DE[k] ? ' (' + CONDITION_DE[k] + ')' : ''}`;

const TRASH = '<svg class="ico" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
// ---------- Wischen zum Löschen (mit Rückgängig) ----------
function toastUndo(msg, undo) {
  const t = $('#toast');
  t.innerHTML = `${esc(msg)} <button class="toast-undo">Rückgängig</button>`;
  t.classList.add('show', 'interactive');
  clearTimeout(toast._t);
  const btn = t.querySelector('.toast-undo');
  btn.addEventListener('click', () => { undo(); t.classList.remove('show', 'interactive'); });
  toast._t = setTimeout(() => t.classList.remove('show', 'interactive'), 4500);
}
/**
 * Zeilen in `container` (Selektor `sel`, Attribut `data-uid`) nach links wischen = löschen.
 * remove(uid) entfernt und gibt eine Rückgängig-Funktion zurück.
 */
function enableSwipe(container, sel, remove, label = 'Entfernt') {
  $$(sel, container).forEach((row) => {
    if (row.dataset.swipe) return;
    row.dataset.swipe = '1';
    row.classList.add('swipe-row');
    let sx = 0, sy = 0, dx = 0, active = false, decided = false;
    row.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1 || e.target.closest('input,select,textarea,canvas')) return;
      sx = e.touches[0].clientX; sy = e.touches[0].clientY; dx = 0; active = true; decided = false;
      row.style.transition = 'none';
    }, { passive: true });
    row.addEventListener('touchmove', (e) => {
      if (!active) return;
      const mx = e.touches[0].clientX - sx, my = e.touches[0].clientY - sy;
      if (!decided) {
        if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
        decided = true;
        if (Math.abs(my) > Math.abs(mx) || mx > 0 || sx < 30) { active = false; return; } // Scrollen bzw. Zurück-Geste
      }
      dx = Math.min(0, mx);
      e.preventDefault();
      row.style.transform = `translateX(${dx}px)`;
      row.classList.toggle('swipe-armed', dx < -row.offsetWidth * 0.35);
    }, { passive: false });
    const end = () => {
      if (!active) return;
      active = false;
      row.style.transition = 'transform .22s ease, opacity .22s ease';
      if (dx < -row.offsetWidth * 0.35) {
        row.style.transform = 'translateX(-110%)';
        row.style.opacity = '0';
        setTimeout(() => {
          row.style.transition = 'height .2s ease, padding .2s ease, margin .2s ease';
          row.style.height = row.offsetHeight + 'px';
          requestAnimationFrame(() => { row.style.height = '0px'; row.style.paddingTop = row.style.paddingBottom = '0px'; row.style.borderWidth = '0'; });
          setTimeout(() => {
            const undo = remove(row.dataset.uid);
            if (undo) toastUndo(label, undo);
          }, 210);
        }, 220);
      } else {
        row.style.transform = '';
        row.classList.remove('swipe-armed');
      }
    };
    row.addEventListener('touchend', end);
    row.addEventListener('touchcancel', end);
  });
}

// ---------- Zustand ----------
let settings = structuredClone(DEFAULT_SETTINGS);
let langAvail = {};
let inventory = [];
let cur = null; // aktuelle Bewertung
let fx = null; // { rate, date, manual } USD->EUR

async function loadSettings() {
  const s = await kvGet('settings', null);
  if (s) {
    settings = {
      ...structuredClone(DEFAULT_SETTINGS),
      ...s,
      cf: { ...DEFAULT_SETTINGS.cf, ...(s.cf || {}) },
      lf: { ...DEFAULT_SETTINGS.lf, ...(s.lf || {}) },
      platforms: {
        cardmarket: { ...DEFAULT_SETTINGS.platforms.cardmarket, ...(s.platforms?.cardmarket || {}) },
        ebay: { ...DEFAULT_SETTINGS.platforms.ebay, ...(s.platforms?.ebay || {}) },
      },
    };
  }
  setApiBase(settings.apiBase);
  applyTheme();
}
const saveSettings = () => kvSet('settings', settings);

// ---------- Darstellung ----------
function applyTheme() {
  const t = settings.theme || 'light';
  const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const m = document.querySelector('meta[name="theme-color"]');
  if (m) m.content = dark ? '#000000' : '#ffffff';
  const cs = document.querySelector('meta[name="color-scheme"]');
  if (cs) cs.content = dark ? 'dark' : 'light';
}
// Zoomen per Zwei-Finger-Geste verhindern (iOS ignoriert user-scalable=no teilweise)
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('touchmove', (e) => { if (e.scale !== undefined && e.scale !== 1) e.preventDefault(); }, { passive: false });

// ---------- Navigation ----------
const scroller = $('main');
const scrollMem = {};
let curView = 'search';
let navDepth = 0; // Anzahl eigener History-Einträge
function show(view, { push = true, keepScroll = true } = {}) {
  if (view !== curView) scrollMem[curView] = scroller.scrollTop;
  if (view !== 'search' && scanner && scanner.running) stopScanner();
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + view));
  $$('.tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
  if (view === 'inv') renderInventory();
  if (view === 'book') renderBook();
  if (view === 'cart') renderCart();
  if (view === 'calc') renderCalc();
  if (view === 'settings') renderSettings();
  if (view === 'grade') grading && grading.refresh();
  if (view === 'eval' && cur && $('#graded-api')) renderGradedApi();
  const changed = view !== curView;
  curView = view;
  if (changed) scroller.scrollTop = keepScroll ? scrollMem[view] || 0 : 0;
  if (push && changed) {
    history.pushState({ view }, '', '#' + view);
    navDepth++;
  }
  $('#nav-back').classList.toggle('hidden', view === 'search' && navDepth === 0);
}
function goBack() {
  if (navDepth > 0) history.back();
  else show('search', { push: false });
}
$('#nav-back').addEventListener('click', goBack);
$('#opt-btn').addEventListener('click', () => show('settings'));
// Wischen vom linken Rand nach rechts = zurück (auch in der Home-Bildschirm-App ohne Safari-Geste)
(() => {
  let sx = 0, sy = 0, tracking = false;
  addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    tracking = e.touches.length === 1 && t.clientX < 28 && !e.target.closest('canvas,video');
    sx = t.clientX; sy = t.clientY;
  }, { passive: true });
  addEventListener('touchend', (e) => {
    if (!tracking) return;
    tracking = false;
    const t = e.changedTouches[0];
    if (t.clientX - sx > 70 && Math.abs(t.clientY - sy) < 60) goBack();
  }, { passive: true });
})();
$$('.tabbar button').forEach((b) => b.addEventListener('click', () => show(b.dataset.view)));
addEventListener('popstate', (e) => {
  navDepth = Math.max(0, navDepth - 1);
  show((e.state && e.state.view) || 'search', { push: false });
});
history.replaceState({ view: 'search' }, '', location.pathname + location.search);

function updateNet() {
  const el = $('#net-status');
  el.textContent = navigator.onLine ? 'online' : 'offline – Cache';
  el.classList.toggle('off', !navigator.onLine);
}
addEventListener('online', updateNet);
addEventListener('offline', updateNet);

// ---------- Suche ----------
function renderLangSelect() {
  const sel = $('#search-lang');
  sel.innerHTML = ALL_LANGS.map(({ code, label }) => {
    const ok = langAvail[code] !== false;
    return `<option value="${code}" ${ok ? '' : 'disabled'} ${settings.searchLang === code ? 'selected' : ''}>${label}${ok ? '' : ' (nicht verfügbar)'}</option>`;
  }).join('');
}
$('#search-lang').addEventListener('change', (e) => {
  settings.searchLang = e.target.value;
  saveSettings();
});

$$('#search-mode button').forEach((b) =>
  b.addEventListener('click', () => setMode(b.dataset.mode)),
);
function setMode(mode) {
  $$('#search-mode button').forEach((x) => x.classList.toggle('on', x.dataset.mode === mode));
  $$('.mode-pane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== mode));
  if (mode !== 'camera' && scanner && scanner.running) stopScanner();
}

function setStatus(msg, err = false) {
  const s = $('#search-status');
  s.textContent = msg || '';
  s.classList.toggle('err', err);
}

function renderResults(groups) {
  const el = $('#results');
  el.innerHTML = groups
    .map(({ title, items }) =>
      (title ? `<h4>${esc(title)}</h4>` : '') +
      items
        .map((c) => `
        <button class="result" data-id="${esc(c.id)}" data-lang="${esc(c.lang || settings.searchLang)}">
          ${img(c.image, 'low', c.name)}
          <span class="txt"><span class="n">${esc(c.name)}${c.lang && c.lang !== settings.searchLang ? ` <span class="tag">${esc(c.lang.toUpperCase())}</span>` : ''}</span>
          <span class="s">${esc(c.setName || c.setId)} · ${esc(c.localId)}${c.setCount ? '/' + c.setCount.official : ''}</span></span>
        </button>`)
        .join(''),
    )
    .join('');
  $$('.result', el).forEach((b) => b.addEventListener('click', () => openCard(b.dataset.lang, b.dataset.id)));
}

$('#form-name').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('#q-name').value.trim();
  if (!q) return;
  setStatus('Suche …');
  $('#results').innerHTML = '';
  try {
    const list = await searchSmart(settings.searchLang, q, langAvail);
    setStatus(list.length ? `${list.length} Treffer · beste zuerst` : `Keine Treffer für „${q}“. Anderen Namen oder die Kartennummer versuchen.`);
    const best = list.filter((c) => c._s < 3);
    const rest = list.filter((c) => c._s >= 3);
    renderResults(best.length && rest.length ? [{ items: best }, { title: 'Weitere ähnliche Karten', items: rest }] : [{ items: list }]);
  } catch (err) {
    setStatus(err.message, true);
  }
});

$('#form-number').addEventListener('submit', (e) => {
  e.preventDefault();
  runNumberSearch($('#q-num').value, $('#q-total').value);
});

async function runNumberSearch(number, total) {
  number = String(number).trim();
  total = String(total).trim();
  if (!number) return;
  setStatus('Suche nach Nummer …');
  $('#results').innerHTML = '';
  try {
    const { exact, others } = await searchByNumber(settings.searchLang, number, total);
    if (exact.length === 1 && total) {
      setStatus(`${exact[0].name} · ${exact[0].setName}`);
      renderResults([{ items: exact }]);
      openCard(settings.searchLang, exact[0].id);
      return;
    }
    const groups = [];
    if (exact.length) groups.push({ title: total ? `Sets mit ${total} Karten` : '', items: exact });
    if (others.length) groups.push({ title: 'Andere Sets mit dieser Nummer', items: others.slice(0, 60) });
    setStatus(
      exact.length
        ? `${exact.length} passende Karten`
        : others.length
          ? `Kein Set mit ${total} Karten. Alle Karten mit Nr. ${number}:`
          : `Keine Karte ${number}/${total} gefunden. Bitte per Name suchen.`,
      !exact.length && !others.length,
    );
    renderResults(groups);
    if (!exact.length && !others.length) setMode('name');
  } catch (err) {
    setStatus(err.message, true);
  }
}

// ---------- Kamera + Zuschnitt + OCR ----------
const crop = { img: null, rect: { x: 0, y: 0.86, w: 1, h: 0.14 }, drag: null };
const cv = $('#crop-canvas');

function onPhotoPicked(e) {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  const url = URL.createObjectURL(f);
  const im = new Image();
  im.onload = () => {
    crop.img = im;
    crop.rect = { x: 0, y: 0.86, w: 1, h: 0.14 };
    $('#crop-wrap').classList.remove('hidden');
    $('#ocr-result').classList.add('hidden');
    drawCrop();
  };
  im.onerror = () => toast('Bild konnte nicht geladen werden');
  im.src = url;
  e.target.value = '';
}
$('#cam-input').addEventListener('change', onPhotoPicked);
$('#gal-input').addEventListener('change', onPhotoPicked);

// ---------- KI-Kartenerkennung + Scan-Liste (dauerhaft gespeichert) ----------
let scanList = [];
const saveScan = () => kvSet('scanlist', scanList);
async function loadScan() { scanList = (await kvGet('scanlist', [])) || []; renderScanList(); }
const LANG_FROM_AI = { de: 'de', en: 'en', fr: 'fr', it: 'it', es: 'es', pt: 'pt-br', ja: 'ja', ko: 'ko', zh: 'zh-tw' };

function toJpeg(file, maxSide = 1500) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => {
      const s = Math.min(1, maxSide / Math.max(im.naturalWidth, im.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(im.naturalWidth * s);
      c.height = Math.round(im.naturalHeight * s);
      c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
      URL.revokeObjectURL(im.src);
      resolve(c.toDataURL('image/jpeg', 0.85).split(',')[1]);
    };
    im.onerror = () => reject(new Error('Bild nicht lesbar'));
    im.src = URL.createObjectURL(file);
  });
}

const normName = (x) => String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
function nameScore(a, b) {
  const A = normName(a), B = normName(b);
  if (!A || !B) return 0;
  if (A === B) return 3;
  if (A.includes(B) || B.includes(A)) return 2;
  const wa = new Set(A.split(' '));
  return B.split(' ').filter((w) => wa.has(w)).length ? 1 : 0;
}

/** Erkannte Karte → TCGdex-Treffer (Nummer + Gesamtzahl, sonst Name + Nummer, sonst Name). */
async function resolveDetected(d) {
  const lang = LANG_FROM_AI[d.language] && langAvail[LANG_FROM_AI[d.language]] !== false ? LANG_FROM_AI[d.language] : settings.searchLang;
  const pick = (list) => list
    .map((c) => ({ c, sc: Math.max(nameScore(c.name, d.name), nameScore(c.name, d.nameEn)) }))
    .sort((a, b) => b.sc - a.sc);
  let cands = [];
  if (d.number) {
    try {
      const r = await searchByNumber(lang, d.number, d.total || '');
      cands = [...r.exact, ...(r.exact.length ? [] : r.others)].map((c) => ({ ...c, lang }));
    } catch {}
    if (!cands.length && lang !== 'en') {
      try { const r = await searchByNumber('en', d.number, d.total || ''); cands = [...r.exact, ...(r.exact.length ? [] : r.others)].map((c) => ({ ...c, lang: 'en' })); } catch {}
    }
    const ranked = pick(cands).filter((x) => x.sc > 0);
    if (ranked.length) cands = ranked.map((x) => x.c);
    else if (cands.length > 8) cands = [];
  }
  if (!cands.length) {
    const q = `${d.name}${d.number ? ' ' + d.number + (d.total ? '/' + d.total : '') : ''}`;
    try { cands = await searchSmart(lang, q, langAvail); } catch {}
    if (!cands.length && d.nameEn) { try { cands = await searchSmart('en', `${d.nameEn}${d.number ? ' ' + d.number : ''}`, langAvail); } catch {} }
    cands = pick(cands).map((x) => x.c);
  }
  return cands.slice(0, 8).map((c) => ({ id: c.id, lang: c.lang || lang, name: c.name, setName: c.setName, localId: c.localId, official: c.setCount?.official ?? null, image: c.image || null }));
}

async function priceFor(m) {
  try {
    const r = await getCard(m.lang, m.id, { force: false });
    if (!r.data) return null;
    const pricing = extractPricing(r.data);
    const src = marketSources(pricing, null, []);
    let image = r.data.image || null;
    if (!image) { const en = await englishName(m.id); image = en?.image || null; }
    return { pricing, kombi: combine(src), trend: pricing.cardmarket?.trend ?? null, fetchedAt: r.fetchedAt, image };
  } catch { return null; }
}

async function aiScanFiles(files) {
  if (!files.length) return;
  if (!settings.aiKey) {
    toast('Für den KI-Scan unter Optionen einen Anthropic-Schlüssel eintragen. Ohne Schlüssel: Live-Scanner oder Nummer.');
    return;
  }
  const status = $('#ai-scan-status');
  let done = 0, found = 0;
  for (const f of files) {
    status.textContent = `Erkenne Foto ${done + 1} von ${files.length} …`;
    try {
      const image = await toJpeg(f);
      const res = await fetch('/api/ai-identify', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Anthropic-Key': settings.aiKey }, body: JSON.stringify({ image }) });
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('json')) throw new Error('KI-Scan geht nur in der Online-Version');
      const out = await res.json();
      if (out.error === 'key_invalid') throw new Error('Anthropic-Schlüssel abgelehnt');
      if (out.error) throw new Error('Erkennung fehlgeschlagen (' + out.error + ')');
      for (const d of out.result.cards) {
        const cands = await resolveDetected(d);
        const entry = { uid: uid(), at: Date.now(), detected: d, cands, sel: 0, status: cands.length === 0 ? 'none' : cands.length === 1 || d.confidence === 'high' ? 'ok' : 'check' };
        if (cands[0]) entry.price = await priceFor(cands[0]);
        scanList.unshift(entry);
        found++;
        saveScan();
        renderScanList();
      }
    } catch (e) {
      toast(e.message);
    }
    done++;
  }
  status.textContent = `${found} Karte${found === 1 ? '' : 'n'} aus ${files.length} Foto${files.length === 1 ? '' : 's'} erkannt.`;
}

function renderScanList() {
  const el = $('#scan-list');
  if (!el) return;
  if (!scanList.length) { el.innerHTML = ''; return; }
  const sum = scanList.reduce((a, e) => a + (e.price?.kombi || 0), 0);
  el.innerHTML = `
    <div class="card">
      <div class="scan-head"><h2>Scan-Liste · ${scanList.length}</h2><span class="meta">Marktwert zusammen ${eur(sum)}</span></div>
      ${scanList.map((e) => {
        const m = e.cands[e.sel];
        const d = e.detected;
        return `<div class="scan-row" data-uid="${e.uid}">
          ${img(m?.image || e.price?.image, 'low', m?.name || d.name)}
          <div>
            <div class="n">${esc(m ? m.name : d.name)}</div>
            <div class="meta">${m ? `${esc(m.setName || '')} · ${esc(m.localId)}${m.official ? '/' + m.official : ''}` : 'nicht gefunden'}</div>
            <div class="date">erkannt: ${esc(d.name)}${d.number ? ' ' + esc(d.number) + (d.total ? '/' + esc(d.total) : '') : ''} · ${esc((d.language || '').toUpperCase())}${d.variant ? ' · ' + esc(d.variant) : ''} · ${{ low: 'unsicher', medium: 'mittel', high: 'sicher' }[d.confidence]}</div>
            ${e.cands.length > 1 ? `<select data-sel="${e.uid}" class="scan-sel">${e.cands.map((c, i) => `<option value="${i}" ${i === e.sel ? 'selected' : ''}>${esc(c.name)} · ${esc(c.setName || '')} ${esc(c.localId)}${c.official ? '/' + c.official : ''}</option>`).join('')}</select>` : ''}
          </div>
          <div class="right">
            <b>${e.price?.kombi != null ? eur(e.price.kombi) : '–'}</b>
            <span class="meta">${e.price?.trend != null ? 'CM ' + eur(e.price.trend) : ''}</span>
            <div class="scan-actions">
              ${m ? `<button class="small" data-open="${e.uid}">Öffnen</button><button class="small" data-cart="${e.uid}">Korb</button>` : ''}
              <button class="x trash" data-rm="${e.uid}" aria-label="Löschen">${TRASH}</button>
            </div>
          </div>
        </div>`;
      }).join('')}
      <div class="grid2" style="margin-top:10px">
        <button id="scan-all-cart" class="primary">Alle in den Korb</button>
        <button id="scan-clear" class="ghost danger">Liste leeren</button>
      </div>
      <p class="date">Marktwert = kombinierter Wert für Near Mint, englischer Bezugspreis. Die genaue Bewertung (Zustand, Sprache) gibt es über „Öffnen“.</p>
    </div>`;
  const find = (u) => scanList.find((x) => x.uid === u);
  $$('[data-sel]', el).forEach((s) => s.addEventListener('change', async () => {
    const e = find(s.dataset.sel); e.sel = +s.value; e.status = 'ok';
    e.price = await priceFor(e.cands[e.sel]); saveScan(); renderScanList();
  }));
  $$('[data-open]', el).forEach((b) => b.addEventListener('click', () => { const e = find(b.dataset.open); const m = e.cands[e.sel]; openCard(m.lang, m.id); }));
  $$('[data-cart]', el).forEach((b) => b.addEventListener('click', () => { quickCart(find(b.dataset.cart)); }));
  $$('[data-rm]', el).forEach((b) => b.addEventListener('click', () => {
    const i = scanList.findIndex((x) => x.uid === b.dataset.rm); if (i < 0) return;
    const [e] = scanList.splice(i, 1); saveScan(); renderScanList();
    toastUndo('Aus der Scan-Liste entfernt', () => { scanList.splice(i, 0, e); saveScan(); renderScanList(); });
  }));
  enableSwipe(el, '.scan-row', (u) => {
    const i = scanList.findIndex((x) => x.uid === u);
    if (i < 0) return null;
    const [e] = scanList.splice(i, 1);
    saveScan(); renderScanList();
    return () => { scanList.splice(i, 0, e); saveScan(); renderScanList(); };
  }, 'Aus der Scan-Liste entfernt');
  $('#scan-all-cart').addEventListener('click', () => { let n = 0; for (const e of scanList) if (e.cands[e.sel] && quickCart(e, true)) n++; toast(`${n} Karten in den Korb gelegt`); });
  $('#scan-clear').addEventListener('click', () => { if (confirm('Scan-Liste leeren?')) { scanList = []; saveScan(); renderScanList(); } });
}

/** Karte aus der Scan-Liste direkt in den Korb (Near Mint, Sprache der Karte). */
function quickCart(e, silent = false) {
  const m = e.cands[e.sel];
  const p = e.price;
  if (!m || !p || p.kombi == null) { if (!silent) toast('Kein Marktpreis – erst öffnen und bewerten'); return false; }
  const sprache = tcgLangToLf(m.lang) || 'en';
  const pf = settings.platforms[settings.platform];
  const r = evaluate({ referenz: p.kombi, cf: settings.cf, lf: settings.lf, meinZustand: 'NM', refZustand: 'NM', meineSprache: sprache, refSprache: 'en', provision: pf.provision, versand: pf.versand, minNetto: settings.minNetto });
  const l80 = r.ladder.find((l) => l.highlight);
  if (cart.some((x) => !x.bought && x.cardId === m.id && x.zustand === 'NM' && x.sprache === sprache)) { if (!silent) toast('Schon im Korb'); return false; }
  cart.push({
    uid: uid(), cardId: m.id, lang: m.lang, name: m.name, setName: m.setName || '', localId: m.localId, official: m.official, image: m.image || p.image,
    zustand: 'NM', sprache, markt: r.brutto, netto: r.netto, max80: l80.maxGebot, angebot: Math.floor(l80.maxGebot * 2) / 2,
    refLabel: 'Kombinierter Marktwert', refDate: p.fetchedAt, pricing: p.pricing, gradedApi: null, grading: null, addedAt: Date.now(),
  });
  saveCart();
  updateCartBtn();
  if (!silent) toast('In den Korb gelegt');
  return true;
}

$('#ai-cam').addEventListener('change', (e) => { aiScanFiles([...e.target.files]); e.target.value = ''; });
$('#ai-gal').addEventListener('change', (e) => { aiScanFiles([...e.target.files]); e.target.value = ''; });

// ---------- Live-Scanner ----------
let scanner = null;
function scanStatus(msg, kind) {
  const el = $('#scan-status');
  el.textContent = msg;
  el.className = 'status' + (kind ? ' ' + kind : '');
}
function stopScanner() {
  if (scanner) scanner.stop();
  $('#scan-live').classList.add('hidden');
  $('#scan-start').classList.remove('hidden');
}
let setTotals = new Set();
async function loadSetTotals() {
  try {
    const sets = await getSets(settings.searchLang);
    setTotals = new Set();
    for (const st of Object.values(sets)) {
      if (st.cardCount?.official) setTotals.add(st.cardCount.official);
      if (st.cardCount?.total) setTotals.add(st.cardCount.total);
    }
  } catch {}
}
$('#scan-start').addEventListener('click', async () => {
  loadSetTotals();
  $('#scan-live').classList.remove('hidden');
  $('#scan-start').classList.add('hidden');
  $('#crop-wrap').classList.add('hidden');
  try {
    const { recognize } = await import('./ocr.js');
    scanner = scanner || createScanner({
      wrap: $('#scan-wrap'),
      video: $('#scan-video'),
      frame: $('#scan-frame'),
      onStatus: scanStatus,
      recognize: (c) => recognize(c),
      isValidTotal: (n) => setTotals.has(n),
      onResult: (p) => {
        $('#scan-live').classList.add('hidden');
        $('#scan-start').classList.remove('hidden');
        $('#scan-start').textContent = 'Nächste Karte scannen';
        const out = $('#ocr-result');
        out.classList.remove('hidden');
        out.innerHTML = `
          <p class="hint">Erkannt: ${esc(p.number)}/${esc(p.total)}</p>
          <form id="ocr-form" class="inline">
            <input id="ocr-num" value="${esc(p.number)}" /><span class="slash">/</span>
            <input id="ocr-total" value="${esc(p.total)}" />
            <button class="primary" type="submit">Suchen</button>
          </form>`;
        $('#ocr-form').addEventListener('submit', (ev) => {
          ev.preventDefault();
          runNumberSearch($('#ocr-num').value, $('#ocr-total').value);
        });
        runNumberSearch(p.number, p.total);
      },
    });
    await scanner.start();
    $('#scan-torch').classList.toggle('hidden', !scanner.torchSupported());
  } catch (err) {
    stopScanner();
    toast('Kamera nicht verfügbar: ' + (err.message || err.name) + '. Nutze „Foto aufnehmen“.');
  }
});
$('#scan-stop').addEventListener('click', stopScanner);
$('#scan-torch').addEventListener('click', async () => {
  const on = await scanner.toggleTorch();
  $('#scan-torch').classList.toggle('primary', on);
});
document.addEventListener('visibilitychange', () => { if (document.hidden && scanner && scanner.running) stopScanner(); });

function drawCrop() {
  const im = crop.img;
  if (!im) return;
  const w = cv.clientWidth || 600;
  const h = Math.round((w * im.naturalHeight) / im.naturalWidth);
  const dpr = devicePixelRatio || 1;
  cv.width = w * dpr;
  cv.height = h * dpr;
  cv.style.height = h + 'px';
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.drawImage(im, 0, 0, w, h);
  const r = crop.rect;
  ctx.fillStyle = 'rgba(0,0,0,.55)';
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.rect(r.x * w, r.y * h, r.w * w, r.h * h);
  ctx.fill('evenodd');
  ctx.strokeStyle = '#ffd60a';
  ctx.lineWidth = 2;
  ctx.strokeRect(r.x * w, r.y * h, r.w * w, r.h * h);
}
addEventListener('resize', drawCrop);

function relPos(e) {
  const b = cv.getBoundingClientRect();
  return { x: Math.min(1, Math.max(0, (e.clientX - b.left) / b.width)), y: Math.min(1, Math.max(0, (e.clientY - b.top) / b.height)) };
}
cv.addEventListener('pointerdown', (e) => {
  cv.setPointerCapture(e.pointerId);
  crop.drag = relPos(e);
});
cv.addEventListener('pointermove', (e) => {
  if (!crop.drag) return;
  const p = relPos(e);
  const s = crop.drag;
  const r = { x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) };
  if (r.w > 0.03 && r.h > 0.015) {
    crop.rect = r;
    drawCrop();
  }
});
cv.addEventListener('pointerup', () => (crop.drag = null));
cv.addEventListener('pointercancel', () => (crop.drag = null));
$$('.crop-presets button').forEach((b) =>
  b.addEventListener('click', () => {
    crop.rect = { bl: { x: 0, y: 0.86, w: 0.5, h: 0.14 }, b: { x: 0, y: 0.86, w: 1, h: 0.14 }, br: { x: 0.5, y: 0.86, w: 0.5, h: 0.14 } }[b.dataset.preset];
    drawCrop();
  }),
);

$('#crop-ok').addEventListener('click', async () => {
  const im = crop.img;
  if (!im) return;
  const r = crop.rect;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(r.w * im.naturalWidth));
  c.height = Math.max(1, Math.round(r.h * im.naturalHeight));
  c.getContext('2d').drawImage(im, r.x * im.naturalWidth, r.y * im.naturalHeight, c.width, c.height, 0, 0, c.width, c.height);
  const out = $('#ocr-result');
  out.classList.remove('hidden');
  out.innerHTML = '<p class="status">OCR läuft …</p>';
  try {
    const { recognize } = await import('./ocr.js');
    const text = await recognize(c, (s) => (out.innerHTML = `<p class="status">${esc(s)}</p>`));
    await loadSetTotals();
    const parsed = parseCardNumberLoose(text, (n) => setTotals.has(n));
    if (!parsed) {
      out.innerHTML = `<p class="status err">Keine Nummer erkannt${text.trim() ? ` (gelesen: „${esc(text.trim())}“)` : ''}. Ausschnitt enger ziehen oder per Name suchen.</p>`;
      setMode('name');
      setStatus('Nummer nicht lesbar. Bitte Namen eingeben.', true);
      $('#q-name').focus();
      return;
    }
    out.innerHTML = `
      <p class="hint">Erkannt: „${esc(text.trim())}“</p>
      <form id="ocr-form" class="inline">
        <input id="ocr-num" value="${esc(parsed.number)}" /><span class="slash">/</span>
        <input id="ocr-total" value="${esc(parsed.total)}" />
        <button class="primary" type="submit">Suchen</button>
      </form>`;
    $('#ocr-form').addEventListener('submit', (e) => {
      e.preventDefault();
      runNumberSearch($('#ocr-num').value, $('#ocr-total').value);
    });
    runNumberSearch(parsed.number, parsed.total);
  } catch (err) {
    out.innerHTML = `<p class="status err">Texterkennung fehlgeschlagen (${esc(err.message)}). Bitte per Name suchen.</p>`;
    setMode('name');
  }
});

// ---------- Bewerten ----------
async function openCard(lang, id) {
  show('eval', { keepScroll: false });
  scroller.scrollTop = 0;
  $('#eval-empty').classList.add('hidden');
  $('#eval').innerHTML = '<p class="status">Lade Preise …</p>';
  try {
    const r = await getCard(lang, id);
    if (!r.data) {
      $('#eval').innerHTML = `<p class="status err">Karte ${esc(id)} nicht gefunden (404).</p>`;
      return;
    }
    const card = r.data;
    const pricing = extractPricing(card);
    const myLang = tcgLangToLf(settings.searchLang) || tcgLangToLf(lang) || 'en';
    const prev = cur;
    cur = {
      lang, card, pricing, fetchedAt: r.fetchedAt, fromCache: r.fromCache, stale: r.stale,
      enName: lang === 'en' ? { name: card.name, set: card.set?.name } : null,
      offers: prev && prev.card.id === card.id ? prev.offers : [],
      offerFilter: 'all',
      refType: prev && prev.card.id === card.id ? prev.refType : autoRef(pricing, prev && prev.card.id === card.id ? prev.offers : []),
      refAuto: !(prev && prev.card.id === card.id && !prev.refAuto),
      useHolo: false,
      custom: '',
      refLang: 'en', refCond: 'NM',
      myLang, myLangUnmapped: !tcgLangToLf(settings.searchLang) && !tcgLangToLf(lang),
      myCond: prev ? prev.myCond : 'NM',
      platform: settings.platform,
      grading: prev && prev.card.id === card.id ? prev.grading : null,
      askPrice: null, payPrice: null, payTouched: false, bought: null,
      graded: prev && prev.card.id === card.id ? prev.graded : {},
      gpGrade: prev && prev.card.id === card.id ? prev.gpGrade : 'PSA 10',
    };
    cur.ebayQuery = `${card.name} ${card.localId}/${card.set?.cardCount?.official ?? ''}`.trim();
    renderEval();
    if (!fx || fx.stale) loadFx();
    getJSON(`/en/sets/${encodeURIComponent(card.set?.id || '')}`, { maxAge: 30 * 24 * 3600 * 1000 }).then((r) => {
      if (cur && cur.card.id === card.id && r.data?.abbreviation?.official) { cur.setAbbr = r.data.abbreviation.official; renderMarket(); }
    }).catch(() => {});
    if (!cur.enName || !card.image) {
      englishName(card.id).then((en) => {
        if (cur && cur.card.id === card.id && en) {
          cur.enName = en;
          renderLinks();
          if (!card.image && en.image) {
            card.image = en.image; // gleiche Karte, Bild der englischen Ausgabe
            const ph = $('#eval .head .thumb-ph');
            if (ph) ph.outerHTML = img(en.image, 'high', card.name);
          }
        }
      });
    }
  } catch (err) {
    $('#eval').innerHTML = `<p class="status err">${esc(err.message)}</p>`;
  }
}

/**
 * Zustandsfaktoren: aus echten TCGplayer-Preisen dieser Karte (Verhältnis zu Near Mint), wenn vorhanden
 * und in den Optionen aktiviert; sonst die eigenen Faktoren. MT bleibt immer beim eigenen Faktor.
 */
function effectiveCF(ppt) {
  const conds = ppt?.conditions;
  const nm = conds?.['Near Mint']?.usd;
  if (settings.cfFromMarket === false || !nm) return { cf: settings.cf, fromMarket: false };
  const cf = { ...settings.cf };
  let used = 0;
  for (const c of Object.keys(cf)) {
    if (c === 'MT' || c === 'NM') continue;
    const v = conds[CM_TO_TCG[c]]?.usd;
    if (v != null) { cf[c] = settings.cf.NM * Math.min(1, v / nm); used++; }
  }
  return used ? { cf, fromMarket: true } : { cf: settings.cf, fromMarket: false };
}

/**
 * Marktquellen für den kombinierten Wert (alle in EUR, Basis Near Mint):
 * Cardmarket Trend + Ø 30 Tage (TCGdex), TCGplayer Near Mint (Pokemon Price Tracker, sonst TCGdex),
 * Median deiner Cardmarket-Angebote und deiner eBay-Beobachtungen.
 */
/**
 * Cardmarket-Werte einer Variante auf Widersprüche prüfen (Ausreißer im Preisindex, z. B. alte Karten).
 * Rückgabe { ok, ratio, vals } – ok=false, wenn größter/kleinster Wert von Ø1/Ø7/Ø30/Trend mehr als Faktor 3 auseinanderliegen.
 */
function cmPlausible(cm, holo) {
  if (!cm) return { ok: true, vals: [] };
  const f = (k) => (holo ? k + '-holo' : k);
  const vals = ['avg1', 'avg7', 'avg30', 'trend'].map((k) => cm[f(k)]).filter((v) => v != null && v > 0);
  if (vals.length < 2) return { ok: true, vals };
  const ratio = Math.max(...vals) / Math.min(...vals);
  return { ok: ratio <= 3, ratio, vals };
}

function marketSources(pricing, ppt, offers = [], useHolo = false) {
  const out = [];
  const cm = pricing?.cardmarket;
  if (cm) {
    const f = (k) => (useHolo ? k + '-holo' : k);
    const pl = cmPlausible(cm, useHolo);
    if (pl.ok) {
      if (cm[f('trend')] != null) out.push({ key: 'cm-trend', label: cmLabel(f('trend')), eur: cm[f('trend')], date: cm.updated });
      if (cm[f('avg30')] != null) out.push({ key: 'cm-avg30', label: cmLabel(f('avg30')), eur: cm[f('avg30')], date: cm.updated });
    } else if (pl.vals.length) {
      // widersprüchlich: nur den niedrigsten der vier Durchschnittswerte als vorsichtige Schätzung
      out.push({ key: 'cm-min', label: `Cardmarket vorsichtig (niedrigster Ø-Wert, Daten widersprüchlich)`, eur: Math.min(...pl.vals), date: cm.updated, unsure: true });
    }
  }
  if (fx) {
    const nm = ppt?.conditions?.['Near Mint'];
    if (nm) out.push({ key: 'tcg-nm', label: 'TCGplayer Near Mint (aktuell)', eur: nm.usd * fx.rate, date: nm.date || ppt.rawUpdated });
    else {
      const m = tpMarket(pricing || {});
      if (m) out.push({ key: 'tcg', label: `TCGplayer Marktpreis ${tpVariant(m.variant)}`, eur: m.usd * fx.rate, date: m.updated });
    }
  }
  const on = offers.filter((o) => o.on);
  const cmo = stats(on.filter((o) => o.src === 'cm').map((o) => o.v));
  if (cmo.count) out.push({ key: 'off-cm', label: `Deine ${cmo.count} Cardmarket-Angebote (Median)`, eur: cmo.median, date: Date.now() });
  const ebo = stats(on.filter((o) => o.src === 'ebay').map((o) => o.v));
  if (ebo.count) out.push({ key: 'off-ebay', label: `Deine ${ebo.count} eBay-Verkäufe (Median)`, eur: ebo.median, date: Date.now() });
  return out;
}

/** Sinnvolle Standard-Referenz: Angebote > cardmarket.trend > cardmarket.avg30 > TCGplayer market. */
function autoRef(pricing, offers) {
  if (marketSources(pricing, null, offers).length >= 2) return 'kombi';
  if (offers && offers.some((o) => o.on)) return 'median';
  const cm = pricing.cardmarket;
  if (cm && cm.trend != null) return 'trend';
  if (cm && cm.avg30 != null) return 'avg30';
  if (tpMarket(pricing)) return 'tcgp';
  return 'median';
}
/** TCGplayer-Marktpreis (USD) der ersten Variante, die einen hat. */
function tpMarket(pricing) {
  const tp = pricing.tcgplayer;
  if (!tp) return null;
  for (const v of tp.variants) {
    const val = v.fields.marketPrice ?? v.fields.midPrice;
    if (val != null) return { usd: val, variant: v.key, updated: tp.updated };
  }
  return null;
}

const REF_OPTIONS = [
  ['kombi', 'Kombinierter Marktwert (alle Quellen)'],
  ['trend', 'Cardmarket Trendpreis'],
  ['avg7', 'Cardmarket Ø 7 Tage'],
  ['avg30', 'Cardmarket Ø 30 Tage'],
  ['tcgp', 'TCGplayer Marktpreis (in €)'],
  ['custom', 'Eigener Wert'],
];

const SRC_OPTIONS = [
  ['kombi', 'Automatisch: Median aus Cardmarket und TCGplayer (empfohlen)'],
  ['trend', 'Nur Cardmarket Trendpreis'],
  ['avg30', 'Nur Cardmarket Ø 30 Tage'],
  ['avg7', 'Nur Cardmarket Ø 7 Tage'],
  ['tcgp', 'Nur TCGplayer (USA, in €)'],
  ['custom', 'Eigenen Marktwert eingeben'],
];
const LANG_CHIPS = ['de', 'en', 'ja', 'fr', 'it', 'es', 'ko', 'zh'];

/** Bewertung im Ankaufsmodus: Karte → Zustand/Sprache → Marktwert → Ankauf. */
function renderEval() {
  const c = cur.card;
  const cm = cur.pricing.cardmarket;
  const hasHolo = cm && ['trend-holo', 'avg30-holo', 'avg7-holo', 'avg1-holo'].some((k) => cm[k] != null);
  cur.refCond = 'NM';
  cur.refLang = 'en';
  if (cur.refType && !SRC_OPTIONS.some(([v]) => v === cur.refType)) cur.refType = 'kombi';

  $('#eval').innerHTML = `
    <button class="ghost small back" id="back-btn">‹ Zurück</button>
    <div class="card ev-head">
      ${img(c.image, 'high', c.name)}
      <div>
        <p class="title">${esc(c.name)}</p>
        <div class="meta">${esc(c.set?.name || '–')} · Nr. ${esc(c.localId)}${c.set?.cardCount?.official ? '/' + c.set.cardCount.official : ''}</div>
        ${c.rarity ? `<div class="meta">${esc(c.rarity)}</div>` : ''}
        <p class="date">Preise vom ${dt(cur.fetchedAt)}${cur.fromCache ? (cur.stale ? ' · offline' : '') : ''} · <a href="#" id="reload-card">neu laden</a></p>
      </div>
    </div>

    <div class="card">
      <h2>Deine Karte</h2>
      <div class="chip-label">Zustand</div>
      <div class="chips cond-chips" id="ev-cond">
        ${Object.keys(settings.cf).map((k) => `<button data-c="${k}" class="${k === cur.myCond ? 'on' : ''}"><b>${k}</b><span>${CONDITION_DE[k] || ''}</span></button>`).join('')}
      </div>
      <div class="chip-label">Sprache</div>
      <div class="chips" id="ev-lang">
        ${LANG_CHIPS.filter((k) => settings.lf[k] != null).map((k) => `<button data-l="${k}" class="${k === cur.myLang ? 'on' : ''}">${LANG_LABELS[k] || k}</button>`).join('')}
      </div>
      ${hasHolo ? `<div class="chip-label">Variante</div>
      <div class="chips" id="ev-var"><button data-v="0" class="${!cur.useHolo ? 'on' : ''}">Standard</button><button data-v="1" class="${cur.useHolo ? 'on' : ''}">Reverse Holo</button></div>` : ''}
    </div>

    <div class="card" id="ev-value"></div>
    <div class="card ev-buy" id="ev-buy"></div>

    <details class="card ev-details" id="ev-details" ${cur.detailsOpen ? 'open' : ''}>
      <summary>Details: Preisquellen, Rechnung, Ankaufsleiter</summary>
      <label>Welcher Preis zählt?<select id="ref-type">${SRC_OPTIONS.map(([v, l]) => `<option value="${v}" ${v === cur.refType ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label id="row-custom" class="${cur.refType === 'custom' ? '' : 'hidden'}">Marktwert deiner Karte (in diesem Zustand und dieser Sprache) €<input id="ref-custom" inputmode="decimal" value="${esc(cur.custom || '')}" placeholder="z. B. 25" /></label>
      <label>Verkaufen über<select id="platform">${Object.entries(settings.platforms).map(([k, p]) => `<option value="${k}" ${k === cur.platform ? 'selected' : ''}>${esc(p.label)} (${fmt1(p.provision * 100)} % Gebühr · Versand ${eur(p.versand)})</option>`).join('')}</select></label>
      <div id="calc-out" class="calc"></div>
      <h3>Marktpreise</h3>
      <div id="market"></div>
    </details>

    <div class="card">
      <h2>Grading &amp; Graded-Preise</h2>
      <div id="grading-sum"></div>
      <h3>Marktpreise gegradeter Karten</h3>
      <div id="graded-api"></div>
      <h3>Eigene Beobachtungen</h3>
      <div class="grid2">
        <select id="gp-grade">${GRADES.map((g) => `<option ${g === cur.gpGrade ? 'selected' : ''}>${g}</option>`).join('')}</select>
        <div class="inline"><input id="gp-one" inputmode="decimal" placeholder="Preis €" /><button id="gp-add" class="primary">+</button></div>
      </div>
      <a id="gp-ebay" class="btn block" target="_blank" rel="noopener" href="#">eBay: verkaufte Karten mit dieser Note</a>
      <div id="gp-list"></div>
    </div>`;

  $('#reload-card').addEventListener('click', (e) => { e.preventDefault(); openCard(cur.lang, cur.card.id); });
  $('#back-btn').addEventListener('click', goBack);
  $$('#ev-cond button').forEach((b) => b.addEventListener('click', () => { cur.myCond = b.dataset.c; $$('#ev-cond button').forEach((x) => x.classList.toggle('on', x === b)); updateCalc(); renderMarket(); }));
  $$('#ev-lang button').forEach((b) => b.addEventListener('click', () => { cur.myLang = b.dataset.l; $$('#ev-lang button').forEach((x) => x.classList.toggle('on', x === b)); updateCalc(); }));
  $$('#ev-var button').forEach((b) => b.addEventListener('click', () => { cur.useHolo = b.dataset.v === '1'; $$('#ev-var button').forEach((x) => x.classList.toggle('on', x === b)); updateCalc(); renderMarket(); }));
  $('#ref-type').addEventListener('change', (e) => { cur.refType = e.target.value; cur.refAuto = false; $('#row-custom').classList.toggle('hidden', cur.refType !== 'custom'); updateCalc(); });
  $('#ref-custom').addEventListener('input', (e) => { cur.custom = e.target.value; updateCalc(); });
  $('#platform').addEventListener('change', (e) => { cur.platform = e.target.value; settings.platform = cur.platform; saveSettings(); updateCalc(); });
  $('#ev-details').addEventListener('toggle', (e) => { cur.detailsOpen = e.target.open; });

  renderMarket();
  updateCalc();
  renderGradingSum();
  renderGraded();
  loadGradedApi(false);
  $('#gp-grade').addEventListener('change', (e) => {
    cur.gpGrade = e.target.value;
    cur.gpTouched = true;
    renderGraded();
  });
  $('#gp-add').addEventListener('click', () => {
    const v = parseNum($('#gp-one').value);
    if (v == null || v <= 0) return toast('Bitte einen Preis eingeben');
    (cur.graded[cur.gpGrade] ||= []).push(v);
    $('#gp-one').value = '';
    renderGraded();
  });
}

/** Graded-Preise: aus Cache sofort, per Knopf frisch (kostet API-Credits). */
async function loadGradedApi(fetchNow) {
  const el = $('#graded-api');
  if (!el || !cur) return;
  const cardId = cur.card.id;
  const query = `${cur.enName?.name || cur.card.name} ${cur.card.localId}${cur.card.set?.cardCount?.official ? '/' + cur.card.set.cardCount.official : ''}`;
  const auto = !fetchNow && settings.pptKey && settings.pptAuto !== false;
  if (!fetchNow && !auto) {
    // nur Cache prüfen, keine Credits
    const r = await gradedPrices({ tcgIds: cur.pricing.tcgIds, query, apiKey: '', force: false, cacheOnly: true });
    if (cur.card.id !== cardId) return;
    cur.gradedApi = r.status === 'ok' ? r : null;
    return afterPpt();
  }
  el.innerHTML = '<p class="status">Lade aktuelle Marktdaten …</p>';
  const mk = $('#ppt-status');
  if (mk) mk.textContent = 'Lade aktuelle TCGplayer- und Graded-Preise …';
  // automatisch: Cache nutzen, wenn jünger als 24 h; Knopf: immer frisch
  const r = await gradedPrices({ tcgIds: cur.pricing.tcgIds, query, apiKey: settings.pptKey, force: !!fetchNow });
  if (cur.card.id !== cardId) return;
  cur.gradedApi = r;
  if (r.status === 'ok' && r.data.creditsRemaining != null) settings.pptRemaining = { n: r.data.creditsRemaining, at: Date.now() };
  afterPpt();
}
function afterPpt() {
  if (cur.refAuto && cur.refType !== 'kombi' && marketSources(cur.pricing, cur.gradedApi?.data, cur.offers).length >= 2) {
    cur.refType = 'kombi';
    const sel = $('#ref-type');
    if (sel) sel.value = 'kombi';
  }
  renderMarket();
  updateCalc();
  renderGradedApi();
}

function renderGradedApi() {
  const el = $('#graded-api');
  if (!el) return;
  const r = cur.gradedApi;
  const rem = settings.pptRemaining && Date.now() - settings.pptRemaining.at < 86400000 ? settings.pptRemaining.n : null;
  const btn = `<button class="block" id="graded-load">${r && r.status === 'ok' ? 'Jetzt neu laden' : 'Graded-Preise laden'} <span class="meta">(3 Credits${rem != null ? ', heute noch ' + rem : ''})</span></button>`;
  if (!settings.pptKey && !(r && r.status === 'ok')) {
    el.innerHTML = `<p class="hint">Für PSA-, CGC- und BGS-Preise einmalig einen kostenlosen Schlüssel von Pokemon Price Tracker unter Optionen eintragen.</p><button class="block" id="graded-settings">Zu den Optionen</button>`;
    $('#graded-settings').addEventListener('click', () => show('settings'));
    return;
  }
  if (!r) { el.innerHTML = btn; return bindGradedBtn(); }
  const msg = {
    not_configured: 'Kein API-Schlüssel hinterlegt. Bitte unter Optionen eintragen.',
    key_invalid: 'Der API-Schlüssel wurde abgelehnt. Bitte unter Optionen prüfen.',
    not_found: 'Pokemon Price Tracker kennt diese Karte nicht.',
  }[r.status];
  if (r.status !== 'ok') {
    el.innerHTML = `<p class="err">${esc(msg || 'Abruf fehlgeschlagen: ' + (r.message || ''))}</p>` + btn;
    return bindGradedBtn();
  }
  const d = r.data;
  const toE = (usd) => (usd == null ? null : fx ? usd * fx.rate : null);
  const money = (usd) => (usd == null ? '–' : fx ? eur(usd * fx.rate) : usd.toLocaleString('de-DE', { style: 'currency', currency: 'USD' }));
  const raw = d.rawMarketUsd;
  const est = cur.grading ? cur.grading.overall : null;
  const row = (g) => {
    const price = g.median ?? g.avg; // Median: robust gegen Ausreißer (der „Smart Price“ der API schwankt teils stark)
    const mult = raw && price ? price / raw : null;
    const hl = g.company === 'PSA' && est != null && +g.grade === est;
    const tr = { up: ' <span class="pos" title="steigend">↑</span>', down: ' <span class="neg" title="fallend">↓</span>', stable: ' <span class="meta" title="stabil">→</span>' }[g.trend] || '';
    const few = (g.count ?? 0) < 3;
    return `<tr class="${hl ? 'hl' : ''}${few ? ' few' : ''}" title="${few ? 'weniger als 3 Verkäufe – wenig aussagekräftig' : ''}"><td>${g.company} ${esc(g.grade)}${tr}</td><td>${money(price)}${g.min != null && g.max != null ? `<div class="range">${money(g.min)} – ${money(g.max)}</div>` : ''}</td><td>${g.count ?? '–'}</td><td>${mult ? '× ' + mult.toLocaleString('de-DE', { maximumFractionDigits: 1 }) : '–'}</td></tr>`;
  };
  const psa = d.grades.filter((g) => g.company === 'PSA');
  const other = d.grades.filter((g) => g.company !== 'PSA');
  const head = '<tr><th>Note</th><th>Marktpreis</th><th>Verkäufe</th><th>Faktor</th></tr>';
  el.innerHTML = d.grades.length
    ? `<table class="ladder">${head}${psa.map(row).join('')}</table>
       ${other.length ? `<details class="more"><summary>Weitere Grader (CGC, BGS, SGC …)</summary><table class="ladder">${head}${other.map(row).join('')}</table></details>` : ''}
       <p class="date">Ungegradet: <b>${money(raw)}</b> (TCGplayer). Marktpreis = Median der Verkäufe, darunter die Spanne; Pfeil = Preistrend, blass = unter 3 Verkäufen (wenig aussagekräftig). Faktor = gegradeter ÷ ungegradeter Preis.${est != null ? ' Deine Schätzung PSA ' + est + ' ist markiert.' : ''}</p>
       <p class="date">Verkäufe auf eBay und Fanatics Collect${d.from && d.to ? ` vom ${new Date(d.from).toLocaleDateString('de-DE')} bis ${new Date(d.to).toLocaleDateString('de-DE')}` : ''}, über Pokemon Price Tracker. Abgerufen am ${dt(r.fetchedAt)}.</p>
       ${btn}`
    : `<p class="hint">Für diese Karte wurden keine Verkäufe gegradeter Exemplare gefunden.</p>${btn}`;
  bindGradedBtn();
}
function bindGradedBtn() {
  const b = $('#graded-load');
  if (b) b.addEventListener('click', () => loadGradedApi(true));
}

const GRADES = ['PSA 10', 'PSA 9', 'PSA 8', 'PSA 7', 'BGS 9.5', 'BGS 9', 'CGC 10', 'CGC 9.5', 'CGC 9'];

function renderGradingSum() {
  const el = $('#grading-sum');
  if (!el) return;
  const g = cur.grading;
  el.innerHTML = g
    ? `<div class="line" style="display:flex;justify-content:space-between;align-items:center;padding:4px 0 10px">
         <span class="grade-badge">PSA ~${g.overall} geschätzt</span>
         <span class="meta">${dt(g.date)}</span>
       </div>
       <div class="meta">Zentrierung max. ${g.cap}${g.centering.front ? ` (vorne ${fmt1(g.centering.front.lr)}/${fmt1(100 - g.centering.front.lr)}, ${fmt1(g.centering.front.tb)}/${fmt1(100 - g.centering.front.tb)})` : ''} · Ecken ${fmt1(g.sub.corners)} · Kanten ${fmt1(g.sub.edges)} · Oberfläche ${fmt1(g.sub.surface)} · ${g.defects.length} Mängel</div>
       ${(() => { const ph = g.annotated || g.photos; return ph.front || ph.back ? `<div class="g-photos">${ph.front ? `<img src="${ph.front}" alt="vorne">` : ''}${ph.back ? `<img src="${ph.back}" alt="hinten">` : ''}</div>` : ''; })()}
       <button class="block" id="go-grade">Grading-Check bearbeiten</button>`
    : `<p class="hint">Noch kein Grading-Check für diese Karte.</p><button class="block" id="go-grade">Grading-Check starten</button>`;
  $('#go-grade').addEventListener('click', () => show('grade'));
  if (g) {
    const opt = $('#gp-grade');
    const want = `PSA ${g.overall}`;
    if (!cur.gpTouched && GRADES.includes(want)) {
      cur.gpGrade = want;
      opt.value = want;
    }
  }
}

function renderGraded() {
  const el = $('#gp-list');
  if (!el) return;
  const c = cur.card;
  const nm = cur.enName?.name || c.name;
  const q = `${nm} ${c.localId}${c.set?.cardCount?.official ? '/' + c.set.cardCount.official : ''} ${cur.gpGrade}`;
  $('#gp-ebay').href = `https://www.ebay.de/sch/i.html?_nkw=${encodeURIComponent(q)}&LH_Sold=1&LH_Complete=1&_sop=13`;
  $('#gp-ebay').textContent = `eBay: verkaufte „${cur.gpGrade}“ ansehen`;
  const rows = GRADES.filter((g) => (cur.graded[g] || []).length).map((g) => {
    const s = stats(cur.graded[g]);
    return `<tr><td>${g}</td><td>${s.count}</td><td>${eur(s.median)}</td><td>${eur(s.min)}–${eur(s.max)}</td><td><button class="ghost small danger" data-clear="${g}">×</button></td></tr>`;
  });
  el.innerHTML = rows.length
    ? `<table><tr><th>Note</th><th>Anzahl</th><th>Median</th><th>Spanne</th><th></th></tr>${rows.join('')}</table><p class="date">Von Hand eingetragen am ${dt(Date.now())}.</p>`
    : '<p class="hint">Note wählen, eBay-Verkäufe ansehen und die Preise hier eintragen.</p>';
  $$('[data-clear]', el).forEach((b) => b.addEventListener('click', () => { delete cur.graded[b.dataset.clear]; renderGraded(); }));
}

/** Marktpreise mit Zustandsleiste: alle Werte über CF[Zustand] / CF[Referenzzustand] umgerechnet. */
function renderMarket() {
  const el = $('#market');
  if (!el) return;
  const cm = cur.pricing.cardmarket;
  const tp = cur.pricing.tcgplayer;
  const ecf = effectiveCF(cur.gradedApi?.data);
  const k = ecf.cf[cur.myCond] / ecf.cf[cur.refCond];
  const adj = (v) => (v == null ? null : v * k);
  const hasHolo = cm && ['trend-holo', 'avg30-holo', 'avg7-holo', 'avg1-holo'].some((k) => cm[k] != null);
  const varSeg = hasHolo ? `<div class="seg var-seg"><button data-v="0" class="${!cur.useHolo ? 'on' : ''}">Standard</button><button data-v="1" class="${cur.useHolo ? 'on' : ''}">Reverse Holo</button></div>` : '';
  const pl = cmPlausible(cm, cur.useHolo);
  const plWarn = cm && !pl.ok ? `<div class="warn">Die Cardmarket-Werte für ${cur.useHolo ? 'Reverse Holo' : 'Standard'} widersprechen sich (${pl.vals.map((v) => eur(v)).join(' · ')}). Das passiert bei seltenen Karten mit Ausreißern im Preisindex. Bitte auf Cardmarket oder PriceCharting gegenprüfen${hasHolo ? ' und die richtige Variante wählen' : ''}; die App rechnet vorsichtig mit dem niedrigsten Durchschnitt.</div>` : '';
  const tabs = varSeg + `<div class="seg cond-seg">${Object.keys(settings.cf).map((z) => `<button data-z="${z}" class="${z === cur.myCond ? 'on' : ''}">${z}</button>`).join('')}</div>`;
  const note = cur.myCond === cur.refCond
    ? `<p class="date">Preise für ${condText(cur.refCond)}, so wie der Markt sie meldet.</p>`
    : `<p class="date">Umgerechnet auf ${condText(cur.myCond)}: Marktpreis × ${k.toLocaleString('de-DE', { maximumFractionDigits: 2 })} (${ecf.fromMarket ? 'aus echten TCGplayer-Zustandspreisen dieser Karte' : 'dein Zustandsfaktor'}).</p>`;
  const cmRow = (label, f) => `<tr><td>${label}</td><td>${eur(adj(cm[f]))}</td><td>${eur(adj(cm[f + '-holo']))}</td></tr>`;
  const cmHtml = cm
    ? `<table>
        <tr><th>Cardmarket</th><th>Standard</th><th>Reverse Holo</th></tr>
        ${cmRow(CM_LABEL.trend, 'trend')}${cmRow(CM_LABEL.avg30, 'avg30')}${cmRow(CM_LABEL.avg7, 'avg7')}
        ${cmRow(CM_LABEL.avg1, 'avg1')}${cmRow(CM_LABEL.avg, 'avg')}${cmRow(CM_LABEL.low, 'low')}
      </table>
      <p class="date">Preisstand Cardmarket: <b>${dt(cm.updated)}</b></p>`
    : '<p class="hint">Für diese Karte liegen keine Cardmarket-Preise vor. Über „Cardmarket öffnen“ prüfen.</p>';
  const money = (usdVal) => (usdVal == null ? '–' : fx ? eur(usdVal * fx.rate * k) : (usdVal * k).toLocaleString('de-DE', { style: 'currency', currency: 'USD' }));
  const tpHtml = tp && tp.variants.length
    ? `<table>
        <tr><th>TCGplayer (USA)${fx ? '' : ' in USD'}</th><th>Niedrigster</th><th>Mittel</th><th>Marktpreis</th><th>Höchster</th></tr>
        ${tp.variants.map((v) => `<tr><td>${esc(tpVariant(v.key))}</td><td>${money(v.fields.lowPrice)}</td><td>${money(v.fields.midPrice)}</td><td>${money(v.fields.marketPrice)}</td><td>${money(v.fields.highPrice)}</td></tr>`).join('')}
      </table>
      <p class="date">Preisstand TCGplayer: <b>${dt(tp.updated)}</b> · ${fx ? `in Euro umgerechnet (1 US-Dollar = ${fx.rate.toLocaleString('de-DE', { maximumFractionDigits: 4 })} €, ${fx.manual ? 'eigener Kurs' : 'Kurs vom ' + new Date(fx.date).toLocaleDateString('de-DE')})` : 'Wechselkurs gerade nicht abrufbar, deshalb in US-Dollar. Eigenen Kurs unter Optionen eintragen.'}</p>`
    : '';
  const src = marketSources(cur.pricing, cur.gradedApi?.data, cur.offers, cur.useHolo);
  const komb = combine(src);
  const ppt = cur.gradedApi?.status === 'ok' ? cur.gradedApi.data : null;
  const tcgCond = ppt?.conditions?.[CM_TO_TCG[cur.myCond]];
  const kombHtml = komb != null
    ? `<div class="hero"><div class="lbl">Kombinierter Marktwert · ${condText(cur.myCond)}</div>
         <div class="val">${eur(komb * k)}</div>
         <div class="sub">Median aus ${src.length} Quelle${src.length > 1 ? 'n' : ''}: ${src.map((x) => esc(x.label.replace(/^Cardmarket /, 'CM ').replace(/ \(aktuell\)$/, ''))).join(' · ')}</div></div>
       ${tcgCond && fx ? `<p class="date">TCGplayer echt für ${CM_TO_TCG[cur.myCond]}: <b>${eur(tcgCond.usd * fx.rate)}</b> (ohne Umrechnung über Zustandsfaktor), Stand ${dt(tcgCond.date)}</p>` : ''}`
    : '';
  const condTable = ppt && Object.keys(ppt.conditions || {}).length && fx
    ? `<table><tr><th>TCGplayer je Zustand (echt)</th><th>Preis</th></tr>${Object.entries(ppt.conditions).map(([n, v]) => `<tr class="${n === CM_TO_TCG[cur.myCond] ? 'hl' : ''}"><td>${n}</td><td>${eur(v.usd * fx.rate)}</td></tr>`).join('')}</table>
       <p class="date">Variante ${esc(tpVariant(ppt.printing || ''))} · Pokemon Price Tracker · abgerufen am ${dt(cur.gradedApi.fetchedAt)}${cur.gradedApi.fromCache ? ' (zwischengespeichert)' : ''}</p>`
    : (settings.pptKey ? '<p class="date" id="ppt-status"></p>' : '');
  const enN = cur.enName?.name || cur.card.name;
  const abbr = cur.setAbbr || '';
  const cmExact = [enN, abbr, cur.card.localId].filter(Boolean).join(' ');
  const pcQ = [enN, cur.enName?.set || cur.card.set?.name || '', cur.card.localId].filter(Boolean).join(' ');
  const quick = `<div class="quick-links">
      <a class="btn small primary" target="_blank" rel="noopener" href="https://www.cardmarket.com/de/Pokemon/Products/Search?category=-1&searchString=${encodeURIComponent(cmExact)}">Cardmarket: diese Karte ↗</a>
      <a class="btn small" target="_blank" rel="noopener" href="https://www.cardmarket.com/de/Pokemon/Products/Search?category=-1&searchString=${encodeURIComponent(enN)}">Cardmarket: alle „${esc(enN)}“ ↗</a>
      <a class="btn small" target="_blank" rel="noopener" href="https://www.pricecharting.com/search-products?type=prices&q=${encodeURIComponent('pokemon ' + pcQ)}">PriceCharting ↗</a>
      <a class="btn small" target="_blank" rel="noopener" href="https://www.ebay.de/sch/i.html?_nkw=${encodeURIComponent(cur.ebayQuery)}&LH_Sold=1&LH_Complete=1&_sop=13">eBay verkauft ↗</a>
    </div>
    <p class="date">„Diese Karte“ sucht mit Set-Kürzel und Nummer (${esc(cmExact)}). Findet Cardmarket nichts, den zweiten Link nehmen und nach Erweiterung „${esc(cur.enName?.set || cur.card.set?.name || '')}“ filtern.</p>`;
  el.innerHTML = note + kombHtml + cmHtml + condTable + tpHtml;
}

function renderLinks() {
  const el = $('#links');
  if (!el) return;
  const c = cur.card;
  const cmSearch = (q) => `https://www.cardmarket.com/de/Pokemon/Products/Search?category=-1&searchString=${encodeURIComponent(q)}`;
  const ebay = (q) => `https://www.ebay.de/sch/i.html?_nkw=${encodeURIComponent(q)}&LH_Sold=1&LH_Complete=1&_sop=13`;
  const en = cur.enName;
  el.innerHTML = `
    ${en ? `<a class="btn primary" target="_blank" rel="noopener" href="${cmSearch(en.name)}">Cardmarket: „${esc(en.name)}“ (${esc(en.set || '')})</a>` : ''}
    ${!en || en.name !== c.name ? `<a class="btn" target="_blank" rel="noopener" href="${cmSearch(c.name)}">Cardmarket: „${esc(c.name)}“</a>` : ''}
    <p class="hint">Produktnamen auf Cardmarket sind englisch. Dort Set „${esc(c.set?.name || '')}“, Nr. ${esc(c.localId)} öffnen, nach Sprache und Zustand filtern, Preise unten eintragen.</p>
    <label>eBay-Suchbegriff (verkaufte Angebote)
      <input id="ebay-q" value="${esc(cur.ebayQuery)}" />
    </label>
    <a id="ebay-link" class="btn" target="_blank" rel="noopener" href="${ebay(cur.ebayQuery)}">eBay: verkaufte Artikel ansehen</a>`;
  $('#ebay-q').addEventListener('input', (e) => {
    cur.ebayQuery = e.target.value;
    $('#ebay-link').href = ebay(cur.ebayQuery);
  });
}

function activeOffers() {
  return cur.offers.filter((o) => o.on && (cur.offerFilter === 'all' || o.src === cur.offerFilter));
}

function renderOffers() {
  $$('#offer-filter button').forEach((b) => b.classList.toggle('on', b.dataset.f === cur.offerFilter));
  const el = $('#offers');
  el.innerHTML = cur.offers.length
    ? cur.offers
        .map((o) => {
          const counted = o.on && (cur.offerFilter === 'all' || o.src === cur.offerFilter);
          return `<span class="offer ${counted ? '' : 'off'}">
            <input type="checkbox" data-id="${o.id}" ${o.on ? 'checked' : ''} aria-label="Preis zählen" />
            ${eur(o.v)} <span class="src">${o.src === 'cm' ? 'CM' : 'eBay'}</span>
            <button data-del="${o.id}" aria-label="entfernen">×</button>
          </span>`;
        })
        .join('')
    : '<p class="hint">Preise von Cardmarket oder eBay eintragen. Ausreißer per Haken abwählen.</p>';
  $$('input[type=checkbox]', el).forEach((cb) =>
    cb.addEventListener('change', () => {
      const o = cur.offers.find((x) => x.id === cb.dataset.id);
      o.on = cb.checked;
      renderOffers();
    }),
  );
  $$('button[data-del]', el).forEach((b) =>
    b.addEventListener('click', () => {
      cur.offers = cur.offers.filter((x) => x.id !== b.dataset.del);
      renderOffers();
    }),
  );
  renderMarket();
  updateCalc();
}

/** Referenzpreis bestimmen. Rückgabe { value, label, date, isApi, field } oder { error }. */
function resolveRef() {
  const t = cur.refType;
  if (['median', 'mean', 'min'].includes(t)) {
    const s = stats(activeOffers().map((o) => o.v));
    if (!s.count) return { error: 'Keine angehakten Angebote – Preise eintragen oder andere Referenz wählen.' };
    const lbl = { median: 'Median', mean: 'Durchschnitt', min: 'Minimum' }[t];
    return { value: s[t], label: `${lbl} deiner ${s.count} Angebote`, date: Date.now(), dateLabel: 'Eingetragen am' };
  }
  if (t === 'custom') {
    const v = parseNum(cur.custom);
    if (v == null || v <= 0) return { error: 'Eigenen Referenzwert eingeben.' };
    return { value: v, label: 'Eigener Wert', date: Date.now(), dateLabel: 'Eingegeben am' };
  }
  if (t === 'kombi') {
    const src = marketSources(cur.pricing, cur.gradedApi?.data, cur.offers, cur.useHolo);
    if (!src.length) return { error: 'Keine Marktquellen verfügbar. Angebote eintragen oder eigenen Wert wählen.' };
    const v = combine(src);
    const newest = src.map((x) => new Date(x.date).getTime()).filter(Number.isFinite).sort((a, b) => b - a)[0];
    return { value: v, label: `Kombinierter Marktwert aus ${src.length} Quelle${src.length > 1 ? 'n' : ''}`, date: newest, dateLabel: 'Neueste Quelle vom', isApi: true, field: 'kombi', sources: src };
  }
  if (t === 'tcgp') {
    const m = tpMarket(cur.pricing);
    if (!m) return { error: 'Keine TCGplayer-Daten für diese Karte.' };
    if (!fx) return { error: 'Wechselkurs nicht verfügbar. Kurs in den Einstellungen eintragen.' };
    return { value: m.usd * fx.rate, label: `TCGplayer Marktpreis ${tpVariant(m.variant)} (${m.usd.toLocaleString('de-DE', { style: 'currency', currency: 'USD' })})`, date: m.updated, dateLabel: 'Preisstand', isApi: true, field: 'tcgp' };
  }
  const cm = cur.pricing.cardmarket;
  const field = cur.useHolo ? `${t}-holo` : t;
  if (!cm) return { error: 'Keine Cardmarket-Daten für diese Karte. Quelle „TCGplayer Marktpreis“ oder „Eigener Wert“ wählen.' };
  const v = cm[field];
  if (v == null) return { error: `${cmLabel(field)} ist für diese Karte nicht verfügbar. Andere Quelle wählen.` };
  return { value: v, label: cmLabel(field), date: cm.updated, dateLabel: 'Preisstand', isApi: true, field };
}

/** Rechnung für die aktuelle Karte: { ref, r, pf, ecf } oder { error }. */
function computeEval() {
  const ref = resolveRef();
  if (ref.error) return { error: ref.error };
  const pf = settings.platforms[cur.platform];
  const ecf = effectiveCF(cur.gradedApi?.data);
  const custom = cur.refType === 'custom';
  const r = evaluate({
    referenz: ref.value, cf: ecf.cf, lf: settings.lf,
    meinZustand: cur.myCond, refZustand: custom ? cur.myCond : 'NM',
    meineSprache: cur.myLang, refSprache: custom ? cur.myLang : 'en',
    provision: pf.provision, versand: pf.versand, minNetto: settings.minNetto,
  });
  return { ref, r, pf, ecf, custom };
}

function updateCalc() {
  if (!cur || !$('#ev-value')) return;
  const e = computeEval();
  const valEl = $('#ev-value'), buyEl = $('#ev-buy'), out = $('#calc-out');
  if (e.error) {
    valEl.innerHTML = `<p class="err">${esc(e.error)}</p>`;
    buyEl.innerHTML = '';
    out.innerHTML = '';
    cur.last = null;
    return;
  }
  const { ref, r, pf, ecf, custom } = e;
  cur.last = { ref, r };
  const f2 = (v) => v.toLocaleString('de-DE', { maximumFractionDigits: 2 });
  const cm = cur.pricing.cardmarket;
  const pl = cmPlausible(cm, cur.useHolo);
  const enN = cur.enName?.name || cur.card.name;
  const cmExact = [enN, cur.setAbbr || '', cur.card.localId].filter(Boolean).join(' ');
  const pcQ = [enN, cur.enName?.set || cur.card.set?.name || '', cur.card.localId].filter(Boolean).join(' ');
  const factors = custom ? '' : [
    cur.myCond !== 'NM' ? `${cur.myCond} × ${f2(r.zf)}${ecf.fromMarket ? ' (echte Marktdaten)' : ''}` : '',
    cur.myLang !== 'en' ? `${LANG_LABELS[cur.myLang] || cur.myLang} × ${f2(r.sf)}` : '',
  ].filter(Boolean).join(' · ');

  valEl.innerHTML = `
    <div class="hero">
      <div class="lbl">Marktwert deiner Karte · ${cur.myCond} · ${esc(LANG_LABELS[cur.myLang] || cur.myLang)}${cur.useHolo ? ' · Reverse Holo' : ''}</div>
      <div class="val">${eur(r.brutto)}</div>
      <div class="sub">${custom ? 'Eigener Wert' : `${esc(ref.label.replace(/^Kombinierter Marktwert aus/, 'Median aus'))}: <b>${eur(ref.value)}</b> für Near Mint englisch`}${factors ? ' · ' + esc(factors) : ''}</div>
      <div class="date">Stand ${dt(ref.date)} · nach ${fmt1(pf.provision * 100)} % Gebühr und ${eur(pf.versand)} Versand bleiben <b>${eur(r.netto)}</b></div>
    </div>
    ${cm && !pl.ok ? `<div class="warn">Cardmarket-Werte widersprechen sich (${pl.vals.map((v) => eur(v)).join(' · ')}). Bitte gegenprüfen und ggf. die Variante wechseln; gerechnet wird vorsichtig mit dem niedrigsten Wert.</div>` : ''}
    <div class="quick-links">
      <a class="btn small primary" target="_blank" rel="noopener" href="https://www.cardmarket.com/de/Pokemon/Products/Search?category=-1&searchString=${encodeURIComponent(cmExact)}">Cardmarket ↗</a>
      <a class="btn small" target="_blank" rel="noopener" href="https://www.pricecharting.com/search-products?type=prices&q=${encodeURIComponent('pokemon ' + pcQ)}">PriceCharting ↗</a>
      <a class="btn small" target="_blank" rel="noopener" href="https://www.ebay.de/sch/i.html?_nkw=${encodeURIComponent(cur.ebayQuery)}&LH_Sold=1&LH_Complete=1&_sop=13">eBay verkauft ↗</a>
    </div>`;

  renderBuy(r);

  out.innerHTML = `
    <h3>Rechnung</h3>
    <div class="line"><span>Ausgangspreis: ${esc(ref.label)}</span><b>${eur(ref.value)}</b></div>
    ${ref.sources ? `<ul class="src-list">${ref.sources.map((x) => `<li><span>${esc(x.label)} <span class="meta">${new Date(x.date).toLocaleDateString('de-DE')}</span></span><b>${eur(x.eur)}</b></li>`).join('')}</ul>` : ''}
    ${!custom && cur.myCond !== 'NM' ? `<div class="line"><span>Zustand ${cur.myCond} statt Near Mint${ecf.fromMarket ? ' (laut echten Marktpreisen)' : ''}</span><b>× ${f2(r.zf)}</b></div>` : ''}
    ${!custom && cur.myLang !== 'en' ? `<div class="line"><span>Sprache ${esc(LANG_LABELS[cur.myLang] || cur.myLang)} statt Englisch</span><b>× ${f2(r.sf)}</b></div>` : ''}
    <div class="line"><span>Marktwert deiner Karte</span><b>${eur(r.brutto)}</b></div>
    <div class="line"><span>Nach ${fmt1(pf.provision * 100)} % Gebühr und ${eur(pf.versand)} Versand (${esc(pf.label)})</span><b>${eur(r.netto)}</b></div>
    <h3>Ankaufsleiter</h3>
    <table class="ladder">
      <tr><th>Ankauf bei</th><th>Höchstens zahlen</th><th>Gewinn</th><th>Rendite</th></tr>
      ${r.ladder.map((l) => `<tr class="${l.highlight ? 'hl' : ''}"><td>${Math.round(l.p * 100)} %</td><td>${eur(l.maxGebot)}</td><td>${eur(l.gewinn)}</td><td>${pct(l.rendite)}</td></tr>`).join('')}
    </table>
    ${r.unterMindest ? `<div class="warn">Nach Kosten unter ${eur(settings.minNetto)}: einzeln verkauft lohnt sich das kaum, eher im Sammelversand.</div>` : ''}`;
}

/** Ankauf: Verkäufer-Preis → Ampel → Gegenangebot → ich zahle → gekauft / Korb. */
function renderBuy(r) {
  const el = $('#ev-buy');
  if (cur.bought) {
    el.innerHTML = `
      <div class="bought-ok">
        <b>Gekauft für ${eur(cur.bought.price)}</b>
        <span class="meta">in der Sammlung gespeichert · erwarteter Gewinn ${eur(r.netto - cur.bought.price)}</span>
      </div>
      <label>Bezahlter Preis anpassen €<input id="bought-price" inputmode="decimal" value="${n2(cur.bought.price)}" /></label>
      <div class="grid2" style="margin-top:10px">
        <button class="primary" id="next-card">Nächste Karte</button>
        <button id="bought-undo" class="danger">Kauf rückgängig</button>
      </div>`;
    $('#bought-price').addEventListener('change', async (e) => {
      const v = parseNum(e.target.value);
      if (v == null || v < 0) return toast('Ungültiger Preis');
      const it = inventory.find((x) => x.uid === cur.bought.uid);
      if (it) { it.einkauf = v; await db.put('inventory', it); }
      cur.bought.price = v;
      renderBuy(r);
      toast('Preis angepasst');
    });
    $('#next-card').addEventListener('click', nextCard);
    $('#bought-undo').addEventListener('click', async () => {
      await db.del('inventory', cur.bought.uid);
      inventory = inventory.filter((x) => x.uid !== cur.bought.uid);
      cur.bought = null;
      renderBuy(r);
      toast('Kauf entfernt');
    });
    return;
  }
  const ask = cur.askPrice ?? null;
  const pay = cur.payPrice ?? (ask != null ? ask : Math.floor(r.ladder[1].maxGebot * 2) / 2);
  const cfg = flipCfg();
  const pfo = portfolio(inventory, { start: cfg.start, marktwert: (it) => itemValue(it).value, platform: itemPlatform });
  el.innerHTML = `
    <h2>Ankauf</h2>
    <label class="big-input">Verkäufer will<span class="eur-in"><input id="ask" inputmode="decimal" placeholder="Preis" value="${ask != null ? n2(ask) : ''}" /><i>€</i></span></label>
    <div id="ask-verdict">${ask != null ? verdictHtml(ask, r.netto) : `<p class="date">Höchstens ${eur(r.ladder[1].maxGebot)} zahlen (80 % von ${eur(r.netto)} nach Kosten).</p>`}</div>
    <div class="chip-label">Gegenangebot</div>
    <div class="chips offer-chips">
      ${r.ladder.map((l) => { const v = Math.floor(l.maxGebot * 2) / 2; return `<button data-pay="${v}" class="${Math.abs(v - pay) < 0.001 ? 'on' : ''} ${l.highlight ? 'rec' : ''}"><b>${eur(v)}</b><span>${Math.round(l.p * 100)} % · +${pct(l.rendite)}</span></button>`; }).join('')}
    </div>
    <label class="big-input">Ich zahle<span class="eur-in"><input id="pay" inputmode="decimal" value="${n2(pay)}" /><i>€</i></span></label>
    <div id="pay-verdict" class="pay-line">${pay ? `Gewinn <b class="${r.netto - pay >= 0 ? 'pos' : 'neg'}">${eur(r.netto - pay)}</b> · Rendite <b>${pay > 0 ? pct((r.netto - pay) / pay) : '–'}</b>` : ''}</div>
    <div class="grid2 buy-meta">
      <label>Gekauft über<select id="buy-wo">${optsOf(WO, cur.buyWo || 'laden')}</select></label>
      <label>Art<select id="buy-art">${optsOf(ART, cur.buyArt || (ask != null && Math.abs(pay - ask) > 0.001 ? 'vorschlag' : 'festpreis'))}</select></label>
    </div>
    <div class="grid2" style="margin-top:12px">
      <button class="primary" id="buy-now">Gekauft für ${eur(pay)}</button>
      <button id="to-cart">In den Korb</button>
    </div>
    ${cfg.start > 0 ? `<p class="date">Im Pott ${eur(pfo.kasse)} · danach ${eur(pfo.kasse - pay)}</p>` : ''}`;

  const askIn = $('#ask'), payIn = $('#pay');
  askIn.addEventListener('input', () => {
    cur.askPrice = parseNum(askIn.value);
    if (cur.payTouched !== true) cur.payPrice = cur.askPrice;
    $('#ask-verdict').innerHTML = cur.askPrice != null ? verdictHtml(cur.askPrice, r.netto) : '';
    if (cur.payTouched !== true && cur.askPrice != null) { payIn.value = n2(cur.askPrice); refreshPay(); }
  });
  const refreshPay = () => {
    const v = parseNum(payIn.value);
    cur.payPrice = v;
    $('#pay-verdict').innerHTML = v ? `Gewinn <b class="${r.netto - v >= 0 ? 'pos' : 'neg'}">${eur(r.netto - v)}</b> · Rendite <b>${v > 0 ? pct((r.netto - v) / v) : '–'}</b>` : '';
    $('#buy-now').textContent = `Gekauft für ${eur(v || 0)}`;
    $$('.offer-chips button', el).forEach((b) => b.classList.toggle('on', Math.abs(+b.dataset.pay - (v || 0)) < 0.001));
  };
  payIn.addEventListener('input', () => { cur.payTouched = true; refreshPay(); });
  $$('.offer-chips button', el).forEach((b) => b.addEventListener('click', () => { cur.payTouched = true; payIn.value = n2(+b.dataset.pay); refreshPay(); }));
  $('#buy-wo').addEventListener('change', (e) => { cur.buyWo = e.target.value; });
  $('#buy-art').addEventListener('change', (e) => { cur.buyArt = e.target.value; });
  $('#buy-now').addEventListener('click', () => buyNow(parseNum(payIn.value)));
  $('#to-cart').addEventListener('click', () => {
    const l80 = r.ladder.find((l) => l.highlight);
    addToCart(cur.last.ref, r, l80);
    const v = parseNum(payIn.value);
    const it = cart.find((x) => !x.bought && x.cardId === cur.card.id && x.zustand === cur.myCond && x.sprache === cur.myLang);
    if (it && v != null) { it.angebot = v; saveCart(); updateCartBtn(); }
  });
}

/** Direkt gekauft: in die Sammlung, Einkaufspreis = was ich zahle. */
async function buyNow(price) {
  if (price == null || price < 0) return toast('Bitte eintragen, was du zahlst');
  const c = cur.card;
  const ref = cur.last?.ref;
  const item = {
    uid: uid(), id: c.id, lang: cur.lang, name: c.name, setName: c.set?.name || '', setId: c.set?.id || setIdOf(c),
    localId: c.localId, official: c.set?.cardCount?.official ?? null, image: c.image || null,
    sprache: cur.myLang, zustand: cur.myCond, variante: cur.useHolo ? 'reverse' : 'standard',
    einkauf: price, datum: today(), status: 'bestand', verkauf: null, notiz: cur.askPrice != null && Math.abs(cur.askPrice - price) > 0.001 ? `Verkäufer wollte ${eur(cur.askPrice)}` : '',
    ekWo: cur.buyWo || 'laden', ekArt: cur.buyArt || (cur.askPrice != null && Math.abs(price - cur.askPrice) > 0.001 ? 'vorschlag' : 'festpreis'),
    refSprache: cur.refType === 'custom' ? cur.myLang : 'en', refZustand: cur.refType === 'custom' ? cur.myCond : 'NM',
    marketField: ref?.isApi ? ref.field : cur.useHolo ? 'trend-holo' : 'trend',
    manualRef: ref && !ref.isApi ? { value: ref.value, date: ref.date, label: ref.label } : null,
    pricing: cur.pricing, fetchedAt: cur.fetchedAt, offers: [],
    grading: cur.grading || null,
    gradedApi: cur.gradedApi && cur.gradedApi.status === 'ok' ? { data: cur.gradedApi.data, fetchedAt: cur.gradedApi.fetchedAt } : null,
    graded: cur.graded && Object.keys(cur.graded).length ? cur.graded : null,
    createdAt: Date.now(),
  };
  await db.put('inventory', item);
  inventory = await db.all('inventory');
  cur.bought = { uid: item.uid, price };
  if (navigator.vibrate) navigator.vibrate(30);
  updateCalc();
}

/** Zurück zur Suche, Eingabe leeren und fokussieren – für die nächste Karte im Laden. */
function nextCard() {
  show('search');
  const q = $('#q-name');
  q.value = '';
  $('#results').innerHTML = '';
  setStatus('');
  setMode('name');
  setTimeout(() => q.focus(), 50);
}

// ---------- Rechner ----------
/** Ampel: lohnt sich der Kauf zu `preis`, wenn nach Verkauf `netto` übrig bleibt? */
function verdict(preis, netto) {
  const gewinn = netto - preis;
  const rendite = preis > 0 ? gewinn / preis : null;
  const lvl = rendite == null ? 'bad' : rendite >= 0.25 && netto >= settings.minNetto * 0 ? 'good' : rendite >= 0.1 ? 'ok' : 'bad';
  const text = { good: 'Lohnt sich', ok: 'Knapp – nachverhandeln', bad: 'Lohnt sich nicht' }[lvl];
  return { gewinn, rendite, lvl, text, maxPreis: netto * 0.8 };
}
function verdictHtml(preis, netto) {
  const v = verdict(preis, netto);
  return `<div class="verdict ${v.lvl}">
    <b>${v.text}</b>
    <span>Gewinn ${eur(v.gewinn)} · Rendite ${v.rendite != null ? pct(v.rendite) : '–'}</span>
    <span class="meta">Für 25 % Rendite höchstens ${eur(netto / 1.25)} zahlen</span>
  </div>`;
}

const calcState = { single: { ek: null, vk: null }, rows: [], seller: null };
function renderCalc() {
  const el = $('#calc');
  const pf = settings.platforms[settings.platform];
  const s1 = calcState.single;
  const netto1 = s1.vk != null ? s1.vk * (1 - pf.provision) - pf.versand : null;
  const rowsNetto = calcState.rows.reduce((a, r) => a + (r.v ? r.v * (1 - pf.provision) - pf.versand : 0), 0);
  const rowsMarkt = calcState.rows.reduce((a, r) => a + (r.v || 0), 0);
  el.innerHTML = `
    <div class="card">
      <h2>Einzelkarte</h2>
      <div class="grid2">
        <label>Einkauf (Verkäufer will) €<input id="c1-ek" inputmode="decimal" value="${s1.ek != null ? n2(s1.ek) : ''}" placeholder="z. B. 20" /></label>
        <label>Verkaufswert (z. B. CM-Trend) €<input id="c1-vk" inputmode="decimal" value="${s1.vk != null ? n2(s1.vk) : ''}" placeholder="z. B. 30" /></label>
      </div>
      <p class="date">Verkauf über ${esc(pf.label)}: ${fmt1(pf.provision * 100)} % Gebühr, ${eur(pf.versand)} Versand (änderbar unter Optionen).</p>
      ${s1.ek != null && netto1 != null ? `<div class="line"><span>Nach Gebühr und Versand</span><b>${eur(netto1)}</b></div>` + verdictHtml(s1.ek, netto1) : ''}
    </div>
    <div class="card">
      <h2>Sammelankauf</h2>
      <p class="hint">Verkaufswert jeder Karte eintragen (oder aus dem Korb übernehmen), dazu den Gesamtpreis des Verkäufers.</p>
      <div id="c-rows">
        ${calcState.rows.map((r, i) => `<div class="inline c-row"><input data-rn="${i}" placeholder="Karte (optional)" value="${esc(r.n || '')}" /><input data-rv="${i}" inputmode="decimal" placeholder="Wert €" value="${r.v != null ? n2(r.v) : ''}" class="c-val" /><button class="x trash" data-rx="${i}" aria-label="Löschen">${TRASH}</button></div>`).join('')}
      </div>
      <div class="grid2" style="margin-top:8px">
        <button id="c-add">+ Karte</button>
        <button id="c-from-cart" ${cart.length ? '' : 'disabled'}>Aus Korb (${cart.length})</button>
      </div>
      <label class="row" style="margin-top:10px"><span>Verkäufer will gesamt €</span><input id="c-seller" inputmode="decimal" value="${calcState.seller != null ? n2(calcState.seller) : ''}" placeholder="z. B. 150" /></label>
      ${calcState.rows.length ? `
        <div class="line"><span>${calcState.rows.length} Karten · Verkaufswert</span><b>${eur(rowsMarkt)}</b></div>
        <div class="line"><span>Nach Gebühr und Versand (je Karte)</span><b>${eur(rowsNetto)}</b></div>
        <div class="line"><span>Höchstgebot (80 %)</span><b>${eur(rowsNetto * 0.8)}</b></div>
        ${calcState.seller != null ? verdictHtml(calcState.seller, rowsNetto) : ''}` : ''}
      ${calcState.rows.length ? '<button id="c-clear" class="block ghost danger">Liste leeren</button>' : ''}
    </div>`;
  const num = (sel, fn) => { const e = $(sel); if (e) e.addEventListener('change', () => { fn(parseNum(e.value)); renderCalc(); }); };
  num('#c1-ek', (v) => (s1.ek = v));
  num('#c1-vk', (v) => (s1.vk = v));
  num('#c-seller', (v) => (calcState.seller = v));
  $$('[data-rv]', el).forEach((e) => e.addEventListener('change', () => { calcState.rows[+e.dataset.rv].v = parseNum(e.value); renderCalc(); }));
  $$('[data-rn]', el).forEach((e) => e.addEventListener('change', () => { calcState.rows[+e.dataset.rn].n = e.value; }));
  $$('[data-rx]', el).forEach((e) => e.addEventListener('click', () => { calcState.rows.splice(+e.dataset.rx, 1); renderCalc(); }));
  $('#c-add').addEventListener('click', () => { calcState.rows.push({ n: '', v: null }); renderCalc(); const ins = $$('.c-val', el); if (ins.length) ins[ins.length - 1].focus(); });
  $('#c-from-cart').addEventListener('click', () => { calcState.rows = cart.map((it) => ({ n: it.name, v: Math.round(it.markt * 100) / 100 })); renderCalc(); });
  const cl = $('#c-clear');
  if (cl) cl.addEventListener('click', () => { calcState.rows = []; calcState.seller = null; renderCalc(); });
}

// ---------- Ankaufskorb ----------
let cart = [];
let cartRabatt = null; // null = Vorschlag nach Stückzahl
let cartSeller = null;
const rabattVorschlag = (n) => (n >= 20 ? 0.15 : n >= 10 ? 0.1 : n >= 5 ? 0.05 : 0);
const saveCart = () => kvSet('cart', { items: cart, rabatt: cartRabatt });
async function loadCart() {
  const c = await kvGet('cart', null);
  if (c) { cart = c.items || []; cartRabatt = c.rabatt ?? null; }
  updateCartBtn();
}
function cartTotals() {
  const rab = cartRabatt ?? rabattVorschlag(cart.filter((it) => !it.bought).length);
  const t = { n: cart.length, markt: 0, netto: 0, max80: 0, angebot: 0, rab };
  const open = cart.filter((it) => !it.bought);
  t.n = open.length;
  t.bought = cart.length - open.length;
  for (const it of open) { t.markt += it.markt || 0; t.netto += it.netto || 0; t.max80 += it.max80 || 0; t.angebot += it.angebot || 0; }
  t.gesamt = t.angebot * (1 - rab);
  t.gewinn = t.netto - t.gesamt;
  t.rendite = t.gesamt > 0 ? t.gewinn / t.gesamt : null;
  return t;
}
function updateCartBtn() {
  const b = $('#cart-btn');
  if (!b) return;
  const t = cartTotals();
  b.classList.toggle('hidden', !t.n);
  if (t.n) b.textContent = `Korb ${t.n} · ${eur(t.gesamt)}`;
}
$('#cart-btn').addEventListener('click', () => show('cart'));
$('#open-cart').addEventListener('click', () => show('cart'));
$('#open-calc').addEventListener('click', () => show('calc'));

function addToCart(ref, r, l80) {
  const c = cur.card;
  const existing = cart.find((x) => !x.bought && x.cardId === c.id && x.zustand === cur.myCond && x.sprache === cur.myLang);
  const item = {
    uid: existing?.uid || uid(), cardId: c.id, lang: cur.lang, name: c.name, setName: c.set?.name || '', localId: c.localId,
    official: c.set?.cardCount?.official ?? null, image: c.image || null, zustand: cur.myCond, sprache: cur.myLang,
    markt: r.brutto, netto: r.netto, max80: l80.maxGebot, angebot: existing?.angebot ?? Math.floor(l80.maxGebot * 2) / 2,
    refLabel: ref.label, refDate: ref.date, pricing: cur.pricing,
    gradedApi: cur.gradedApi && cur.gradedApi.status === 'ok' ? { data: cur.gradedApi.data, fetchedAt: cur.gradedApi.fetchedAt } : null,
    grading: cur.grading || null, addedAt: Date.now(),
  };
  if (existing) Object.assign(existing, item);
  else cart.push(item);
  saveCart();
  updateCartBtn();
  toast(existing ? 'Im Korb aktualisiert' : `In den Korb gelegt (${cartTotals().n})`);
}

function renderCart() {
  const el = $('#cart');
  const t = cartTotals();
  const cfg = flipCfg();
  const pf = portfolio(inventory, { start: cfg.start, marktwert: (it) => itemValue(it).value, platform: itemPlatform, erloes: (it) => itemCalc(it).netto });
  const cls = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
  if (!cart.length) {
    el.innerHTML = '<p class="empty">Der Korb ist leer. In der Bewertung „In den Ankaufskorb“ antippen.</p>';
    return;
  }
  if (!t.n) {
    el.innerHTML = `<div class="card"><p class="empty" style="padding:20px 0">Alle ${t.bought} Karten im Korb sind gekauft und in der Sammlung.</p>
      <button id="cart-rm-bought2" class="block">Gekaufte aus dem Korb entfernen</button></div>
      <div class="card">${cart.map((it) => `<div class="cart-item bought">${img(it.image, 'low', it.name)}<div><div class="n">${esc(it.name)}</div><div class="meta">${esc(it.setName)} · ${esc(it.localId)}</div></div><div class="right"><span class="tag">gekauft ${eur(it.paid)}</span></div></div>`).join('')}</div>`;
    $('#cart-rm-bought2').addEventListener('click', () => { cart = []; saveCart(); renderCart(); updateCartBtn(); });
    return;
  }
  const vors = rabattVorschlag(t.n);
  const openItems = cart.filter((it) => !it.bought);
  const boughtItems = cart.filter((it) => it.bought);
  el.innerHTML = `
    <div class="card">
      <div class="hero">
        <div class="lbl">Gesamtangebot für ${t.n} Karte${t.n > 1 ? 'n' : ''}</div>
        <div class="val">${eur(t.gesamt)}</div>
        <div class="sub">Erwarteter Gewinn <b class="${cls(t.gewinn)}">${eur(t.gewinn)}</b>${t.rendite != null ? ` · Rendite <b>${pct(t.rendite)}</b>` : ''}</div>
      </div>
      <h3>Mengenrabatt vom Verkäufer</h3>
      <div class="seg rabatt-seg">${[0, 0.05, 0.1, 0.15, 0.2].map((v) => `<button data-r="${v}" class="${Math.abs(t.rab - v) < 1e-9 ? 'on' : ''}">${v * 100} %</button>`).join('')}</div>
      <label class="row"><span>Eigener Rabatt %</span><input id="cart-rab" inputmode="decimal" value="${fmt1(t.rab * 100)}" /></label>
      <p class="date">Vorschlag bei ${t.n} Karten: ${fmt1(vors * 100)} % (ab 5 Karten 5 %, ab 10 Karten 10 %, ab 20 Karten 15 %).${cartRabatt != null ? ' <a href="#" id="cart-rab-auto">Vorschlag verwenden</a>' : ''}</p>
      <div class="cart-sum">
        <div class="line"><span>Verkaufswert aller Karten</span><b>${eur(t.markt)}</b></div>
        <div class="line"><span>Nach Gebühren und Versand</span><b>${eur(t.netto)}</b></div>
        <div class="line"><span>Summe Höchstgebote (80 %)</span><b>${eur(t.max80)}</b></div>
        <div class="line"><span>Summe deiner Einzelangebote</span><b>${eur(t.angebot)}</b></div>
        <div class="line"><span>Mengenrabatt ${fmt1(t.rab * 100)} %</span><b>− ${eur(t.angebot - t.gesamt)}</b></div>
        <div class="line"><span><b>Gesamtangebot</b></span><b>${eur(t.gesamt)}</b></div>
        <div class="line"><span>Pott jetzt → nach dem Kauf</span><b class="${pf.kasse - t.gesamt < 0 ? 'neg' : ''}">${eur(pf.kasse)} → ${eur(pf.kasse - t.gesamt)}</b></div>
      </div>
      ${t.angebot > t.max80 + 0.01 ? '<div class="warn">Deine Einzelangebote liegen über den 80-%-Höchstgeboten. Der Flip wird dünner.</div>' : ''}
      <label class="row" style="margin-top:10px"><span>Verkäufer will gesamt €</span><input id="cart-seller" inputmode="decimal" value="${cartSeller != null ? n2(cartSeller) : ''}" placeholder="optional" /></label>
      ${cartSeller != null ? verdictHtml(cartSeller, t.netto) : ''}
      <div class="grid2" style="margin-top:12px">
        <button id="cart-share">Angebot teilen</button>
        <button id="cart-buy" class="primary">Alle gekauft</button>
      </div>
      ${t.bought ? `<button id="cart-rm-bought" class="block ghost">${t.bought} gekaufte entfernen</button>` : ''}
      <button id="cart-clear" class="block ghost danger">Korb leeren</button>
    </div>
    <div class="card">
      ${[...openItems, ...boughtItems].map((it) => `
        <div class="cart-item ${it.bought ? 'bought' : ''}" data-uid="${it.uid}">
          ${img(it.image, 'low', it.name)}
          <div>
            <div class="n">${esc(it.name)}</div>
            <div class="meta">${esc(it.setName)} · ${esc(it.localId)}${it.official ? '/' + it.official : ''} · ${esc(it.zustand)} · ${esc(LANG_LABELS[it.sprache] || it.sprache)}</div>
            <div class="meta">Wert ${eur(it.markt)} · höchstens ${eur(it.max80)}${t.rab ? ` · nach Rabatt ${eur(it.angebot * (1 - t.rab))}` : ''}</div>
          </div>
          <div class="right">
            ${it.bought ? `<span class="tag">gekauft ${eur(it.paid)}</span>` : `<input class="offer-in" data-off="${it.uid}" inputmode="decimal" value="${n2(it.angebot)}" aria-label="Mein Angebot" />`}
            <button class="x trash" data-rm="${it.uid}" aria-label="Löschen">${TRASH}</button>
          </div>
        </div>`).join('')}
      <p class="date">Einzelangebote sind mit dem 80-%-Höchstgebot vorbelegt (auf 0,50 € abgerundet) und änderbar. Werte nach Zustand und Sprache, Stand der Bewertung.</p>
    </div>`;
  $$('.rabatt-seg button', el).forEach((b) => b.addEventListener('click', () => { cartRabatt = +b.dataset.r; saveCart(); renderCart(); updateCartBtn(); }));
  $('#cart-rab').addEventListener('change', (e) => {
    const v = parseNum(e.target.value);
    if (v == null || v < 0 || v > 90) return toast('Rabatt zwischen 0 und 90 %');
    cartRabatt = v / 100; saveCart(); renderCart(); updateCartBtn();
  });
  const auto = $('#cart-rab-auto');
  if (auto) auto.addEventListener('click', (e) => { e.preventDefault(); cartRabatt = null; saveCart(); renderCart(); updateCartBtn(); });
  $$('[data-off]', el).forEach((inp) => inp.addEventListener('change', () => {
    const it = cart.find((x) => x.uid === inp.dataset.off);
    const v = parseNum(inp.value);
    if (v == null || v < 0) return toast('Ungültiger Preis');
    it.angebot = v; saveCart(); renderCart(); updateCartBtn();
  }));
  $$('[data-rm]', el).forEach((b) => b.addEventListener('click', () => {
    const i = cart.findIndex((x) => x.uid === b.dataset.rm); if (i < 0) return;
    const [it] = cart.splice(i, 1); saveCart(); renderCart(); updateCartBtn();
    toastUndo('Aus dem Korb entfernt', () => { cart.splice(i, 0, it); saveCart(); renderCart(); updateCartBtn(); });
  }));
  enableSwipe(el, '.cart-item', (u) => {
    const i = cart.findIndex((x) => x.uid === u);
    if (i < 0) return null;
    const [it] = cart.splice(i, 1);
    saveCart(); renderCart(); updateCartBtn();
    return () => { cart.splice(i, 0, it); saveCart(); renderCart(); updateCartBtn(); };
  }, 'Aus dem Korb entfernt');
  const rmb = $('#cart-rm-bought');
  if (rmb) rmb.addEventListener('click', () => { cart = cart.filter((x) => !x.bought); saveCart(); renderCart(); });
  $('#cart-seller').addEventListener('change', (e) => { cartSeller = parseNum(e.target.value); renderCart(); });
  $('#cart-clear').addEventListener('click', () => { if (confirm('Korb leeren?')) { cart = []; cartRabatt = null; saveCart(); renderCart(); updateCartBtn(); } });
  $('#cart-share').addEventListener('click', async () => {
    const lines = cart.filter((it) => !it.bought).map((it) => `${it.name} (${it.setName} ${it.localId}${it.official ? '/' + it.official : ''}, ${it.zustand}): ${eur(it.angebot)}`);
    const text = `Mein Angebot für ${t.n} Karten:\n${lines.join('\n')}\n\nSumme: ${eur(t.angebot)}${t.rab ? `\nMengenrabatt ${fmt1(t.rab * 100)} %: − ${eur(t.angebot - t.gesamt)}` : ''}\nGesamtangebot: ${eur(t.gesamt)}`;
    try {
      if (navigator.share) { await navigator.share({ title: 'Angebot', text }); return; }
    } catch (e) { if (e && e.name === 'AbortError') return; }
    try { await navigator.clipboard.writeText(text); toast('Angebot kopiert'); } catch { prompt('Angebot kopieren:', text); }
  });
  $('#cart-buy').addEventListener('click', async () => {
    if (!t.n) return toast('Keine offenen Karten im Korb');
    if (!confirm(`Alle ${t.n} Karten für zusammen ${eur(t.gesamt)} in die Sammlung übernehmen?`)) return;
    for (const it of cart.filter((x) => !x.bought)) {
      it.bought = true;
      it.paid = Math.round(it.angebot * (1 - t.rab) * 100) / 100;
      await db.put('inventory', {
        uid: uid(), id: it.cardId, lang: it.lang, name: it.name, setName: it.setName, setId: setIdOf({ id: it.cardId, localId: it.localId }),
        localId: it.localId, official: it.official, image: it.image, sprache: it.sprache, zustand: it.zustand,
        einkauf: Math.round(it.angebot * (1 - t.rab) * 100) / 100, datum: today(), status: 'bestand', verkauf: null, notiz: t.n > 1 ? `Sammelkauf (${t.n} Karten, ${fmt1(t.rab * 100)} % Rabatt)` : '',
        refSprache: 'en', refZustand: 'NM', marketField: 'kombi', manualRef: null, pricing: it.pricing, fetchedAt: Date.now(),
        gradedApi: it.gradedApi, grading: it.grading, offers: [], createdAt: Date.now(),
      });
    }
    inventory = await db.all('inventory');
    cartRabatt = null; cartSeller = null; saveCart(); updateCartBtn();
    toast(`${t.n} Karten in die Sammlung übernommen (im Korb als gekauft markiert)`);
    show('inv');
  });
}


// ---------- Ankauf-Buch: Eingabe mit Kartenvorschlägen, Verkaufsvorschlag (anpassbar), Bibliothek mit Bearbeiten/Foto, Wischen ----------
let book = [];
let bookOpen = null;      // uid des Eintrags in Bearbeitung
let draft = null;          // Formularzustand „Neu angekauft“
const saveBook = () => kvSet('flipbook', book);
let lot = { items: [], total: null };  // Sammelkauf in Arbeit
const saveLot = () => kvSet('lotdraft', lot);
async function loadBook() { book = (await kvGet('flipbook', [])) || []; lot = (await kvGet('lotdraft', null)) || { items: [], total: null }; }
/** Gesamtpreis nach Marktwert auf die Karten verteilen; Mindestpreis je Karte für die Zielmarge. */
function lotCalc() {
  const cfg = flipCfg();
  const pf = settings.platforms[settings.platform];
  const w = lot.items.map((x) => x.market ?? x.autoVorschlag ?? x.vorschlag ?? 0);
  const sw = w.reduce((a, b) => a + b, 0);
  const n = lot.items.length;
  const rows = lot.items.map((x, i) => {
    const ek = lot.total != null && n ? lot.total * (sw > 0 ? w[i] / sw : 1 / n) : null;
    const min = ek != null ? Math.ceil(((ek * (1 + cfg.marge) + pf.versand) / (1 - pf.provision)) * 2) / 2 : null;
    const vk = x.vorschlag;
    const gewinn = vk != null && ek != null ? vk * (1 - pf.provision) - pf.versand - ek : null;
    return { x, ek, min, vk, gewinn };
  });
  const markt = lot.items.reduce((a, x) => a + (x.market || 0), 0);
  const vkSum = rows.reduce((a, r) => a + (r.vk || 0), 0);
  const gewinn = rows.reduce((a, r) => a + (r.gewinn || 0), 0);
  return { rows, markt, vkSum, gewinn, quote: lot.total != null && markt > 0 ? lot.total / markt : null, marge: cfg.marge };
}
function lotHtml(cls) {
  if (!lot.items.length) return '';
  const c = lotCalc();
  return `<div class="card lot">
    <h2>Sammelkauf · ${lot.items.length} Karten</h2>
    <label>Gesamt bezahlt €<input id="lot-total" inputmode="decimal" value="${lot.total != null ? n2(lot.total) : ''}" placeholder="z. B. 50" /></label>
    <div class="hero" style="margin-top:10px">
      <div class="lbl">Erwarteter Gewinn zusammen</div>
      <div class="val ${cls(c.gewinn)}">${lot.total != null ? (c.gewinn > 0 ? '+' : '') + eur(c.gewinn) : '–'}</div>
      <div class="sub">Marktwert ${eur(c.markt)}${c.quote != null ? ` · bezahlt ${fmt1(c.quote * 100)} % vom Marktwert` : ''} · Verkauf zusammen ${eur(c.vkSum)}</div>
    </div>
    ${c.rows.map((r, i) => `<div class="lot-row">
      <div><div class="n">${esc(r.x.name)}${r.x.nr ? ' <span class="meta">' + esc(r.x.nr) + '</span>' : ''}</div>
        <div class="meta">${esc(r.x.note || '–')} · Marktwert ${r.x.market != null ? eur(r.x.market) : '–'}${r.ek != null ? ` · anteilig bezahlt <b>${eur(r.ek)}</b>` : ''}</div>
        ${r.min != null ? `<div class="date">mind. ${eur(r.min)} für ${fmt1(c.marge * 100)} % Marge${r.gewinn != null ? ` · Gewinn <b class="${cls(r.gewinn)}">${eur(r.gewinn)}</b>` : ''}</div>` : ''}</div>
      <label class="lot-vk">Verkauf €<input data-lotvk="${i}" inputmode="decimal" value="${r.vk != null ? n2(r.vk) : ''}" /></label>
      <button class="x" data-lotdel="${i}" aria-label="Entfernen">×</button>
    </div>`).join('')}
    <div class="grid2" style="margin-top:10px">
      <button data-lotmin="1">Alle auf Mindestpreis</button>
      <button data-lotdrop="1">Verwerfen</button>
    </div>
    <button class="primary block" id="lot-save" style="margin-top:8px">Kauf speichern (${lot.items.length} Karten)</button>
  </div>`;
}
function bindLot(el) {
  const t = $('#lot-total', el);
  if (!t) return;
  t.addEventListener('change', () => { lot.total = parseNum(t.value); saveLot(); renderBook(); });
  $$('[data-lotvk]', el).forEach((inp) => inp.addEventListener('change', () => { const x = lot.items[+inp.dataset.lotvk]; x.vorschlag = parseNum(inp.value); x.manual = true; saveLot(); renderBook(); }));
  $$('[data-lotdel]', el).forEach((b) => b.addEventListener('click', () => { lot.items.splice(+b.dataset.lotdel, 1); saveLot(); renderBook(); }));
  $('[data-lotmin]', el).addEventListener('click', () => { lotCalc().rows.forEach((r) => { if (r.min != null) { r.x.vorschlag = r.min; r.x.manual = true; } }); saveLot(); renderBook(); });
  $('[data-lotdrop]', el).addEventListener('click', () => { if (confirm('Sammelkauf verwerfen?')) { lot = { items: [], total: null }; saveLot(); renderBook(); } });
  $('#lot-save', el).addEventListener('click', () => {
    if (lot.total == null) return toast('Gesamtpreis eintragen');
    const c = lotCalc(), lotId = uid(), now = Date.now();
    c.rows.forEach((r) => book.unshift({ ...r.x, ek: Math.round(r.ek * 100) / 100, uid: uid(), datum: now, vk: null, lotId, notiz: [r.x.notiz, `Sammelkauf ${c.rows.length} Karten für ${eur(lot.total)}`].filter(Boolean).join(' · ') }));
    saveBook();
    lot = { items: [], total: null }; saveLot();
    renderBook();
    toast(`${c.rows.length} Karten gespeichert`);
  });
}
const NOTE_COND = { MT: 'MT', NM: 'NM', EX: 'EX', GD: 'GD', LP: 'LP', PL: 'PL', PO: 'PO' };
const newDraft = () => ({ name: '', nr: '', note: 'NM', lang: tcgLangToLf(settings.searchLang) || 'de', ek: null, vorschlag: null, manual: false, notiz: '', cardId: null, cardLang: null, image: null, market: null, vorschlagInfo: '' });

/** Marktwert + Verkaufsvorschlag. Mit cardId exakt, sonst Suche über Name/Nummer. Überschreibt keinen manuellen Preis. */
async function suggestPrice(e) {
  const cfg = flipCfg();
  const pf = settings.platforms[settings.platform];
  const target = e.ek != null ? (e.ek * (1 + cfg.marge) + pf.versand) / (1 - pf.provision) : null;
  let market = null, note = '';
  try {
    let id = e.cardId, lang = e.cardLang;
    if (!id && e.name) {
      const list = await searchSmart(settings.searchLang, `${e.name}${e.nr ? ' ' + e.nr : ''}`, langAvail);
      if (list[0] && list[0]._s < 3) { id = list[0].id; lang = list[0].lang || settings.searchLang; e.match = `${list[0].name} · ${list[0].setName || ''} ${list[0].localId}`; }
    }
    if (id) {
      const r = await getCard(lang, id, { force: false });
      if (r.data) {
        const base = combine(marketSources(extractPricing(r.data), null, []));
        const cond = NOTE_COND[(e.note || '').toUpperCase()] || 'NM';
        const lf = settings.lf[e.lang] != null ? e.lang : 'en';
        if (base != null) market = marktwert({ referenz: base, cf: settings.cf, lf: settings.lf, zustand: cond, sprache: lf, refZustand: 'NM', refSprache: 'en' });
        e.cardId = id; e.cardLang = lang;
        e.image = e.image || r.data.image || null;
        e.match = e.match || `${r.data.name} · ${r.data.set?.name || ''} ${r.data.localId}`;
        if (/^(PSA|BGS|CGC|SGC)/i.test(e.note || '')) note = 'Gegradet: Marktwert gilt ungegradet – Graded-Preis über „Bewerten“ prüfen und Preis anpassen.';
      }
    }
  } catch {}
  e.market = market;
  e.marketAt = Date.now();
  const auto = market != null ? roundPrice(market * (1 - cfg.undercut)) : target != null ? Math.ceil(target * 2) / 2 : null;
  if (!e.manual) e.vorschlag = auto;
  e.autoVorschlag = auto;
  e.vorschlagInfo = market != null ? `Marktwert ${eur(market)}${e.match ? ' (' + e.match + ')' : ''} · Vorschlag ${fmt1(cfg.undercut * 100)} % darunter` : target != null ? `Keine Marktdaten – Einkauf + ${fmt1(cfg.marge * 100)} % Marge + Gebühren` : '';
  e.hinweis = note;
  return e;
}

function bookProfit(e, vk = e.vk, versand = e.versand) {
  const pf = settings.platforms[e.vkPlattform || settings.platform] || settings.platforms.cardmarket;
  const netto = vk * (1 - pf.provision) - (versand ?? 0);
  return { netto, gewinn: netto - (e.ek || 0) };
}

function photoToData(file, max = 700) {
  return new Promise((res) => {
    const im = new Image();
    im.onload = () => {
      const s = Math.min(1, max / Math.max(im.naturalWidth, im.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(im.naturalWidth * s); c.height = Math.round(im.naturalHeight * s);
      c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
      URL.revokeObjectURL(im.src);
      res(c.toDataURL('image/jpeg', 0.8));
    };
    im.onerror = () => res(null);
    im.src = URL.createObjectURL(file);
  });
}
const thumbOf = (e) => (e.photo ? `<img src="${e.photo}" alt="">` : e.image ? img(e.image, 'low', e.name) : '<div class="thumb-ph">–</div>');
const langSel = (id, val, attr = 'id') => `<select ${attr}="${id}">${LANG_CHIPS.filter((k) => settings.lf[k] != null).map((k) => `<option value="${k}" ${k === val ? 'selected' : ''}>${LANG_LABELS[k]}</option>`).join('')}</select>`;
const NOTE_LIST = ['MT', 'NM', 'EX', 'GD', 'LP', 'PL', 'PO', 'PSA 10', 'PSA 9', 'PSA 8', 'PSA 7', 'BGS 9.5', 'BGS 9', 'CGC 10', 'CGC 9.5'];

function renderBook() {
  const el = $('#book');
  if (!el) return;
  draft = draft || newDraft();
  const d = draft;
  const sold = book.filter((e) => e.vk != null);
  const open = book.filter((e) => e.vk == null);
  const gewinn = sold.reduce((a, e) => a + bookProfit(e).gewinn, 0);
  const umsatz = sold.reduce((a, e) => a + e.vk, 0);
  const ekOpen = open.reduce((a, e) => a + (e.ek || 0), 0);
  const wertOpen = open.reduce((a, e) => a + (e.vorschlag || 0), 0);
  const cls = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
  const pf0 = settings.platforms[settings.platform];
  el.innerHTML = `
    <div class="card">
      <div class="hero">
        <div class="lbl">Gesamttopf · Gewinn aus ${sold.length} Verkäufen</div>
        <div class="val ${cls(gewinn)}">${gewinn > 0 ? '+' : ''}${eur(gewinn)}</div>
        <div class="sub">Umsatz ${eur(umsatz)} · offen ${open.length} Karten, gekauft für ${eur(ekOpen)}, Ziel zusammen ${eur(wertOpen)}</div>
      </div>
    </div>
    ${lotHtml(cls)}
    <div class="card">
      <h2>${lot.items.length ? 'Weitere Karte zum Sammelkauf' : 'Neu angekauft'}</h2>
      <form id="book-form" class="book-form" autocomplete="off">
        <label class="wide ac-wrap">Karte<input id="b-name" value="${esc(d.name)}" placeholder="Tippen, z. B. Glurak ex" required />
          <div id="b-ac" class="ac-list hidden"></div></label>
        ${d.cardId ? `<div class="wide picked">${d.image ? img(d.image, 'low', d.name) : ''}<span>${esc(d.match || '')}</span><button type="button" class="x" id="b-unpick" aria-label="Auswahl lösen">×</button></div>` : ''}
        <label>Nummer<input id="b-nr" value="${esc(d.nr)}" placeholder="006/165" /></label>
        <label>Note / Zustand<input id="b-note" list="b-notes" value="${esc(d.note)}" placeholder="NM, LP, PSA 10 …" /></label>
        <datalist id="b-notes">${NOTE_LIST.map((x) => `<option value="${x}">`).join('')}</datalist>
        <label>Sprache${langSel('b-lang', d.lang)}</label>
        <label>Gekauft für €<input id="b-ek" inputmode="decimal" value="${d.ek != null ? n2(d.ek) : ''}" placeholder="${lot.items.length ? 'über Gesamtpreis' : 'z. B. 20'}" /></label>
        <label class="wide">Verkaufspreis € <span class="meta">${d.manual ? '(von dir angepasst)' : '(Vorschlag, anpassbar)'}</span>
          <span class="inline"><input id="b-vk" inputmode="decimal" value="${d.vorschlag != null ? n2(d.vorschlag) : ''}" placeholder="wird berechnet" /><button type="button" id="b-calc">Berechnen</button></span></label>
        <p class="date wide" id="b-info">${esc(d.vorschlagInfo || '')}${d.hinweis ? ' · ' + esc(d.hinweis) : ''}${d.vorschlag != null && d.ek != null ? ` · erwarteter Gewinn <b class="${cls(bookProfit(d, d.vorschlag, pf0.versand).gewinn)}">${eur(bookProfit(d, d.vorschlag, pf0.versand).gewinn)}</b>` : ''}</p>
        <label class="wide">Notiz<input id="b-notiz" value="${esc(d.notiz)}" placeholder="optional, z. B. Laden XY, leichte Weißung" /></label>
        <label class="btn wide">Foto hinzufügen${d.photo ? ' ✓' : ''}<input id="b-photo" type="file" accept="image/*" hidden /></label>
        ${lot.items.length ? '' : '<button class="primary wide" type="submit">In die Bibliothek</button>'}
        <button type="button" class="wide" id="b-lotadd">${lot.items.length ? 'Zum Sammelkauf hinzufügen' : '+ Weitere Karte zu diesem Kauf'}</button>
      </form>
    </div>
    <div class="card">
      <h2>Bibliothek · ${book.length}</h2>
      <p class="date">Antippen = bearbeiten · nach rechts wischen = verkauft · nach links wischen = löschen</p>
      ${book.length ? [...open, ...sold].map((e) => bookRowHtml(e, cls)).join('') : '<p class="empty">Noch nichts angekauft.</p>'}
    </div>`;
  bindBookForm(el);
  bindBookRows(el);
  bindLot(el);
}

function bookRowHtml(e, cls) {
  const p = e.vk != null ? bookProfit(e) : null;
  const pf0 = settings.platforms[settings.platform];
  const editing = bookOpen === e.uid;
  return `<div class="book-row ${e.vk != null ? 'sold' : ''} ${editing ? 'editing' : ''}" data-uid="${e.uid}">
    ${thumbOf(e)}
    <div>
      <div class="n">${esc(e.name)}${e.nr ? ' <span class="meta">' + esc(e.nr) + '</span>' : ''}</div>
      <div class="meta">${esc(e.note || '–')} · ${esc(LANG_LABELS[e.lang] || e.lang)} · gekauft ${eur(e.ek)} am ${new Date(e.datum).toLocaleDateString('de-DE')}</div>
      ${e.vk != null ? `<div class="meta">verkauft für <b>${eur(e.vk)}</b>, Versand ${eur(e.versand ?? 0)} · ${new Date(e.vkDatum).toLocaleDateString('de-DE')}</div>`
        : `<div class="date">${e.market != null ? `Marktwert ${eur(e.market)} · Stand ${new Date(e.marketAt || e.datum).toLocaleDateString('de-DE')}` : 'kein Marktwert'}${e.manual ? ' · Preis von dir gesetzt' : ''}</div>`}
      ${e.notiz ? `<div class="date">${esc(e.notiz)}</div>` : ''}
    </div>
    <div class="right">
      ${p ? `<span class="meta">Gewinn</span><b class="${cls(p.gewinn)}">${p.gewinn > 0 ? '+' : ''}${eur(p.gewinn)}</b>`
        : `<span class="meta">Verkaufen für</span><b>${e.vorschlag != null ? eur(e.vorschlag) : '–'}</b>${e.vorschlag != null && e.ek != null ? `<span class="meta ${cls(bookProfit(e, e.vorschlag, pf0.versand).gewinn)}">~${eur(bookProfit(e, e.vorschlag, pf0.versand).gewinn)}</span>` : ''}`}
    </div>
    ${editing ? `<div class="book-edit" data-edit="${e.uid}">
      ${e.photo ? `<img class="book-photo" src="${e.photo}" alt="Foto">` : ''}
      <div class="grid2">
        <label class="wide2">Karte<input data-f="name" value="${esc(e.name)}" /></label>
        <label>Nummer<input data-f="nr" value="${esc(e.nr || '')}" /></label>
        <label>Note<input data-f="note" list="b-notes" value="${esc(e.note || '')}" /></label>
        <label>Sprache${langSel('lang', e.lang, 'data-f')}</label>
        <label>Gekauft für €<input data-f="ek" inputmode="decimal" value="${e.ek != null ? n2(e.ek) : ''}" /></label>
        <label>Verkaufspreis (Ziel) €<input data-f="vorschlag" inputmode="decimal" value="${e.vorschlag != null ? n2(e.vorschlag) : ''}" /></label>
        ${e.vk != null ? `<label>Verkauft für €<input data-f="vk" inputmode="decimal" value="${n2(e.vk)}" /></label><label>Versand €<input data-f="versand" inputmode="decimal" value="${n2(e.versand ?? 0)}" /></label>` : ''}
      </div>
      <label>Notiz<input data-f="notiz" value="${esc(e.notiz || '')}" /></label>
      <p class="date">${esc(e.vorschlagInfo || '')}${e.autoVorschlag != null && e.manual ? ` · berechnet wären ${eur(e.autoVorschlag)}` : ''}</p>
      <div class="grid2">
        <label class="btn">${e.photo ? 'Foto ersetzen' : 'Foto hinzufügen'}<input type="file" accept="image/*" data-photo="${e.uid}" hidden /></label>
        <button data-recalc="${e.uid}">Marktwert neu berechnen</button>
        ${e.vk == null ? `<button class="primary" data-opensell="${e.uid}">Verkauft …</button>` : `<button data-unsell="${e.uid}">Verkauf zurücknehmen</button>`}
        <button data-close="${e.uid}">Fertig</button>
      </div>
      <div class="sell-sheet hidden" data-sheet="${e.uid}">
        <div class="grid2">
          <label>Verkauft für €<input data-vk="${e.uid}" inputmode="decimal" value="${e.vorschlag != null ? n2(e.vorschlag) : ''}" /></label>
          <label>Versand €<input data-vs="${e.uid}" inputmode="decimal" value="${n2(pf0.versand)}" /></label>
        </div>
        <label>Über<select data-vp="${e.uid}">${Object.entries(settings.platforms).map(([k, x]) => `<option value="${k}" ${k === settings.platform ? 'selected' : ''}>${esc(x.label)} (${fmt1(x.provision * 100)} %)</option>`).join('')}</select></label>
        <button class="primary block" data-sell="${e.uid}">Als verkauft speichern</button>
      </div>
    </div>` : ''}
  </div>`;
}

function bindBookForm(el) {
  const d = draft;
  const nameIn = $('#b-name', el), ac = $('#b-ac', el);
  let t = null, seq = 0;
  const readForm = () => {
    d.name = nameIn.value.trim(); d.nr = $('#b-nr', el).value.trim(); d.note = $('#b-note', el).value.trim();
    d.lang = $('#b-lang', el).value; d.ek = parseNum($('#b-ek', el).value); d.notiz = $('#b-notiz', el).value.trim();
    const vk = parseNum($('#b-vk', el).value);
    if (vk != null && vk !== d.vorschlag) { d.vorschlag = vk; d.manual = true; }
  };
  nameIn.addEventListener('input', () => {
    clearTimeout(t);
    if (d.cardId) { d.cardId = null; d.match = ''; d.image = null; }
    const q = nameIn.value.trim();
    if (q.length < 2) { ac.classList.add('hidden'); return; }
    t = setTimeout(async () => {
      const my = ++seq;
      ac.innerHTML = '<div class="ac-item meta">Suche …</div>'; ac.classList.remove('hidden');
      let list = [];
      try { list = await searchSmart(settings.searchLang, q, langAvail); } catch {}
      if (my !== seq) return;
      ac.innerHTML = list.slice(0, 8).map((c, i) => `<button type="button" class="ac-item" data-i="${i}">${img(c.image, 'low', c.name)}<span><b>${esc(c.name)}</b><span class="meta">${esc(c.setName || '')} · ${esc(c.localId)}${c.setCount ? '/' + c.setCount.official : ''}</span></span></button>`).join('') || '<div class="ac-item meta">Keine Treffer</div>';
      $$('.ac-item[data-i]', ac).forEach((b) => b.addEventListener('mousedown', (ev) => ev.preventDefault()));
      $$('.ac-item[data-i]', ac).forEach((b) => b.addEventListener('click', async () => {
        const c = list[+b.dataset.i];
        readForm();
        Object.assign(d, { name: c.name, nr: `${c.localId}${c.setCount ? '/' + c.setCount.official : ''}`, cardId: c.id, cardLang: c.lang || settings.searchLang, image: c.image || null, match: `${c.name} · ${c.setName || ''} ${c.localId}`, lang: tcgLangToLf(c.lang || settings.searchLang) || d.lang });
        ac.classList.add('hidden');
        renderBook();
        $('#b-info').textContent = 'Berechne Marktwert …';
        await suggestPrice(d);
        renderBook();
        if (d.ek == null) $('#b-ek').focus();
      }));
    }, 350);
  });
  nameIn.addEventListener('blur', () => setTimeout(() => ac.classList.add('hidden'), 150));
  const unpick = $('#b-unpick', el);
  if (unpick) unpick.addEventListener('click', () => { readForm(); Object.assign(d, { cardId: null, match: '', image: null, market: null }); renderBook(); });
  $('#b-vk', el).addEventListener('input', () => { d.manual = true; });
  ['#b-note', '#b-lang', '#b-ek'].forEach((sel) => $(sel, el).addEventListener('change', async () => {
    readForm();
    if (d.cardId || d.name) { await suggestPrice(d); renderBook(); }
  }));
  $('#b-calc', el).addEventListener('click', async () => {
    readForm(); d.manual = false;
    $('#b-info').textContent = 'Berechne …';
    await suggestPrice(d); renderBook();
  });
  $('#b-photo', el).addEventListener('change', async (ev) => {
    const f = ev.target.files && ev.target.files[0];
    if (!f) return;
    readForm(); d.photo = await photoToData(f); renderBook(); toast('Foto hinzugefügt');
  });
  $('#b-lotadd', el).addEventListener('click', async () => {
    readForm();
    if (!d.name) return toast('Karte eintragen');
    if (d.market == null && !d.manual) await suggestPrice(d);
    if (!lot.items.length && d.ek != null) lot.total = d.ek;
    lot.items.push({ ...d });
    saveLot();
    draft = { ...newDraft(), lang: d.lang };
    renderBook();
    toast(`${lot.items.length} Karten im Sammelkauf`);
    $('#b-name').focus();
  });
  $('#book-form', el).addEventListener('submit', async (ev) => {
    ev.preventDefault();
    readForm();
    if (!d.name || d.ek == null) return toast('Karte und Einkaufspreis eintragen');
    if (d.vorschlag == null || (!d.manual && d.market == null)) await suggestPrice(d);
    const e = { ...d, uid: uid(), datum: Date.now(), vk: null };
    book.unshift(e);
    saveBook();
    draft = newDraft();
    renderBook();
    toast(e.vorschlag != null ? `Gespeichert · verkaufen für ${eur(e.vorschlag)}` : 'Gespeichert');
    $('#b-name').focus();
  });
}

function bindBookRows(el) {
  const find = (u) => book.find((x) => x.uid === u);
  // Antippen = bearbeiten (nicht auf Eingaben/Knöpfe)
  $$('.book-row', el).forEach((row) => row.addEventListener('click', (ev) => {
    if (ev.target.closest('.book-edit') || row.dataset.swiped) { delete row.dataset.swiped; return; }
    bookOpen = bookOpen === row.dataset.uid ? null : row.dataset.uid;
    renderBook();
  }));
  $$('.book-edit [data-f]', el).forEach((inp) => inp.addEventListener('change', async () => {
    const e = find(inp.closest('[data-edit]').dataset.edit), f = inp.dataset.f;
    const num = ['ek', 'vorschlag', 'vk', 'versand'].includes(f);
    e[f] = num ? parseNum(inp.value) : inp.value.trim();
    if (f === 'vorschlag') e.manual = true;
    if (['note', 'lang', 'name', 'nr'].includes(f)) { if (f === 'name' || f === 'nr') { e.cardId = null; e.match = ''; } await suggestPrice(e); }
    saveBook(); renderBook();
  }));
  $$('[data-photo]', el).forEach((inp) => inp.addEventListener('change', async (ev) => {
    const f = ev.target.files && ev.target.files[0];
    if (!f) return;
    const e = find(inp.dataset.photo); e.photo = await photoToData(f); saveBook(); renderBook(); toast('Foto gespeichert');
  }));
  $$('[data-recalc]', el).forEach((b) => b.addEventListener('click', async () => {
    const e = find(b.dataset.recalc); b.textContent = 'Berechne …';
    const keep = e.manual;
    await suggestPrice(e);
    if (keep && confirm(`Neuer Vorschlag ${eur(e.autoVorschlag)} übernehmen? (Bisher von dir: ${eur(e.vorschlag)})`)) { e.vorschlag = e.autoVorschlag; e.manual = false; }
    saveBook(); renderBook();
  }));
  $$('[data-close]', el).forEach((b) => b.addEventListener('click', () => { bookOpen = null; renderBook(); }));
  $$('[data-opensell]', el).forEach((b) => b.addEventListener('click', () => openSheet(el, b.dataset.opensell)));
  $$('[data-unsell]', el).forEach((b) => b.addEventListener('click', () => { const e = find(b.dataset.unsell); e.vk = null; e.vkDatum = null; saveBook(); renderBook(); }));
  $$('[data-sell]', el).forEach((b) => b.addEventListener('click', () => {
    const u = b.dataset.sell, e = find(u);
    const vk = parseNum($(`[data-vk="${u}"]`, el).value);
    if (vk == null || vk < 0) return toast('Verkaufspreis eintragen');
    e.vk = vk; e.versand = parseNum($(`[data-vs="${u}"]`, el).value) ?? 0; e.vkPlattform = $(`[data-vp="${u}"]`, el).value; e.vkDatum = Date.now();
    saveBook();
    const g = bookProfit(e).gewinn;
    if (navigator.vibrate) navigator.vibrate(40);
    bookOpen = null;
    renderBook();
    toast(`Verkauft · Gewinn ${g > 0 ? '+' : ''}${eur(g)}`);
  }));
  // Wischen: rechts = verkauft (öffnet Bearbeitung mit Verkaufsfeld), links = löschen
  $$('.book-row', el).forEach((row) => {
    let sx = 0, sy = 0, dx = 0, active = false, decided = false;
    row.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1 || e.target.closest('input,select,button,.book-edit')) return;
      sx = e.touches[0].clientX; sy = e.touches[0].clientY; dx = 0; active = true; decided = false;
      row.style.transition = 'none';
    }, { passive: true });
    row.addEventListener('touchmove', (e) => {
      if (!active) return;
      const mx = e.touches[0].clientX - sx, my = e.touches[0].clientY - sy;
      if (!decided) {
        if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
        decided = true;
        if (Math.abs(my) > Math.abs(mx) || (mx > 0 && sx < 30)) { active = false; return; }
      }
      dx = mx;
      if (dx > 0 && row.classList.contains('sold')) dx = Math.min(dx, 30);
      e.preventDefault();
      row.style.transform = `translateX(${dx}px)`;
      row.classList.toggle('arm-sell', dx > row.offsetWidth * 0.3);
      row.classList.toggle('arm-del', dx < -row.offsetWidth * 0.35);
    }, { passive: false });
    const end = () => {
      if (!active) return;
      active = false;
      if (Math.abs(dx) > 10) row.dataset.swiped = '1';
      row.style.transition = 'transform .22s ease';
      const u = row.dataset.uid;
      if (dx < -row.offsetWidth * 0.35) {
        row.style.transform = 'translateX(-110%)';
        setTimeout(() => {
          const i = book.findIndex((x) => x.uid === u);
          const [e] = book.splice(i, 1);
          saveBook(); renderBook();
          toastUndo('Gelöscht', () => { book.splice(i, 0, e); saveBook(); renderBook(); });
        }, 220);
      } else {
        row.style.transform = '';
        if (dx > row.offsetWidth * 0.3 && !row.classList.contains('sold')) { bookOpen = u; renderBook(); openSheet($('#book'), u); }
      }
      row.classList.remove('arm-sell', 'arm-del');
    };
    row.addEventListener('touchend', end);
    row.addEventListener('touchcancel', end);
  });
}
function openSheet(el, u) {
  const s = $(`[data-sheet="${u}"]`, el);
  if (s) { s.classList.remove('hidden'); const i = s.querySelector('input'); if (i) i.focus(); }
}

// ---------- Bestand ----------
function itemValue(it) {
  const cm = it.pricing?.cardmarket;
  let ref = null, src = null, date = null;
  const tpm = it.marketField === 'tcgp' && it.pricing ? tpMarket(it.pricing) : null;
  const ksrc = it.marketField === 'kombi' ? marketSources(it.pricing, it.gradedApi?.data, it.offers || [], false) : null;
  if (ksrc && ksrc.length) {
    ref = combine(ksrc);
    src = `Kombinierter Marktwert (${ksrc.length} Quellen)`;
    date = ksrc.map((x) => new Date(x.date).getTime()).filter(Number.isFinite).sort((a, b) => b - a)[0];
  } else if (tpm && fx) {
    ref = tpm.usd * fx.rate;
    src = `TCGplayer Marktpreis ${tpVariant(tpm.variant)}`;
    date = tpm.updated;
  } else if (cm && cm[it.marketField] != null) {
    ref = cm[it.marketField];
    src = cmLabel(it.marketField);
    date = cm.updated;
  } else if (it.manualRef) {
    ref = it.manualRef.value;
    src = it.manualRef.label;
    date = it.manualRef.date;
  }
  const value = marktwert({ referenz: ref, cf: effectiveCF(it.gradedApi?.data).cf, lf: settings.lf, zustand: it.zustand, sprache: it.sprache, refZustand: it.refZustand, refSprache: it.refSprache });
  return { value, ref, src, date };
}

let invFilter = 'all';
const WO = { laden: 'Laden', ebay: 'eBay', cardmarket: 'Cardmarket', privat: 'Privat', messe: 'Messe/Börse', sonst: 'Sonstiges' };
const ART = { sofort: 'Sofort-Kaufen', auktion: 'Auktion', vorschlag: 'Preisvorschlag', festpreis: 'Festpreis', tausch: 'Tausch' };
const BEW = { '': '–', positiv: 'positiv', neutral: 'neutral', negativ: 'negativ' };
const optsOf = (map, val, empty) => (empty ? `<option value="">${empty}</option>` : '') + Object.entries(map).map(([k, l]) => `<option value="${k}" ${k === val ? 'selected' : ''}>${l}</option>`).join('');
const dealText = (wo, art, partner, bew, abg) => [wo ? WO[wo] : '', art ? ART[art] : '', partner ? 'mit ' + partner : '', bew ? `Bewertung ${BEW[bew]}${abg ? ', abgegeben' : ''}` : ''].filter(Boolean).join(' · ');
const flipCfg = () => ({ start: 0, undercut: 0.05, marge: 0.2, ...(settings.flip || {}) });
const itemPlatform = (it) => settings.platforms[it.vkPlattform] || settings.platforms[settings.platform] || settings.platforms.cardmarket;

function renderInventory() {
  const el = $('#inv');
  const cfg = flipCfg();
  const items = inventory.slice().sort((a, b) => b.createdAt - a.createdAt);
  const pf = portfolio(items, { start: cfg.start, marktwert: (it) => itemValue(it).value, platform: itemPlatform, erloes: (it) => itemCalc(it).netto });
  const portWert = items.filter((it) => it.status === 'bestand').reduce((a, it) => a + (itemValue(it).value || 0), 0);
  const shown = items.filter((it) => invFilter === 'all' || it.status === invFilter);
  const counts = { all: items.length, bestand: 0, verkauft: 0, beobachtet: 0 };
  for (const it of items) counts[it.status] = (counts[it.status] || 0) + 1;
  const cls = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
  const sign = (v) => (v > 0 ? '+' : '');
  const lastSync = refreshState.last;
  el.innerHTML = `
    <div class="card">
      <div class="hero">
        <div class="lbl">Portfolio-Wert · ${counts.bestand || 0} Karten im Bestand</div>
        <div class="val">${eur(portWert)}</div>
        <div class="sub"><b class="${cls(portWert - pf.gebunden)}">${sign(portWert - pf.gebunden)}${eur(portWert - pf.gebunden)}</b>${pf.gebunden > 0 ? ` (<span class="${cls(portWert - pf.gebunden)}">${sign(portWert - pf.gebunden)}${pct((portWert - pf.gebunden) / pf.gebunden)}</span>)` : ''} gegenüber Einkauf ${eur(pf.gebunden)}</div>
      </div>
      ${cfg.start > 0 ? `<div class="kasse-line"><span>Kasse (Pott)</span><b class="${pf.kasse < 0 ? 'neg' : ''}">${eur(pf.kasse)}</b><span class="meta">Gesamtvermögen ${eur(pf.gesamt)}${pf.rendite != null ? ` · ${sign(pf.rendite)}${pct(pf.rendite)} seit Start` : ''}</span></div>` : ''}
      ${cfg.start > 0 && pf.kasse < 0 ? '<div class="warn">Du hast mehr eingekauft, als im Pott war. Startkapital erhöhen oder erst verkaufen.</div>' : ''}
      <div class="sum">
        <div><span>Marktwert (Cardmarket & Co.)</span><b>${eur(portWert)}</b></div>
        <div><span>Bezahlt (Einkauf)</span><b>${eur(pf.gebunden)}</b></div>
        <div><span>Lagerwert, realistisch verkauft</span><b>${eur(pf.lagerwert)}</b></div>
        <div><span>Unrealisiert</span><b class="${cls(pf.lagerwert - pf.gebunden)}">${sign(pf.lagerwert - pf.gebunden)}${eur(pf.lagerwert - pf.gebunden)}</b></div>
        <div><span>Deckungsbeitrag realisiert</span><b class="${cls(pf.dbSumme)}">${sign(pf.dbSumme)}${eur(pf.dbSumme)}</b></div>
        <div><span>Umsatz · ${pf.anzahlVerkauft} ${pf.anzahlVerkauft === 1 ? 'Verkauf' : 'Verkäufe'}</span><b>${eur(pf.umsatz)}</b></div>
        <div><span>Ø Deckungsbeitrag je Verkauf</span><b class="${cls(pf.dbSchnitt)}">${pf.dbSchnitt != null ? sign(pf.dbSchnitt) + eur(pf.dbSchnitt) : '–'}</b></div>
        <div><span>Ø Rendite · Ø Haltedauer</span><b>${pf.roiSchnitt != null ? pct(pf.roiSchnitt) : '–'} · ${pf.halteSchnitt != null ? Math.round(pf.halteSchnitt) + ' Tage' : '–'}</b></div>
      </div>
      ${pf.lagerOhnePreis ? `<p class="hint">${pf.lagerOhnePreis} Karte(n) ohne Marktpreis sind im Lagerwert nicht enthalten.</p>` : ''}
      <details class="more">
        <summary>Pott und Kalkulation einstellen</summary>
        <div class="grid2" style="margin-top:8px">
          <label>Startkapital €<input id="flip-start" inputmode="decimal" value="${n2(cfg.start)}" /></label>
          <label>Unter Markt anbieten %<input id="flip-under" inputmode="decimal" value="${fmt1(cfg.undercut * 100)}" /></label>
          <label>Wunschmarge auf Einkauf %<input id="flip-marge" inputmode="decimal" value="${fmt1(cfg.marge * 100)}" /></label>
        </div>
        <p class="hint">Kasse = Startkapital − alle Einkäufe + Verkaufserlöse nach Gebühr und Versand. Lagerwert = was beim Verkauf zum Angebotspreis nach Gebühr und Versand übrig bliebe. Angebotspreis = Marktwert deiner Karte minus „unter Markt“, damit sie zügig verkauft wird.</p>
      </details>
      <div class="grid2" style="margin-top:10px">
        <button id="inv-add" class="primary">Karte hinzufügen</button>
        <button id="inv-refresh">Preise aktualisieren</button>
      </div>
      <button id="inv-csv" class="block ghost">CSV-Export</button>
      <p class="date">Letzter Preisabgleich: ${lastSync ? dt(lastSync) : 'noch nie'}. Preise älter als 24 h werden automatisch aktualisiert, solange die App offen ist.</p>
    </div>
    <div class="seg" id="inv-filter">
      ${[['all', 'Alle'], ['bestand', 'Im Bestand'], ['verkauft', 'Verkauft'], ['beobachtet', 'Beobachtet']].map(([k, l]) => `<button data-f="${k}" class="${invFilter === k ? 'on' : ''}">${l} <span class="meta">${counts[k] || 0}</span></button>`).join('')}
    </div>
    <div class="card">
      ${shown.length ? shown.map(invItemHtml).join('') : '<p class="empty">Noch keine Karten. „Karte hinzufügen“ öffnet die Suche; in der Bewertung unten „Zur Sammlung hinzufügen“.</p>'}
    </div>`;
  const numIn = (sel, apply) => $(sel).addEventListener('change', (e) => {
    const v = parseNum(e.target.value);
    if (v == null || v < 0) return toast('Ungültige Zahl');
    settings.flip = { ...flipCfg() };
    apply(v);
    saveSettings();
    renderInventory();
  });
  numIn('#flip-start', (v) => (settings.flip.start = v));
  numIn('#flip-under', (v) => (settings.flip.undercut = Math.min(v, 90) / 100));
  numIn('#flip-marge', (v) => (settings.flip.marge = v / 100));
  $('#inv-add').addEventListener('click', () => show('search'));
  $('#inv-refresh').addEventListener('click', () => refreshPrices(true));
  $('#inv-csv').addEventListener('click', exportCsv);
  $$('#inv-filter button').forEach((b) => b.addEventListener('click', () => { invFilter = b.dataset.f; renderInventory(); }));
  $$('.inv-item', el).forEach(bindInvItem);
  enableSwipe(el, '.inv-item', (u) => {
    const it = inventory.find((x) => x.uid === u);
    if (!it) return null;
    db.del('inventory', u);
    inventory = inventory.filter((x) => x.uid !== u);
    renderInventory();
    return async () => { await db.put('inventory', it); inventory = await db.all('inventory'); renderInventory(); };
  }, 'Aus der Sammlung gelöscht');
  if (openItemUid) {
    const d = $(`.inv-item[data-uid="${openItemUid}"] details`, el);
    if (d) { d.open = true; d.scrollIntoView({ block: 'center' }); }
    openItemUid = null;
  }
}
let openItemUid = null;

function itemCalc(it) {
  const cfg = flipCfg();
  const p = itemPlatform(it);
  return kalkulation({ einkauf: it.einkauf, markt: itemValue(it).value, provision: p.provision, versand: p.versand, undercut: cfg.undercut, marge: cfg.marge });
}

function invItemHtml(it) {
  const v = itemValue(it);
  const p = itemPlatform(it);
  const statusLbl = { bestand: 'im Bestand', beobachtet: 'beobachtet', verkauft: 'verkauft' }[it.status];
  const cls = (x) => (x > 0 ? 'pos' : x < 0 ? 'neg' : '');
  const sign = (x) => (x > 0 ? '+' : '');
  let right = '', calc = '';
  if (it.status === 'verkauft' && Number.isFinite(it.verkauf)) {
    const r = verkaufsErgebnis({ verkauf: it.verkauf, provision: p.provision, versand: Number.isFinite(it.vkVersand) ? it.vkVersand : p.versand, einkauf: it.einkauf });
    const days = it.vkDatum && it.datum ? Math.max(0, Math.round((new Date(it.vkDatum) - new Date(it.datum)) / 86400000)) : null;
    right = `<span class="meta">Deckungsbeitrag</span><b class="${cls(r.db)}">${sign(r.db)}${eur(r.db)}</b>${r.roi != null ? `<span class="meta ${cls(r.db)}">${sign(r.roi)}${pct(r.roi)}</span>` : ''}`;
    calc = `<div class="meta">Verkauft für <b>${eur(it.verkauf)}</b> über ${esc(p.label)}${it.vkArt ? ' (' + ART[it.vkArt] + ')' : ''}${it.vkDatum ? ' am ' + new Date(it.vkDatum).toLocaleDateString('de-DE') : ''} · netto ${eur(r.netto)}${days != null ? ` · ${days} Tage gehalten` : ''}</div>${it.vkPartner || it.vkBew ? `<div class="date">${esc(dealText('', '', it.vkPartner, it.vkBew, it.vkAbg))}</div>` : ''}`;
  } else if (it.status === 'bestand') {
    const k = itemCalc(it);
    right = k.angebot != null
      ? `<span class="meta">Anbieten für</span><b>${eur(k.angebot)}</b><span class="meta ${cls(k.db)}">DB ${sign(k.db)}${eur(k.db)}</span>`
      : `<span class="meta">kein Marktpreis</span>`;
    calc = `<div class="calc-chips">
        <span>Einkauf <b>${eur(it.einkauf)}</b></span>
        <span>Markt <b>${eur(v.value)}</b></span>
        <span>Mindestpreis <b>${eur(k.breakEven)}</b></span>
        <span>Ziel ${fmt1(flipCfg().marge * 100)} % <b>${eur(k.zielpreis)}</b></span>
      </div>
      ${k.verlust ? `<div class="warn">Der Markt (${eur(v.value)}) liegt unter deinem Mindestpreis von ${eur(k.breakEven)}. Verkauf zum Marktpreis wäre ein Verlust.</div>`
        : k.unterZiel ? `<p class="date">Zum Marktpreis verkaufbar, aber unter deiner Wunschmarge.</p>` : ''}`;
  } else {
    right = `<span class="meta">Marktwert</span><b>${eur(v.value)}</b>`;
  }
  return `
  <div class="inv-item" data-uid="${it.uid}">
    ${img(it.image, 'low', it.name)}
    <div>
      <div class="n">${esc(it.name)}</div>
      <div class="meta">${esc(it.setName)} · Nr. ${esc(it.localId)}${it.official ? '/' + it.official : ''} · ${esc(LANG_LABELS[it.sprache] || it.sprache)} · ${esc(it.zustand)}</div>
      <div class="meta"><span class="tag">${statusLbl}</span> gekauft ${it.datum ? new Date(it.datum).toLocaleDateString('de-DE') : '–'}${it.einkauf != null ? ' für ' + eur(it.einkauf) : ''}${it.grading ? ` <span class="grade-badge">PSA ~${it.grading.overall}</span>` : ''}</div>
      ${it.ekWo || it.ekArt || it.ekPartner || it.ekBew ? `<div class="date">Einkauf: ${esc(dealText(it.ekWo, it.ekArt, it.ekPartner, it.ekBew, it.ekAbg))}</div>` : ''}
      ${calc}
      ${v.ref != null ? `<div class="date">${esc(v.src)}: ${eur(v.ref)} · Stand ${dt(v.date)}</div>` : '<div class="date">Kein Marktpreis vorhanden</div>'}
      ${it.notiz ? `<div class="meta">${esc(it.notiz)}</div>` : ''}
    </div>
    <div class="right">${right}</div>
    <div class="item-actions">${it.status === 'bestand' ? '<button class="small" data-act="sold">Verkauft</button><button class="small ghost" data-act="open">Neu bewerten</button>' : ''}<button class="x trash" data-act="trash" aria-label="Löschen">${TRASH}</button></div>
    <details>
      <summary>Bearbeiten</summary>
      <div class="grid2">
        <label>Status<select data-k="status">
          <option value="bestand" ${it.status === 'bestand' ? 'selected' : ''}>im Bestand</option>
          <option value="verkauft" ${it.status === 'verkauft' ? 'selected' : ''}>verkauft</option>
          <option value="beobachtet" ${it.status === 'beobachtet' ? 'selected' : ''}>beobachtet</option>
        </select></label>
        <label>Zustand<select data-k="zustand">${Object.keys(settings.cf).map((k) => `<option ${k === it.zustand ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
        <label>Sprache<select data-k="sprache">${Object.keys(settings.lf).map((k) => `<option value="${k}" ${k === it.sprache ? 'selected' : ''}>${LANG_LABELS[k] || k}</option>`).join('')}</select></label>
      </div>
      <h3>Einkauf</h3>
      <div class="grid2">
        <label>Bezahlt €<input data-k="einkauf" inputmode="decimal" value="${it.einkauf ?? ''}" /></label>
        <label>Kaufdatum<input data-k="datum" type="date" value="${esc(it.datum)}" /></label>
        <label>Gekauft über<select data-k="ekWo">${optsOf(WO, it.ekWo, 'wählen')}</select></label>
        <label>Art<select data-k="ekArt">${optsOf(ART, it.ekArt, 'wählen')}</select></label>
        <label>Verkäufer<input data-k="ekPartner" value="${esc(it.ekPartner || '')}" placeholder="Name / Shop" /></label>
        <label>Bewertung<select data-k="ekBew">${optsOf(BEW, it.ekBew || '')}</select></label>
      </div>
      <label class="check-inline"><input type="checkbox" data-k="ekAbg" ${it.ekAbg ? 'checked' : ''}/> Bewertung abgegeben</label>
      <h3>Verkauf</h3>
      <div class="grid2">
        <label>Verkaufspreis €<input data-k="verkauf" inputmode="decimal" value="${it.verkauf ?? ''}" /></label>
        <label>Verkaufsdatum<input data-k="vkDatum" type="date" value="${esc(it.vkDatum || '')}" /></label>
        <label>Verkauf über<select data-k="vkPlattform">${Object.entries(settings.platforms).map(([k, x]) => `<option value="${k}" ${k === (it.vkPlattform || settings.platform) ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select></label>
        <label>Versand tatsächlich €<input data-k="vkVersand" inputmode="decimal" placeholder="${n2(p.versand)}" value="${it.vkVersand ?? ''}" /></label>
        <label>Art<select data-k="vkArt">${optsOf(ART, it.vkArt, 'wählen')}</select></label>
        <label>Käufer<input data-k="vkPartner" value="${esc(it.vkPartner || '')}" placeholder="Name" /></label>
        <label>Bewertung<select data-k="vkBew">${optsOf(BEW, it.vkBew || '')}</select></label>
      </div>
      <label class="check-inline"><input type="checkbox" data-k="vkAbg" ${it.vkAbg ? 'checked' : ''}/> Bewertung abgegeben</label>
      <label>Notiz<input data-k="notiz" value="${esc(it.notiz)}" /></label>
      ${it.grading ? gradingDocHtml(it.grading) : ''}
      <div class="grid2" style="margin-top:8px">
        <button data-act="open">Neu bewerten</button>
        <button data-act="del" class="danger">Löschen</button>
      </div>
    </details>
  </div>`;
}

function gradingDocHtml(g) {
  const sevL = { 1: 'leicht', 2: 'mittel', 3: 'stark' };
  const catL = { surface: 'Oberfläche', corner: 'Ecke', edge: 'Kante' };
  const per = { front: 0, back: 0 };
  const list = (g.defects || []).map((d) => {
    per[d.side] = (per[d.side] || 0) + 1;
    return `<li>${d.side === 'back' ? 'H' : 'V'}${per[d.side]} · ${catL[d.cat] || d.cat} · ${esc(d.kind)} · ${sevL[d.sev]}${d.note ? ' – ' + esc(d.note) : ''}</li>`;
  }).join('');
  const ph = g.annotated || g.photos || {};
  return `<div class="g-doc">
    <h3>Grading-Dokumentation</h3>
    <div class="meta"><span class="grade-badge">PSA ~${g.overall} geschätzt</span> ${dt(g.date)}</div>
    <div class="meta">Zentrierung max. ${g.cap} · Ecken ${fmt1(g.sub.corners)} · Kanten ${fmt1(g.sub.edges)} · Oberfläche ${fmt1(g.sub.surface)}</div>
    ${ph.front || ph.back ? `<div class="g-photos">${ph.front ? `<img src="${ph.front}" alt="vorne">` : ''}${ph.back ? `<img src="${ph.back}" alt="hinten">` : ''}</div>` : ''}
    ${checklistLines(g.checklist).length ? `<ul class="g-list">${checklistLines(g.checklist).map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}
    ${g.aiSummary ? `<p class="meta">KI: ${esc(g.aiSummary)}</p>` : ''}
    ${list ? `<ul class="g-list">${list}</ul>` : '<p class="hint">Keine Mängel markiert.</p>'}
    <button data-act="report" class="block">Bericht teilen</button>
  </div>`;
}

function bindInvItem(row) {
  const it = inventory.find((x) => x.uid === row.dataset.uid);
  $$('[data-k]', row).forEach((inp) =>
    inp.addEventListener('change', async () => {
      const k = inp.dataset.k;
      it[k] = ['einkauf', 'verkauf', 'vkVersand'].includes(k) ? parseNum(inp.value) : inp.type === 'checkbox' ? inp.checked : inp.value;
      if (k === 'verkauf' && it[k] != null && it.status !== 'verkauft') {
        it.status = 'verkauft';
        it.vkDatum = it.vkDatum || today();
      }
      await db.put('inventory', it);
      openItemUid = it.uid;
      renderInventory();
    }),
  );
  const sold = $('[data-act=sold]', row);
  if (sold) sold.addEventListener('click', async () => {
    const k = itemCalc(it);
    const p = itemPlatform(it);
    const input = prompt(`Verkaufspreis in € (${p.label})`, k.angebot != null ? String(k.angebot).replace('.', ',') : '');
    if (input == null) return;
    const v = parseNum(input);
    if (v == null || v <= 0) return toast('Ungültiger Preis');
    it.status = 'verkauft';
    it.verkauf = v;
    it.vkDatum = today();
    it.vkPlattform = it.vkPlattform || settings.platform;
    await db.put('inventory', it);
    const r = verkaufsErgebnis({ verkauf: v, provision: p.provision, versand: p.versand, einkauf: it.einkauf });
    toast(`Verkauft – Deckungsbeitrag ${r.db >= 0 ? '+' : ''}${eur(r.db)}. Art, Käufer und Bewertung unten ergänzen.`);
    openItemUid = it.uid;
    renderInventory();
  });
  const delWithUndo = async () => {
    await db.del('inventory', it.uid);
    inventory = inventory.filter((x) => x.uid !== it.uid);
    renderInventory();
    toastUndo(`„${it.name}“ gelöscht`, async () => { await db.put('inventory', it); inventory = await db.all('inventory'); renderInventory(); });
  };
  $('[data-act=del]', row)?.addEventListener('click', delWithUndo);
  $('[data-act=trash]', row)?.addEventListener('click', delWithUndo);
  $$('[data-act=open]', row).forEach((b) => b.addEventListener('click', () => openCard(it.lang, it.id)));
  const rep = $('[data-act=report]', row);
  if (rep) rep.addEventListener('click', () => shareReport({ name: it.name, sub: `${it.setName} · Nr. ${it.localId}${it.official ? '/' + it.official : ''}` }, it.grading, toast));
}

function exportCsv() {
  const cols = ['tcgdex_id', 'name', 'set', 'nummer', 'sprache', 'zustand', 'status', 'einkauf_eur', 'kaufdatum', 'marktwert_eur', 'angebotspreis_eur', 'mindestpreis_eur', 'zielpreis_eur',
    'verkauf_eur', 'verkaufsdatum', 'plattform', 'netto_erloes_eur', 'deckungsbeitrag_eur', 'rendite_prozent', 'preisquelle', 'preisstand', 'notiz',
    'einkauf_wo', 'einkauf_art', 'verkaeufer', 'einkauf_bewertung', 'verkauf_art', 'kaeufer', 'verkauf_bewertung'];
  const q = (v) => {
    const s = v == null ? '' : String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const num = (v) => (v == null || !Number.isFinite(v) ? '' : v.toFixed(2).replace('.', ','));
  const iso = (v) => (v ? new Date(v).toISOString() : '');
  const rows = inventory.map((it) => {
    const v = itemValue(it);
    const p = itemPlatform(it);
    const k = itemCalc(it);
    const r = it.status === 'verkauft' && Number.isFinite(it.verkauf) ? verkaufsErgebnis({ verkauf: it.verkauf, provision: p.provision, versand: Number.isFinite(it.vkVersand) ? it.vkVersand : p.versand, einkauf: it.einkauf }) : null;
    return [it.id, it.name, it.setName, `${it.localId}${it.official ? '/' + it.official : ''}`, it.sprache, it.zustand, it.status,
      num(it.einkauf), it.datum, num(v.value), num(k.angebot), num(k.breakEven), num(k.zielpreis),
      num(it.verkauf), it.vkDatum || '', it.status === 'verkauft' ? p.label : '', num(r?.netto), num(r?.db), r?.roi != null ? (r.roi * 100).toFixed(1).replace('.', ',') : '',
      v.src || '', iso(v.date), it.notiz,
      it.ekWo ? WO[it.ekWo] : '', it.ekArt ? ART[it.ekArt] : '', it.ekPartner || '', it.ekBew || '', it.vkArt ? ART[it.vkArt] : '', it.vkPartner || '', it.vkBew || ''];
  });
  const csv = '﻿' + [cols, ...rows].map((r) => r.map(q).join(';')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `sammlung-${today()}.csv`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// ---------- Preise täglich nachziehen ----------
const refreshState = { running: false, last: null };
async function refreshPrices(force = false) {
  if (refreshState.running || !navigator.onLine) {
    if (force && !navigator.onLine) toast('Offline – kein Abgleich möglich');
    return;
  }
  refreshState.running = true;
  let n = 0, fail = 0;
  try {
    const due = inventory.filter((it) => it.status !== 'verkauft' && (force || !it.fetchedAt || Date.now() - it.fetchedAt > 24 * 3600 * 1000));
    for (const it of due) {
      try {
        const r = await getCard(it.lang, it.id);
        if (r.data && !r.fromCache) {
          it.pricing = extractPricing(r.data);
          it.fetchedAt = r.fetchedAt;
          if (!it.image && r.data.image) it.image = r.data.image;
          await db.put('inventory', it);
          n++;
        } else fail++;
      } catch {
        fail++;
      }
    }
    refreshState.last = Date.now();
    await kvSet('lastRefresh', refreshState.last);
    if (force) toast(`${n} Preis(e) aktualisiert${fail ? `, ${fail} fehlgeschlagen` : ''}`);
  } finally {
    refreshState.running = false;
    if ($('#view-inv').classList.contains('active')) renderInventory();
  }
}

// ---------- Einstellungen ----------
function renderSettings() {
  const el = $('#settings');
  const cfIn = Object.entries(settings.cf).map(([k, v]) => `<label>${k}<input data-cf="${k}" inputmode="decimal" value="${String(v).replace('.', ',')}" /></label>`).join('');
  const lfIn = Object.entries(settings.lf).map(([k, v]) => `<label>${k}<input data-lf="${k}" inputmode="decimal" value="${String(v).replace('.', ',')}" /></label>`).join('');
  const pIn = Object.entries(settings.platforms).map(([k, p]) => `
    <h3>${esc(p.label)}</h3>
    <div class="grid2">
      <label>Provision %<input data-pf="${k}" data-f="provision" inputmode="decimal" value="${n2(p.provision * 100)}" /></label>
      <label>Versand €<input data-pf="${k}" data-f="versand" inputmode="decimal" value="${n2(p.versand)}" /></label>
    </div>`).join('');
  el.innerHTML = `
    <div class="card">
      <h2>Zustandsfaktoren (CF)</h2>
      <div class="factors">${cfIn}</div>
      <h2 style="margin-top:14px">Sprachfaktoren (LF)</h2>
      <div class="factors">${lfIn}</div>
      <p class="hint" id="gegenprobe"></p>
    </div>
    <div class="card">
      <h2>Verkaufskosten</h2>
      ${pIn}
      <label class="row" style="margin-top:10px"><span>Netto-Minimum €</span><input id="set-min" inputmode="decimal" value="${n2(settings.minNetto)}" /></label>
    </div>
    <div class="card">
      <h2>Darstellung</h2>
      <div class="seg" id="set-theme">
        ${[['light', 'Hell'], ['dark', 'Dunkel'], ['system', 'Wie System']].map(([k, l]) => `<button data-t="${k}" class="${(settings.theme || 'light') === k ? 'on' : ''}">${l}</button>`).join('')}
      </div>
    </div>
    <div class="card">
      <h2>KI-Grading (Claude)</h2>
      <label>Anthropic-API-Schlüssel<input id="set-ai" type="password" autocomplete="off" placeholder="sk-ant-…" value="${esc(settings.aiKey || '')}" /></label>
      <p class="hint">Für die KI-Analyse im Grading. Schlüssel unter <a href="https://platform.claude.com" target="_blank" rel="noopener">platform.claude.com</a> erstellen (kostenpflichtig, etwa 3–5 Cent pro Foto). Er bleibt auf diesem Gerät und geht nur über deinen eigenen Worker an Anthropic. Alternativ als Worker-Secret ANTHROPIC_API_KEY.</p>
    </div>
    <div class="card">
      <h2>Graded-Preise (Pokemon Price Tracker)</h2>
      <label>API-Schlüssel<input id="set-ppt" type="password" autocomplete="off" placeholder="pokeprice_…" value="${esc(settings.pptKey || '')}" /></label>
      <p class="hint">Kostenlos: 100 Credits pro Tag. Schlüssel holen unter <a href="https://www.pokemonpricetracker.com/api" target="_blank" rel="noopener">pokemonpricetracker.com/api</a>. Er bleibt auf diesem Gerät und geht nur über deinen eigenen Cloudflare-Worker an Pokemon Price Tracker.</p>
      <label class="row" style="margin-top:8px"><span>Zustände</span>
        <select id="set-cf-market"><option value="1" ${settings.cfFromMarket !== false ? 'selected' : ''}>Echte Zustandspreise nutzen, wenn vorhanden</option><option value="0" ${settings.cfFromMarket === false ? 'selected' : ''}>Immer meine Zustandsfaktoren</option></select>
      </label>
      <label class="row" style="margin-top:8px"><span>Automatisch</span>
        <select id="set-ppt-auto"><option value="1" ${settings.pptAuto !== false ? 'selected' : ''}>Beim Öffnen einer Karte laden</option><option value="0" ${settings.pptAuto === false ? 'selected' : ''}>Nur per Knopf</option></select>
      </label>
      <p class="hint">Ein Abruf liefert aktuelle TCGplayer-Preise je Zustand und die Graded-Preise zusammen (3 Credits, 24 h zwischengespeichert). Gratis reicht das für etwa 30 Karten am Tag.${settings.pptRemaining ? ' Heute noch ' + settings.pptRemaining.n + ' Credits.' : ''}</p>
      <button id="set-ppt-test" class="block">Verbindung testen</button>
      <p id="set-ppt-result" class="status"></p>
    </div>
    <div class="card">
      <h2>Datenquelle</h2>
      <label>USD→EUR-Kurs manuell (leer = EZB-Kurs automatisch)<input id="set-fx" inputmode="decimal" placeholder="${fx && !fx.manual ? 'aktuell ' + fx.rate.toLocaleString('de-DE', { maximumFractionDigits: 4 }) : 'z. B. 0,91'}" value="${settings.usdEurManual ? String(settings.usdEurManual).replace('.', ',') : ''}" /></label>
      <label>API-Basis-URL (TCGdex oder eigener Proxy)<input id="set-api" value="${esc(settings.apiBase)}" /></label>
      <p class="hint">TCGdex erlaubt CORS (Access-Control-Allow-Origin: *), ein Proxy ist nicht nötig. Für den Notfall liegt in <code>proxy/</code> ein Cloudflare Worker.</p>
      <div class="grid2" style="margin-top:8px">
        <button id="set-probe">Sprachen neu prüfen</button>
        <button id="set-cache">API-Cache leeren</button>
      </div>
    </div>
    <div class="card">
      <h2>Sicherung</h2>
      <div class="grid2">
        <button id="set-export">Backup (JSON)</button>
        <label class="btn">Backup laden<input id="set-import" type="file" accept="application/json" hidden /></label>
      </div>
      <button id="set-reset" class="block danger">Faktoren &amp; Kosten auf Standard</button>
    </div>`;
  const loc = (v) => v.toLocaleString('de-DE', { maximumFractionDigits: 4 });
  const gp = () => {
    const f = (settings.cf.LP / settings.cf.NM) * (settings.lf.de / settings.lf.en);
    $('#gegenprobe').textContent = `Gegenprobe Englisch NM → Deutsch LP: ${loc(settings.cf.LP / settings.cf.NM)} × ${loc(settings.lf.de / settings.lf.en)} = ${loc(f)} (Standard: 0,45 × 0,63 = 0,28)`;
  };
  gp();
  const onNum = (inp, apply) =>
    inp.addEventListener('change', () => {
      const v = parseNum(inp.value);
      if (v == null || v < 0) { toast('Ungültige Zahl'); return renderSettings(); }
      apply(v);
      saveSettings();
      gp();
      toast('Gespeichert');
    });
  $$('[data-cf]', el).forEach((i) => onNum(i, (v) => { if (v > 0) settings.cf[i.dataset.cf] = v; }));
  $$('[data-lf]', el).forEach((i) => onNum(i, (v) => { if (v > 0) settings.lf[i.dataset.lf] = v; }));
  $$('[data-pf]', el).forEach((i) => onNum(i, (v) => {
    const p = settings.platforms[i.dataset.pf];
    if (i.dataset.f === 'provision') p.provision = Math.min(v, 100) / 100;
    else p.versand = v;
  }));
  onNum($('#set-min'), (v) => (settings.minNetto = v));
  $$('#set-theme button').forEach((b) => b.addEventListener('click', () => {
    settings.theme = b.dataset.t;
    saveSettings();
    applyTheme();
    $$('#set-theme button').forEach((x) => x.classList.toggle('on', x === b));
  }));
  $('#set-ai').addEventListener('change', (e) => {
    settings.aiKey = e.target.value.trim();
    saveSettings();
    toast(settings.aiKey ? 'KI-Schlüssel gespeichert' : 'KI-Schlüssel entfernt');
  });
  $('#set-ppt').addEventListener('change', (e) => {
    settings.pptKey = e.target.value.trim();
    saveSettings();
    toast(settings.pptKey ? 'Schlüssel gespeichert' : 'Schlüssel entfernt');
  });
  $('#set-cf-market').addEventListener('change', (e) => {
    settings.cfFromMarket = e.target.value === '1';
    saveSettings();
  });
  $('#set-ppt-auto').addEventListener('change', (e) => {
    settings.pptAuto = e.target.value === '1';
    saveSettings();
  });
  $('#set-ppt-test').addEventListener('click', async () => {
    const out = $('#set-ppt-result');
    settings.pptKey = $('#set-ppt').value.trim();
    saveSettings();
    out.className = 'status';
    out.textContent = 'Teste …';
    try {
      const res = await fetch('/api/graded-test', { headers: settings.pptKey ? { 'X-PPT-Key': settings.pptKey } : {} });
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('json')) throw new Error('Nur in der Online-Version (Cloudflare) testbar.');
      if (res.status === 501) throw new Error('Kein Schlüssel eingetragen.');
      if (res.status === 401) throw new Error('Schlüssel ungültig.');
      if (!res.ok) throw new Error('Fehler ' + res.status);
      out.className = 'status ok';
      out.textContent = 'Verbindung steht. Graded-Preise sind jetzt in der Bewertung verfügbar.';
    } catch (err) {
      out.className = 'status err';
      out.textContent = err.message;
    }
  });
  $('#set-fx').addEventListener('change', async (e) => {
    const v = parseNum(e.target.value);
    settings.usdEurManual = v && v > 0 ? v : null;
    saveSettings();
    await loadFx();
    toast(settings.usdEurManual ? 'Manueller Kurs gespeichert' : 'EZB-Kurs wird verwendet');
  });
  $('#set-api').addEventListener('change', (e) => {
    settings.apiBase = e.target.value.trim() || DEFAULT_SETTINGS.apiBase;
    setApiBase(settings.apiBase);
    saveSettings();
    toast('API-URL gespeichert');
  });
  $('#set-probe').addEventListener('click', async () => {
    await kvSet('langProbe', null);
    langAvail = await probeLanguages();
    renderLangSelect();
    const off = Object.entries(langAvail).filter(([, ok]) => !ok).map(([k]) => k);
    toast(off.length ? `Nicht verfügbar: ${off.join(', ')}` : 'Alle Sprachen verfügbar');
  });
  $('#set-cache').addEventListener('click', async () => {
    const all = await db.all('cache');
    await Promise.all(all.map((r) => db.del('cache', r.url)));
    toast(`${all.length} Cache-Einträge gelöscht`);
  });
  $('#set-export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), settings, inventory }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `kartenwert-backup-${today()}.json`;
    a.click();
  });
  $('#set-import').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (data.settings) { await kvSet('settings', data.settings); await loadSettings(); }
      for (const it of data.inventory || []) await db.put('inventory', it);
      inventory = await db.all('inventory');
      toast(`Backup geladen (${(data.inventory || []).length} Karten)`);
      renderSettings();
    } catch {
      toast('Backup ungültig');
    }
  });
  $('#set-reset').addEventListener('click', () => {
    if (!confirm('Faktoren und Kosten auf Standard zurücksetzen?')) return;
    settings.cf = { ...DEFAULT_SETTINGS.cf };
    settings.lf = { ...DEFAULT_SETTINGS.lf };
    settings.platforms = structuredClone(DEFAULT_SETTINGS.platforms);
    settings.minNetto = DEFAULT_SETTINGS.minNetto;
    saveSettings();
    renderSettings();
  });
}

async function loadFx() {
  if (settings.usdEurManual) fx = { rate: settings.usdEurManual, manual: true };
  else fx = await usdEur().catch(() => null);
  if (cur) {
    renderMarket();
    updateCalc();
  }
}

// ---------- Grading ----------
let grading = null;
function initGrading() {
  grading = createGrading({
    root: $('#grade'),
    getCard: () => (cur ? cur.card : null),
    getAiKey: () => settings.aiKey || '',
    toast,
    onApply: (res) => {
      cur.grading = res;
      toast(`Grading übernommen: PSA ~${res.overall}`);
      show('eval');
      renderGradingSum();
      renderGraded();
      renderGradedApi();
    },
  });
}

// ---------- Start ----------
(async function init() {
  updateNet();
  await loadSettings();
  renderLangSelect();
  initGrading();
  loadCart();
  loadBook();
  loadScan();
  try { inventory = await db.all('inventory'); } catch { inventory = []; }
  refreshState.last = await kvGet('lastRefresh', null);
  probeLanguages()
    .then((r) => {
      langAvail = r;
      if (langAvail[settings.searchLang] === false) settings.searchLang = 'de';
      renderLangSelect();
    })
    .catch(() => {});
  getSets(settings.searchLang).catch(() => {});
  loadFx();
  refreshPrices(false);
  setInterval(() => refreshPrices(false), 30 * 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshPrices(false); });
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
