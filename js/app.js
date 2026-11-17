import {
  DEFAULT_SETTINGS, CONDITION_LABELS, LANG_LABELS, LADDER,
  stats, evaluate, marktwert, parsePrices, parseCardNumber, preiseJeZustand,
} from './calc.js';
import {
  ALL_LANGS, setApiBase, probeLanguages, searchByName, searchByNumber,
  getCard, extractPricing, englishName, setIdOf, getSets, usdEur, searchSmart,
} from './api.js';
import { db, kvGet, kvSet } from './db.js';

// ---------- Helfer ----------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtEur = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const eur = (v) => (v == null || !Number.isFinite(v) ? '–' : fmtEur.format(v));
const n2 = (v) => (v == null || !Number.isFinite(v) ? '–' : v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
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
}
const saveSettings = () => kvSet('settings', settings);

// ---------- Navigation ----------
const scroller = $('main');
const scrollMem = {};
let curView = 'search';
function show(view, { push = true, keepScroll = true } = {}) {
  if (view !== curView) scrollMem[curView] = scroller.scrollTop;
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + view));
  $$('.tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
  if (view === 'inv') renderInventory();
  if (view === 'settings') renderSettings();
  const changed = view !== curView;
  curView = view;
  if (changed) scroller.scrollTop = keepScroll ? scrollMem[view] || 0 : 0;
  if (push && changed) history.pushState({ view }, '', '#' + view);
}
$$('.tabbar button').forEach((b) => b.addEventListener('click', () => show(b.dataset.view)));
addEventListener('popstate', (e) => show((e.state && e.state.view) || 'search', { push: false }));
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

$('#cam-input').addEventListener('change', (e) => {
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
});

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
    const parsed = parseCardNumber(text);
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
    };
    cur.ebayQuery = `${card.name} ${card.localId}/${card.set?.cardCount?.official ?? ''}`.trim();
    renderEval();
    if (!fx || fx.stale) loadFx();
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

/** Sinnvolle Standard-Referenz: Angebote > cardmarket.trend > cardmarket.avg30 > TCGplayer market. */
function autoRef(pricing, offers) {
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
  ['median', 'Median der Angebote'],
  ['mean', 'Durchschnitt der Angebote'],
  ['min', 'Minimum der Angebote'],
  ['trend', 'cardmarket.trend'],
  ['avg7', 'cardmarket.avg7'],
  ['avg30', 'cardmarket.avg30'],
  ['tcgp', 'TCGplayer market (in EUR)'],
  ['custom', 'Eigener Wert'],
];

function renderEval() {
  const c = cur.card;
  const cm = cur.pricing.cardmarket;
  const tp = cur.pricing.tcgplayer;
  const condOpts = (sel) => Object.keys(settings.cf).map((k) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${k} – ${CONDITION_LABELS[k] || k}</option>`).join('');
  const langOpts = (sel) => Object.keys(settings.lf).map((k) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${LANG_LABELS[k] || k}</option>`).join('');

  $('#eval').innerHTML = `
    <button class="ghost small back" id="back-btn">‹ Zurück</button>
    <div class="card">
      <div class="head">
        ${img(c.image, 'high', c.name)}
        <div>
          <p class="title">${esc(c.name)}</p>
          <div class="meta">${esc(c.set?.name || '')} · Nr. ${esc(c.localId)}${c.set?.cardCount?.official ? '/' + c.set.cardCount.official : ''}</div>
          <div class="meta">${esc(c.rarity || '')}</div>
          <div class="meta">TCGdex-ID: ${esc(c.id)} · Sprache: ${esc(cur.lang)}</div>
          <p class="date">Abgerufen: ${dt(cur.fetchedAt)}${cur.fromCache ? ' <span class="tag">aus Cache' + (cur.stale ? ', offline' : '') + '</span>' : ''}</p>
          <button class="small" id="reload-card">Preise neu laden</button>
        </div>
      </div>
    </div>

    <div class="card">
      <h2>Marktpreise</h2>
      <div id="market"></div>
    </div>

    <div class="card">
      <h2>Marktplätze</h2>
      <div class="links" id="links"></div>
    </div>

    <div class="card">
      <h2>Angebote</h2>
      <div class="grid2">
        <select id="offer-src">
          <option value="cm">Cardmarket</option>
          <option value="ebay">eBay verkauft</option>
        </select>
        <div class="inline">
          <input id="offer-one" inputmode="decimal" placeholder="Preis €" />
          <button id="offer-add" class="primary">+</button>
        </div>
      </div>
      <textarea id="offer-paste" placeholder="Oder mehrere Preise einfügen, z. B.&#10;12,50 €  13,00 €  14,99 €"></textarea>
      <button id="offer-paste-btn" class="block">Eingefügte Preise übernehmen</button>
      <div class="seg" id="offer-filter">
        <button data-f="all">Alle</button>
        <button data-f="cm">Cardmarket</button>
        <button data-f="ebay">eBay</button>
      </div>
      <div class="offers" id="offers"></div>
      <div class="stats" id="offer-stats"></div>
      <button id="offer-clear" class="small ghost danger" style="margin-top:6px">Alle löschen</button>
    </div>

    <div class="card">
      <h2>Bewertung</h2>
      <div id="calc-out" class="calc"></div>
      <h3>Referenzpreis</h3>
      <label class="row"><span>Referenz</span>
        <select id="ref-type">${REF_OPTIONS.map(([v, l]) => `<option value="${v}" ${v === cur.refType ? 'selected' : ''}>${l}</option>`).join('')}</select>
      </label>
      <label class="row" id="row-holo"><span>Variante</span>
        <select id="ref-holo"><option value="0">normal (trend/avg7/avg30)</option><option value="1">holo ("trend-holo" …)</option></select>
      </label>
      <label class="row" id="row-custom"><span>Eigener Wert</span><input id="ref-custom" inputmode="decimal" placeholder="€" value="${esc(cur.custom)}" /></label>
      <div class="grid2">
        <label>Zustand der Referenz<select id="ref-cond">${condOpts(cur.refCond)}</select></label>
        <label>Sprache Referenz<select id="ref-lang">${langOpts(cur.refLang)}</select></label>
      </div>
      <h3>Meine Karte</h3>
      <div class="grid2">
        <label>Mein Zustand<select id="my-cond">${condOpts(cur.myCond)}</select></label>
        <label>Meine Sprache<select id="my-lang">${langOpts(cur.myLang)}</select></label>
      </div>
      ${cur.myLangUnmapped ? `<p class="hint">Für „${esc(cur.lang)}“ gibt es keinen Sprachfaktor – bitte die Sprache von Hand wählen oder in den Einstellungen ergänzen.</p>` : ''}
      <label class="row"><span>Verkauf über</span>
        <select id="platform">${Object.entries(settings.platforms).map(([k, p]) => `<option value="${k}" ${k === cur.platform ? 'selected' : ''}>${esc(p.label)} (${n2(p.provision * 100)} % · Versand ${eur(p.versand)})</option>`).join('')}</select>
      </label>
    </div>

    <div class="card">
      <h2>Zum Bestand hinzufügen</h2>
      <div class="grid2">
        <label>Einkaufspreis €<input id="inv-buy" inputmode="decimal" placeholder="z. B. 20" /></label>
        <label>Datum<input id="inv-date" type="date" value="${today()}" /></label>
      </div>
      <label class="row"><span>Status</span>
        <select id="inv-status"><option value="bestand">im Bestand</option><option value="beobachtet">beobachtet</option><option value="verkauft">verkauft</option></select>
      </label>
      <label class="row"><span>Verkaufspreis</span><input id="inv-sell" inputmode="decimal" placeholder="nur bei verkauft" /></label>
      <label class="row"><span>Notiz</span><input id="inv-note" placeholder="optional" /></label>
      <button id="inv-save" class="primary block">Speichern</button>
    </div>`;

  $('#reload-card').addEventListener('click', () => openCard(cur.lang, cur.card.id));
  $('#back-btn').addEventListener('click', () => (history.length > 1 ? history.back() : show('search')));
  $('#ref-holo').value = cur.useHolo ? '1' : '0';
  const bind = (sel, key, conv = (v) => v) =>
    $(sel).addEventListener('input', (e) => {
      cur[key] = conv(e.target.value);
      if (key === 'refType') cur.refAuto = false;
      if (key === 'myCond' || key === 'refCond') renderMarket();
      if (key === 'platform') {
        settings.platform = cur.platform;
        saveSettings();
      }
      updateCalc();
    });
  bind('#ref-type', 'refType');
  bind('#ref-holo', 'useHolo', (v) => v === '1');
  bind('#ref-custom', 'custom');
  bind('#ref-cond', 'refCond');
  bind('#ref-lang', 'refLang');
  bind('#my-cond', 'myCond');
  bind('#my-lang', 'myLang');
  bind('#platform', 'platform');

  const addOffers = (vals) => {
    const src = $('#offer-src').value;
    for (const v of vals) cur.offers.push({ id: uid(), v, on: true, src });
    if (cur.refAuto && cur.refType !== 'median') {
      cur.refType = 'median';
      $('#ref-type').value = 'median';
    }
    renderOffers();
  };
  $('#offer-add').addEventListener('click', () => {
    const v = parseNum($('#offer-one').value);
    if (v == null || v <= 0) return toast('Bitte einen Preis eingeben');
    addOffers([v]);
    $('#offer-one').value = '';
    $('#offer-one').focus();
  });
  $('#offer-one').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#offer-add').click();
  });
  $('#offer-paste-btn').addEventListener('click', () => {
    const vals = parsePrices($('#offer-paste').value);
    if (!vals.length) return toast('Keine Preise im Text gefunden');
    addOffers(vals);
    $('#offer-paste').value = '';
    toast(`${vals.length} Preis(e) übernommen`);
  });
  $$('#offer-filter button').forEach((b) =>
    b.addEventListener('click', () => {
      cur.offerFilter = b.dataset.f;
      renderOffers();
    }),
  );
  $('#offer-clear').addEventListener('click', () => {
    if (cur.offers.length && confirm('Alle Angebote löschen?')) {
      cur.offers = [];
      renderOffers();
    }
  });
  $('#inv-save').addEventListener('click', saveToInventory);

  renderMarket();
  renderLinks();
  renderOffers();
}

/** Marktpreise mit Zustandsleiste: alle Werte über CF[Zustand] / CF[Referenzzustand] umgerechnet. */
function renderMarket() {
  const el = $('#market');
  if (!el) return;
  const cm = cur.pricing.cardmarket;
  const tp = cur.pricing.tcgplayer;
  const k = settings.cf[cur.myCond] / settings.cf[cur.refCond];
  const adj = (v) => (v == null ? null : v * k);
  const tabs = `<div class="seg cond-seg">${Object.keys(settings.cf).map((z) => `<button data-z="${z}" class="${z === cur.myCond ? 'on' : ''}">${z}</button>`).join('')}</div>`;
  const note = cur.myCond === cur.refCond
    ? `<p class="date">Zustand ${cur.refCond} – ${CONDITION_LABELS[cur.refCond]} (Basis der Marktdaten)</p>`
    : `<p class="date">Umgerechnet auf ${cur.myCond} – ${CONDITION_LABELS[cur.myCond]}: Basis ${cur.refCond} × ${k.toLocaleString('de-DE', { maximumFractionDigits: 3 })} (Zustandsfaktoren)</p>`;
  const cmRow = (label, f) => `<tr><td>${label}</td><td>${eur(adj(cm[f]))}</td><td>${eur(adj(cm[f + '-holo']))}</td></tr>`;
  const cmHtml = cm
    ? `<table>
        <tr><th>Cardmarket</th><th>normal</th><th>holo</th></tr>
        ${cmRow('trend', 'trend')}${cmRow('avg', 'avg')}${cmRow('low', 'low')}
        ${cmRow('avg1', 'avg1')}${cmRow('avg7', 'avg7')}${cmRow('avg30', 'avg30')}
      </table>
      <p class="date">Preisstand Cardmarket: <b>${dt(cm.updated)}</b></p>`
    : '<p class="hint">TCGdex hat für diese Karte keine Cardmarket-Daten. Preise über die Links unten prüfen und als Angebote eintragen.</p>';
  const money = (usdVal) => (usdVal == null ? '–' : fx ? eur(usdVal * fx.rate * k) : (usdVal * k).toLocaleString('de-DE', { style: 'currency', currency: 'USD' }));
  const tpHtml = tp && tp.variants.length
    ? `<table>
        <tr><th>TCGplayer${fx ? '' : ' (USD)'}</th><th>low</th><th>mid</th><th>market</th><th>high</th></tr>
        ${tp.variants.map((v) => `<tr><td>${esc(v.key)}</td><td>${money(v.fields.lowPrice)}</td><td>${money(v.fields.midPrice)}</td><td>${money(v.fields.marketPrice)}</td><td>${money(v.fields.highPrice)}</td></tr>`).join('')}
      </table>
      <p class="date">Preisstand TCGplayer: <b>${dt(tp.updated)}</b> · ${fx ? `umgerechnet zum ${fx.manual ? 'manuellen Kurs' : (fx.source || 'EZB') + '-Kurs vom ' + new Date(fx.date).toLocaleDateString('de-DE')} (1 USD = ${fx.rate.toLocaleString('de-DE', { maximumFractionDigits: 4 })} EUR)` : 'Wechselkurs gerade nicht abrufbar, Werte in USD. Kurs lässt sich in den Einstellungen eintragen'} · US-Markt</p>`
    : '';
  el.innerHTML = tabs + note + cmHtml + tpHtml;
  $$('.cond-seg button', el).forEach((b) =>
    b.addEventListener('click', () => {
      cur.myCond = b.dataset.z;
      const sel = $('#my-cond');
      if (sel) sel.value = cur.myCond;
      renderMarket();
      updateCalc();
    }),
  );
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
  updateCalc();
}

/** Referenzpreis bestimmen. Rückgabe { value, label, date, isApi, field } oder { error }. */
function resolveRef() {
  const t = cur.refType;
  if (['median', 'mean', 'min'].includes(t)) {
    const s = stats(activeOffers().map((o) => o.v));
    if (!s.count) return { error: 'Keine angehakten Angebote – Preise eintragen oder andere Referenz wählen.' };
    const lbl = { median: 'Median', mean: 'Durchschnitt', min: 'Minimum' }[t];
    return { value: s[t], label: `${lbl} aus ${s.count} Angebot(en)`, date: Date.now(), dateLabel: 'eingetragen' };
  }
  if (t === 'custom') {
    const v = parseNum(cur.custom);
    if (v == null || v <= 0) return { error: 'Eigenen Referenzwert eingeben.' };
    return { value: v, label: 'Eigener Wert', date: Date.now(), dateLabel: 'eingegeben' };
  }
  if (t === 'tcgp') {
    const m = tpMarket(cur.pricing);
    if (!m) return { error: 'Keine TCGplayer-Daten für diese Karte.' };
    if (!fx) return { error: 'Wechselkurs nicht verfügbar. Kurs in den Einstellungen eintragen.' };
    return { value: m.usd * fx.rate, label: `TCGplayer ${m.variant} market (${m.usd.toLocaleString('de-DE', { style: 'currency', currency: 'USD' })})`, date: m.updated, dateLabel: 'Preisstand', isApi: true, field: 'tcgp' };
  }
  const cm = cur.pricing.cardmarket;
  const field = cur.useHolo ? `${t}-holo` : t;
  if (!cm) return { error: 'Keine Cardmarket-Daten für diese Karte. Referenz „TCGplayer market“ wählen oder Angebote eintragen.' };
  const v = cm[field];
  if (v == null) return { error: `cardmarket["${field}"] fehlt für diese Karte.` };
  return { value: v, label: `cardmarket["${field}"]`, date: cm.updated, dateLabel: 'Preisstand', isApi: true, field };
}

function updateCalc() {
  if (!cur) return;
  $('#row-holo').classList.toggle('hidden', !['trend', 'avg7', 'avg30'].includes(cur.refType));
  $('#row-custom').classList.toggle('hidden', cur.refType !== 'custom');

  const s = stats(activeOffers().map((o) => o.v));
  const refKey = { median: 'median', mean: 'mean', min: 'min' }[cur.refType];
  $('#offer-stats').innerHTML = [
    ['count', 'Anzahl'], ['min', 'Min'], ['median', 'Median'], ['mean', 'Ø'], ['max', 'Max'],
  ].map(([k, l]) => `<div class="${k === refKey ? 'ref' : ''}"><b>${k === 'count' ? s.count : eur(s[k])}</b><span>${l}</span></div>`).join('');

  const out = $('#calc-out');
  const ref = resolveRef();
  if (ref.error) {
    out.innerHTML = `<p class="err">${esc(ref.error)}</p>`;
    cur.last = null;
    return;
  }
  const pf = settings.platforms[cur.platform];
  const r = evaluate({
    referenz: ref.value, cf: settings.cf, lf: settings.lf,
    meinZustand: cur.myCond, refZustand: cur.refCond,
    meineSprache: cur.myLang, refSprache: cur.refLang,
    provision: pf.provision, versand: pf.versand, minNetto: settings.minNetto,
  });
  cur.last = { ref, r };
  const f2 = (v) => v.toLocaleString('de-DE', { maximumFractionDigits: 3 });
  const l80 = r.ladder.find((l) => l.highlight);
  out.innerHTML = `
    <div class="hero">
      <div class="lbl">Maximales Gebot bei 80 %</div>
      <div class="val">${eur(l80.maxGebot)}</div>
      <div class="sub">Netto <b>${eur(r.netto)}</b> · Gewinn <b class="${l80.gewinn >= 0 ? 'pos' : 'neg'}">${eur(l80.gewinn)}</b> · Rendite <b>${pct(l80.rendite)}</b></div>
    </div>
    <h3>Herleitung</h3>
    <div class="line"><span>Referenz (${esc(ref.label)})</span><b>${eur(ref.value)}</b></div>
    <p class="date">${ref.dateLabel}: ${dt(ref.date)}</p>
    <div class="line"><span>Zustandsfaktor = ${f2(settings.cf[cur.myCond])} / ${f2(settings.cf[cur.refCond])} (${cur.myCond}/${cur.refCond})</span><b>${f2(r.zf)}</b></div>
    <div class="line"><span>Sprachfaktor = ${f2(settings.lf[cur.myLang])} / ${f2(settings.lf[cur.refLang])} (${cur.myLang}/${cur.refLang})</span><b>${f2(r.sf)}</b></div>
    <div class="line"><span>Gesamtfaktor (multipliziert)</span><b>${f2(r.faktor)}</b></div>
    <div class="line"><span>Brutto = Referenz × Faktoren</span><b>${eur(r.brutto)}</b></div>
    <div class="line"><span>Netto = Brutto × (1 − ${n2(pf.provision * 100)} %) − ${eur(pf.versand)}</span><b class="big">${eur(r.netto)}</b></div>
    <h3>Ankaufsleiter</h3>
    <table class="ladder">
      <tr><th>Stufe</th><th>Max. Gebot</th><th>Gewinn</th><th>Rendite</th></tr>
      ${r.ladder.map((l) => `<tr class="${l.highlight ? 'hl' : ''}"><td>${Math.round(l.p * 100)} %</td><td>${eur(l.maxGebot)}</td><td>${eur(l.gewinn)}</td><td>${pct(l.rendite)}</td></tr>`).join('')}
    </table>
    <h3>Preis je Zustand (${esc(LANG_LABELS[cur.myLang] || cur.myLang)})</h3>
    <table class="ladder cond-table">
      <tr><th>Zustand</th><th>Marktwert</th><th>Netto</th><th>Max. Gebot 80 %</th></tr>
      ${preiseJeZustand({ referenz: ref.value, cf: settings.cf, refZustand: cur.refCond, sprachFaktor: r.sf, provision: pf.provision, versand: pf.versand })
        .map((z) => `<tr data-cond="${z.zustand}" class="${z.zustand === cur.myCond ? 'hl' : ''}"><td>${z.zustand} <span class="meta">${CONDITION_LABELS[z.zustand] || ''}</span></td><td>${eur(z.brutto)}</td><td>${eur(z.netto)}</td><td>${eur(z.maxGebot80)}</td></tr>`).join('')}
    </table>
    <p class="date">Aus der Referenz (${cur.refCond}) über deine Zustandsfaktoren abgeleitet. Zeile antippen, um den Zustand deiner Karte zu wählen.</p>
    ${r.netto <= 0 ? '<div class="warn">Netto ist null oder negativ. Bei diesen Kosten lohnt sich kein Ankauf.</div>' : ''}
    ${r.unterMindest ? `<div class="warn">Netto unter ${eur(settings.minNetto)}: Der Flip trägt sich einzeln nicht, er lohnt sich nur im Sammelversand.</div>` : ''}`;
  const buy = $('#inv-buy');
  if (buy && !buy.value) buy.placeholder = `z. B. ${n2(r.ladder[1].maxGebot)} (80 %)`;
  $$('.cond-table tr[data-cond]', out).forEach((tr) =>
    tr.addEventListener('click', () => {
      cur.myCond = tr.dataset.cond;
      $('#my-cond').value = cur.myCond;
      renderMarket();
      updateCalc();
    }),
  );
}

async function saveToInventory() {
  const c = cur.card;
  const ref = cur.last?.ref;
  const item = {
    uid: uid(),
    id: c.id,
    lang: cur.lang,
    name: c.name,
    setName: c.set?.name || '',
    setId: c.set?.id || setIdOf(c),
    localId: c.localId,
    official: c.set?.cardCount?.official ?? null,
    image: c.image || null,
    sprache: cur.myLang,
    zustand: cur.myCond,
    einkauf: parseNum($('#inv-buy').value),
    datum: $('#inv-date').value || today(),
    status: $('#inv-status').value,
    verkauf: parseNum($('#inv-sell').value),
    notiz: $('#inv-note').value.trim(),
    refSprache: cur.refLang,
    refZustand: cur.refCond,
    // Marktwert-Basis: gewähltes Cardmarket-Feld, sonst trend; manuelle Referenz als Rückfall.
    marketField: ref?.isApi ? ref.field : cur.useHolo ? 'trend-holo' : 'trend',
    manualRef: ref && !ref.isApi ? { value: ref.value, date: ref.date, label: ref.label } : null,
    pricing: cur.pricing,
    fetchedAt: cur.fetchedAt,
    createdAt: Date.now(),
  };
  await db.put('inventory', item);
  inventory = await db.all('inventory');
  toast('Im Bestand gespeichert');
}

// ---------- Bestand ----------
function itemValue(it) {
  const cm = it.pricing?.cardmarket;
  let ref = null, src = null, date = null;
  const tpm = it.marketField === 'tcgp' && it.pricing ? tpMarket(it.pricing) : null;
  if (tpm && fx) {
    ref = tpm.usd * fx.rate;
    src = `TCGplayer ${tpm.variant} market`;
    date = tpm.updated;
  } else if (cm && cm[it.marketField] != null) {
    ref = cm[it.marketField];
    src = `cardmarket["${it.marketField}"]`;
    date = cm.updated;
  } else if (it.manualRef) {
    ref = it.manualRef.value;
    src = it.manualRef.label;
    date = it.manualRef.date;
  }
  const value = marktwert({ referenz: ref, cf: settings.cf, lf: settings.lf, zustand: it.zustand, sprache: it.sprache, refZustand: it.refZustand, refSprache: it.refSprache });
  return { value, ref, src, date };
}

let invFilter = 'all';
function renderInventory() {
  const el = $('#inv');
  const items = inventory.slice().sort((a, b) => b.createdAt - a.createdAt);
  let sumBuy = 0, sumVal = 0, realized = 0, missing = 0;
  for (const it of items) {
    if (it.status === 'bestand') {
      sumBuy += it.einkauf || 0;
      const v = itemValue(it).value;
      if (v == null) missing++;
      else sumVal += v;
    }
    if (it.status === 'verkauft' && it.verkauf != null) realized += it.verkauf - (it.einkauf || 0);
  }
  const unreal = sumVal - sumBuy;
  const shown = items.filter((it) => invFilter === 'all' || it.status === invFilter);
  const lastSync = refreshState.last;
  el.innerHTML = `
    <div class="card">
      <div class="hero">
        <div class="lbl">Marktwert Bestand</div>
        <div class="val">${eur(sumVal)}</div>
        <div class="sub"><b class="${unreal >= 0 ? 'pos' : 'neg'}">${unreal >= 0 ? '+' : ''}${eur(unreal)}</b>${sumBuy > 0 ? ` <span class="${unreal >= 0 ? 'pos' : 'neg'}">(${unreal >= 0 ? '+' : ''}${pct(unreal / sumBuy)})</span>` : ''} unrealisiert</div>
      </div>
      <div class="sum">
        <div><span>Summe Einkauf</span><b>${eur(sumBuy)}</b></div>
        <div><span>Marktwert nach Faktoren</span><b>${eur(sumVal)}</b></div>
        <div><span>Unrealisierter Gewinn</span><b class="${unreal > 0 ? 'pos' : unreal < 0 ? 'neg' : ''}">${eur(unreal)}</b></div>
        <div><span>Realisiert (verkauft)</span><b class="${realized > 0 ? 'pos' : realized < 0 ? 'neg' : ''}">${eur(realized)}</b></div>
      </div>
      ${missing ? `<p class="hint">${missing} Karte(n) ohne Preis sind nicht enthalten.</p>` : ''}
      <p class="date">Letzter Preisabgleich: ${lastSync ? dt(lastSync) : 'noch nie'}. Preise älter als 24 h werden automatisch aktualisiert, sobald die App geöffnet ist.</p>
      <div class="grid2" style="margin-top:8px">
        <button id="inv-refresh">Preise aktualisieren</button>
        <button id="inv-csv">CSV-Export</button>
      </div>
    </div>
    <div class="seg" id="inv-filter">
      ${[['all', 'Alle'], ['bestand', 'Bestand'], ['beobachtet', 'Beobachtet'], ['verkauft', 'Verkauft']].map(([k, l]) => `<button data-f="${k}" class="${invFilter === k ? 'on' : ''}">${l}</button>`).join('')}
    </div>
    <div class="card">
      ${shown.length ? shown.map(invItemHtml).join('') : '<p class="empty">Keine Karten.</p>'}
    </div>`;
  $('#inv-refresh').addEventListener('click', () => refreshPrices(true));
  $('#inv-csv').addEventListener('click', exportCsv);
  $$('#inv-filter button').forEach((b) => b.addEventListener('click', () => { invFilter = b.dataset.f; renderInventory(); }));
  $$('.inv-item', el).forEach(bindInvItem);
}

function invItemHtml(it) {
  const v = itemValue(it);
  const statusLbl = { bestand: 'im Bestand', beobachtet: 'beobachtet', verkauft: 'verkauft' }[it.status];
  return `
  <div class="inv-item" data-uid="${it.uid}">
    ${img(it.image, 'low', it.name)}
    <div>
      <div class="n">${esc(it.name)}</div>
      <div class="meta">${esc(it.setName)} · ${esc(it.localId)}${it.official ? '/' + it.official : ''} · ${esc(LANG_LABELS[it.sprache] || it.sprache)} · ${esc(it.zustand)}</div>
      <div class="meta"><span class="tag">${statusLbl}</span> Einkauf ${eur(it.einkauf)} · ${esc(it.datum)}${it.status === 'verkauft' ? ` · Verkauf ${eur(it.verkauf)}` : ''}</div>
      ${v.ref != null ? `<div class="date">Referenz ${eur(v.ref)} · ${esc(v.src)} · Preisstand ${dt(v.date)}</div>` : '<div class="date">Kein Preis vorhanden</div>'}
      <div class="date">Abgerufen ${dt(it.fetchedAt)}</div>
      ${it.notiz ? `<div class="meta">${esc(it.notiz)}</div>` : ''}
    </div>
    <div class="right">
      <b>${eur(v.value)}</b>
      ${v.value != null && it.einkauf != null && it.status !== 'verkauft' ? `<span class="meta ${v.value - it.einkauf >= 0 ? 'pos' : 'neg'}">${v.value - it.einkauf >= 0 ? '+' : ''}${eur(v.value - it.einkauf)}</span>` : ''}
    </div>
    <details>
      <summary>Bearbeiten</summary>
      <div class="grid2">
        <label>Status<select data-k="status">
          <option value="bestand" ${it.status === 'bestand' ? 'selected' : ''}>im Bestand</option>
          <option value="beobachtet" ${it.status === 'beobachtet' ? 'selected' : ''}>beobachtet</option>
          <option value="verkauft" ${it.status === 'verkauft' ? 'selected' : ''}>verkauft</option>
        </select></label>
        <label>Zustand<select data-k="zustand">${Object.keys(settings.cf).map((k) => `<option ${k === it.zustand ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
        <label>Einkauf €<input data-k="einkauf" inputmode="decimal" value="${it.einkauf ?? ''}" /></label>
        <label>Verkauf €<input data-k="verkauf" inputmode="decimal" value="${it.verkauf ?? ''}" /></label>
        <label>Datum<input data-k="datum" type="date" value="${esc(it.datum)}" /></label>
        <label>Sprache<select data-k="sprache">${Object.keys(settings.lf).map((k) => `<option value="${k}" ${k === it.sprache ? 'selected' : ''}>${LANG_LABELS[k] || k}</option>`).join('')}</select></label>
      </div>
      <label>Notiz<input data-k="notiz" value="${esc(it.notiz)}" /></label>
      <div class="grid2" style="margin-top:8px">
        <button data-act="open">Neu bewerten</button>
        <button data-act="del" class="danger">Löschen</button>
      </div>
    </details>
  </div>`;
}

function bindInvItem(row) {
  const it = inventory.find((x) => x.uid === row.dataset.uid);
  $$('[data-k]', row).forEach((inp) =>
    inp.addEventListener('change', async () => {
      const k = inp.dataset.k;
      it[k] = ['einkauf', 'verkauf'].includes(k) ? parseNum(inp.value) : inp.value;
      await db.put('inventory', it);
      renderInventory();
    }),
  );
  $('[data-act=del]', row).addEventListener('click', async () => {
    if (!confirm(`„${it.name}“ löschen?`)) return;
    await db.del('inventory', it.uid);
    inventory = inventory.filter((x) => x.uid !== it.uid);
    renderInventory();
  });
  $('[data-act=open]', row).addEventListener('click', () => openCard(it.lang, it.id));
}

function exportCsv() {
  const cols = ['tcgdex_id', 'name', 'set', 'nummer', 'sprache', 'zustand', 'status', 'einkauf_eur', 'datum', 'verkauf_eur', 'marktwert_eur', 'referenz_eur', 'referenz_quelle', 'preisstand', 'abgerufen', 'notiz', 'bild'];
  const q = (v) => {
    const s = v == null ? '' : String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const num = (v) => (v == null || !Number.isFinite(v) ? '' : v.toFixed(2).replace('.', ','));
  const iso = (v) => (v ? new Date(v).toISOString() : '');
  const rows = inventory.map((it) => {
    const v = itemValue(it);
    return [it.id, it.name, it.setName, `${it.localId}${it.official ? '/' + it.official : ''}`, it.sprache, it.zustand, it.status,
      num(it.einkauf), it.datum, num(it.verkauf), num(v.value), num(v.ref), v.src || '', iso(v.date), iso(it.fetchedAt), it.notiz, it.image ? it.image + '/high.webp' : ''];
  });
  const csv = '﻿' + [cols, ...rows].map((r) => r.map(q).join(';')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `bestand-${today()}.csv`;
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

// ---------- Start ----------
(async function init() {
  updateNet();
  await loadSettings();
  renderLangSelect();
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
