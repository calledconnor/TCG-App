// Grading-Check: Zentrierung messen, Mängel markieren, Note schätzen.
// Orientierung an den veröffentlichten PSA-Richtlinien, kein offizielles Grading.

/** Zentrierungs-Obergrenzen nach PSA (größerer Rand in %, Vorder-/Rückseite). */
export const PSA_CENTERING = [
  { grade: 10, front: 60, back: 75 },
  { grade: 9, front: 65, back: 90 },
  { grade: 8, front: 70, back: 90 },
  { grade: 7, front: 75, back: 90 },
  { grade: 6, front: 85, back: 90 },
  { grade: 5, front: 90, back: 90 },
  { grade: 4, front: 90, back: 90 },
  { grade: 3, front: 90, back: 90 },
];

export const DEFECT_TYPES = {
  surface: { label: 'Oberfläche', kinds: ['Kratzer', 'Delle', 'Druckfleck', 'Knick', 'Fleck', 'Holo-Kratzer'] },
  corner: { label: 'Ecke', kinds: ['Weißung', 'bestoßen', 'abgerundet', 'Knick'] },
  edge: { label: 'Kante', kinds: ['Weißung', 'Chipping', 'Riss', 'Schnittkante uneben'] },
};
export const SEVERITY = { 1: { label: 'leicht', penalty: 0.5 }, 2: { label: 'mittel', penalty: 1.5 }, 3: { label: 'stark', penalty: 3 } };

/** Zentrierung aus Linien (Anteile 0..1): Ränder links/rechts, oben/unten. */
export function centering(lines) {
  const l = lines.innerL - lines.outerL;
  const r = lines.outerR - lines.innerR;
  const t = lines.innerT - lines.outerT;
  const b = lines.outerB - lines.innerB;
  const pct = (a, c) => (a + c > 0 ? (a / (a + c)) * 100 : 50);
  const lr = pct(l, r);
  const tb = pct(t, b);
  const worst = Math.max(lr, 100 - lr, tb, 100 - tb);
  return { lr, tb, worst, valid: l > 0 && r > 0 && t > 0 && b > 0 };
}

/** Höchstnote, die die Zentrierung zulässt. */
export function centeringCap(worstFront, worstBack) {
  for (const row of PSA_CENTERING) {
    if (worstFront <= row.front && (worstBack == null || worstBack <= row.back)) return row.grade;
  }
  return Math.max(1, worstFront <= 95 ? 2 : 1);
}

/** Teilnote aus Mängeln einer Kategorie: 10 minus Abzüge, mindestens 1. */
export function subScore(defects, cat) {
  const p = defects.filter((d) => d.cat === cat).reduce((s, d) => s + (SEVERITY[d.sev]?.penalty || 0), 0);
  return Math.max(1, Math.round((10 - p) * 2) / 2);
}

/** Gesamtschätzung: niedrigste Teilnote (gerundet), gedeckelt durch Zentrierung. */
export function overallGrade({ cap, corners, edges, surface }) {
  const lowest = Math.min(corners, edges, surface);
  return Math.max(1, Math.min(cap, Math.floor(lowest)));
}

// ---------------- UI ----------------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v) => v.toLocaleString('de-DE', { maximumFractionDigits: 1 });

const defaultLines = () => ({ outerL: 0.03, outerR: 0.97, outerT: 0.02, outerB: 0.98, innerL: 0.085, innerR: 0.915, innerT: 0.065, innerB: 0.935 });
const newSide = () => ({ photo: null, img: null, lines: defaultLines(), defects: [] });

export function createGrading({ root, getCard, onApply, toast }) {
  const st = {
    side: 'front',
    mode: 'center',
    filter: false,
    sides: { front: newSide(), back: newSide() },
    overrides: { corners: null, edges: null, surface: null },
    drag: null,
    loupe: null,
    selected: null,
  };

  root.innerHTML = `
    <div class="card" id="g-for"></div>
    <div class="card">
      <div class="seg" id="g-side"><button data-s="front" class="on">Vorderseite</button><button data-s="back">Rückseite</button></div>
      <label class="btn primary block">Foto aufnehmen oder wählen<input id="g-file" type="file" accept="image/*" capture="environment" hidden /></label>
      <p class="hint">Karte gerade, flach und formatfüllend fotografieren, ohne Hülle und bei gleichmäßigem Licht ohne Spiegelung.</p>
      <div id="g-stage-wrap" class="hidden">
        <div class="seg" id="g-mode"><button data-m="center" class="on">Zentrierung</button><button data-m="defect">Mängel markieren</button></div>
        <div class="inline g-tools">
          <button class="small" id="g-filter">Oberflächen-Filter</button>
          <button class="small" id="g-reset-lines">Linien zurücksetzen</button>
        </div>
        <p class="hint" id="g-help"></p>
        <div class="g-stage"><canvas id="g-canvas"></canvas></div>
      </div>
    </div>
    <div class="card" id="g-center"></div>
    <div class="card" id="g-defects"></div>
    <div class="card" id="g-result"></div>`;

  const cv = $('#g-canvas', root);
  let filtered = null; // Canvas mit Kantenfilter

  function side() {
    return st.sides[st.side];
  }

  function renderFor() {
    const c = getCard();
    $('#g-for', root).innerHTML = c
      ? `<div class="meta">Grading-Check für</div><div class="n" style="font-weight:600;font-size:17px">${esc(c.name)}</div><div class="meta">${esc(c.set?.name || '')} · Nr. ${esc(c.localId)}${c.set?.cardCount?.official ? '/' + c.set.cardCount.official : ''}</div>`
      : '<div class="meta">Keine Karte ausgewählt. Der Check funktioniert trotzdem; zum Speichern zuerst eine Karte unter „Suchen“ öffnen.</div>';
  }

  // ---------- Foto ----------
  $('#g-file', root).addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const im = new Image();
    im.onload = () => {
      // auf max. 1600 px verkleinern (Speicher, Tempo)
      const s = Math.min(1, 1600 / Math.max(im.naturalWidth, im.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(im.naturalWidth * s);
      c.height = Math.round(im.naturalHeight * s);
      c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
      const sd = side();
      sd.img = c;
      sd.photo = c.toDataURL('image/jpeg', 0.82);
      sd.lines = autoDetect(c) || defaultLines();
      filtered = null;
      $('#g-stage-wrap', root).classList.remove('hidden');
      draw();
      renderAll();
      URL.revokeObjectURL(im.src);
    };
    im.src = URL.createObjectURL(f);
    e.target.value = '';
  });

  $$('#g-side button', root).forEach((b) =>
    b.addEventListener('click', () => {
      st.side = b.dataset.s;
      $$('#g-side button', root).forEach((x) => x.classList.toggle('on', x === b));
      filtered = null;
      $('#g-stage-wrap', root).classList.toggle('hidden', !side().img);
      draw();
      renderAll();
    }),
  );
  $$('#g-mode button', root).forEach((b) =>
    b.addEventListener('click', () => {
      st.mode = b.dataset.m;
      $$('#g-mode button', root).forEach((x) => x.classList.toggle('on', x === b));
      draw();
      renderHelp();
    }),
  );
  $('#g-filter', root).addEventListener('click', () => {
    st.filter = !st.filter;
    $('#g-filter', root).classList.toggle('primary', st.filter);
    draw();
  });
  $('#g-reset-lines', root).addEventListener('click', () => {
    side().lines = (side().img && autoDetect(side().img)) || defaultLines();
    draw();
    renderAll();
  });

  function renderHelp() {
    $('#g-help', root).textContent =
      st.mode === 'center'
        ? 'Gelbe Linien an die Außenkante der Karte, türkise Linien an den inneren Bildrahmen schieben. Beim Ziehen zeigt eine Lupe die Stelle vergrößert.'
        : 'Auf eine Stelle tippen, um einen Mangel zu markieren. Art und Schwere darunter einstellen. Der Oberflächen-Filter macht Kratzer und Dellen sichtbarer.';
  }

  // ---------- Automatische Erkennung (Startwerte) ----------
  function autoDetect(c) {
    try {
      const w = c.width, h = c.height;
      const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
      const lum = (x, y) => { const i = (y * w + x) * 4; return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; };
      // Spalten-/Zeilen-Gradientenprofile im mittleren Bereich
      const colG = new Float32Array(w), rowG = new Float32Array(h);
      for (let y = Math.floor(h * 0.35); y < h * 0.65; y += 1) for (let x = 1; x < w - 1; x++) colG[x] += Math.abs(lum(x + 1, y) - lum(x - 1, y));
      for (let x = Math.floor(w * 0.35); x < w * 0.65; x += 1) for (let y = 1; y < h - 1; y++) rowG[y] += Math.abs(lum(x, y + 1) - lum(x, y - 1));
      const peak = (arr, from, to) => { let bi = from, bv = -1; for (let i = Math.max(1, from); i < Math.min(arr.length - 1, to); i++) if (arr[i] > bv) { bv = arr[i]; bi = i; } return bi; };
      // erste deutliche Kante von außen nach innen (nicht die stärkste – das wäre oft das Artwork)
      const firstPeak = (arr, from, to, inward) => {
        from = Math.max(1, Math.round(from)); to = Math.min(arr.length - 2, Math.round(to));
        let mx = 0;
        for (let i = from; i <= to; i++) mx = Math.max(mx, arr[i]);
        const thr = mx * 0.45;
        if (inward) { for (let i = from; i <= to; i++) if (arr[i] >= thr && arr[i] >= arr[i - 1] && arr[i] >= arr[i + 1]) return i; }
        else { for (let i = to; i >= from; i--) if (arr[i] >= thr && arr[i] >= arr[i - 1] && arr[i] >= arr[i + 1]) return i; }
        return inward ? from : to;
      };
      // Bild bereits auf die Karte zugeschnitten (Scan, Seitenverhältnis 63:88)? Dann liegt die Außenkante am Bildrand.
      const aspect = w / h;
      const cropped = aspect > 0.69 && aspect < 0.745;
      const oL = cropped ? 0 : firstPeak(colG, 2, w * 0.3, true), oR = cropped ? w - 1 : firstPeak(colG, w * 0.7, w - 3, false);
      const oT = cropped ? 0 : firstPeak(rowG, 2, h * 0.3, true), oB = cropped ? h - 1 : firstPeak(rowG, h * 0.7, h - 3, false);
      const cw = oR - oL, ch = oB - oT;
      if (cw < w * 0.5 || ch < h * 0.5) return null;
      const m = cropped ? 0.008 : 0.02; // Mindestabstand Innenrahmen zur Außenkante
      const iL = firstPeak(colG, oL + cw * m, oL + cw * 0.12, true), iR = firstPeak(colG, oR - cw * 0.12, oR - cw * m, false);
      const iT = firstPeak(rowG, oT + ch * m, oT + ch * 0.1, true), iB = firstPeak(rowG, oB - ch * 0.1, oB - ch * m, false);
      return { outerL: oL / w, outerR: oR / w, outerT: oT / h, outerB: oB / h, innerL: iL / w, innerR: iR / w, innerT: iT / h, innerB: iB / h };
    } catch {
      return null;
    }
  }

  // ---------- Kantenfilter (Sobel) ----------
  function edgeFilter(src) {
    const w = src.width, h = src.height;
    const s = src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h);
    const g = new Float32Array(w * h);
    for (let i = 0, j = 0; i < s.data.length; i += 4, j++) g[j] = 0.299 * s.data[i] + 0.587 * s.data[i + 1] + 0.114 * s.data[i + 2];
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const o = out.getContext('2d').createImageData(w, h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const k = y * w + x;
      const gx = -g[k - w - 1] - 2 * g[k - 1] - g[k + w - 1] + g[k - w + 1] + 2 * g[k + 1] + g[k + w + 1];
      const gy = -g[k - w - 1] - 2 * g[k - w] - g[k - w + 1] + g[k + w - 1] + 2 * g[k + w] + g[k + w + 1];
      const v = Math.min(255, Math.sqrt(gx * gx + gy * gy) * 1.6);
      const i = k * 4;
      o.data[i] = o.data[i + 1] = o.data[i + 2] = 255 - v;
      o.data[i + 3] = 255;
    }
    out.getContext('2d').putImageData(o, 0, 0);
    return out;
  }

  // ---------- Zeichnen ----------
  const LINE_KEYS = ['outerL', 'outerR', 'outerT', 'outerB', 'innerL', 'innerR', 'innerT', 'innerB'];
  function geom() {
    const im = side().img;
    const w = cv.clientWidth || 600;
    const h = Math.round((w * im.height) / im.width);
    return { w, h };
  }
  function draw() {
    const sd = side();
    if (!sd.img) return;
    const { w, h } = geom();
    const dpr = devicePixelRatio || 1;
    cv.width = w * dpr; cv.height = h * dpr; cv.style.height = h + 'px';
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    let src = sd.img;
    if (st.filter) src = filtered || (filtered = edgeFilter(sd.img));
    ctx.drawImage(src, 0, 0, w, h);
    const L = sd.lines;
    if (st.mode === 'center') {
      for (const k of LINE_KEYS) {
        const vertical = /L$|R$/.test(k);
        ctx.strokeStyle = k.startsWith('outer') ? '#ffd60a' : '#22d3ee';
        ctx.lineWidth = st.drag === k ? 3 : 1.5;
        ctx.beginPath();
        if (vertical) { ctx.moveTo(L[k] * w, 0); ctx.lineTo(L[k] * w, h); }
        else { ctx.moveTo(0, L[k] * h); ctx.lineTo(w, L[k] * h); }
        ctx.stroke();
        // Griff
        ctx.fillStyle = ctx.strokeStyle;
        const gx = vertical ? L[k] * w : k.startsWith('outer') ? w * 0.25 : w * 0.75;
        const gy = vertical ? (k.startsWith('outer') ? h * 0.25 : h * 0.75) : L[k] * h;
        ctx.beginPath(); ctx.arc(gx, gy, 7, 0, Math.PI * 2); ctx.fill();
      }
    }
    // Mängel
    sd.defects.forEach((d, i) => {
      const x = d.x * w, y = d.y * h;
      ctx.lineWidth = 2;
      ctx.strokeStyle = d.sev >= 3 ? '#ff453a' : d.sev === 2 ? '#ff9f0a' : '#ffd60a';
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.beginPath(); ctx.arc(x, y, st.selected === d.id ? 15 : 12, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = '600 12px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), x, y);
    });
    // Lupe
    if (st.loupe) {
      const { x, y } = st.loupe;
      const R = Math.min(70, w * 0.18), Z = 4;
      const cx = x < w / 2 ? w - R - 10 : R + 10, cy = R + 10;
      ctx.save();
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();
      const sx = (x / w) * src.width, sy = (y / h) * src.height;
      const sw = ((2 * R) / w) * src.width / Z, sh = ((2 * R) / h) * src.height / Z;
      ctx.drawImage(src, sx - sw / 2, sy - sh / 2, sw, sh, cx - R, cy - R, 2 * R, 2 * R);
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.stroke();
      ctx.restore();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    }
  }
  addEventListener('resize', draw);

  const rel = (e) => {
    const b = cv.getBoundingClientRect();
    return { x: e.clientX - b.left, y: e.clientY - b.top, w: b.width, h: b.height };
  };
  cv.addEventListener('pointerdown', (e) => {
    const sd = side();
    if (!sd.img) return;
    const p = rel(e);
    if (st.mode === 'center') {
      let best = null, bd = 28;
      for (const k of LINE_KEYS) {
        const vertical = /L$|R$/.test(k);
        const dist = vertical ? Math.abs(p.x - sd.lines[k] * p.w) : Math.abs(p.y - sd.lines[k] * p.h);
        if (dist < bd) { bd = dist; best = k; }
      }
      if (best) {
        st.drag = best;
        cv.setPointerCapture(e.pointerId);
        st.loupe = { x: p.x, y: p.y };
        e.preventDefault();
        draw();
      }
    } else {
      // vorhandenen Marker wählen oder neuen setzen
      const hit = sd.defects.find((d) => Math.hypot(d.x * p.w - p.x, d.y * p.h - p.y) < 16);
      if (hit) {
        st.selected = hit.id;
      } else {
        const nx = p.x / p.w, ny = p.y / p.h;
        const nearEdge = Math.min(nx, 1 - nx, ny, 1 - ny) < 0.06;
        const nearCorner = Math.min(nx, 1 - nx) < 0.1 && Math.min(ny, 1 - ny) < 0.08;
        const cat = nearCorner ? 'corner' : nearEdge ? 'edge' : 'surface';
        const d = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), x: nx, y: ny, cat, kind: DEFECT_TYPES[cat].kinds[0], sev: 1, note: '' };
        sd.defects.push(d);
        st.selected = d.id;
      }
      draw();
      renderAll();
    }
  });
  cv.addEventListener('pointermove', (e) => {
    if (!st.drag) return;
    const p = rel(e);
    const k = st.drag;
    const vertical = /L$|R$/.test(k);
    side().lines[k] = Math.min(1, Math.max(0, vertical ? p.x / p.w : p.y / p.h));
    st.loupe = { x: p.x, y: p.y };
    draw();
    renderCenter();
    renderResult();
  });
  const endDrag = () => {
    if (!st.drag) return;
    st.drag = null;
    st.loupe = null;
    draw();
  };
  cv.addEventListener('pointerup', endDrag);
  cv.addEventListener('pointercancel', endDrag);

  // ---------- Auswertung ----------
  function compute() {
    const f = st.sides.front, b = st.sides.back;
    const cf = f.img ? centering(f.lines) : null;
    const cb = b.img ? centering(b.lines) : null;
    const cap = cf ? centeringCap(cf.worst, cb ? cb.worst : null) : 10;
    const all = [...f.defects, ...b.defects];
    const auto = { corners: subScore(all, 'corner'), edges: subScore(all, 'edge'), surface: subScore(all, 'surface') };
    const sub = {
      corners: st.overrides.corners ?? auto.corners,
      edges: st.overrides.edges ?? auto.edges,
      surface: st.overrides.surface ?? auto.surface,
    };
    return { cf, cb, cap, auto, sub, overall: overallGrade({ cap, ...sub }), defects: all.length };
  }

  function renderCenter() {
    const r = compute();
    const row = (title, c, limitKey) => {
      if (!c) return `<div class="line"><span>${title}</span><b>kein Foto</b></div>`;
      const lr = `${fmt(c.lr)} / ${fmt(100 - c.lr)}`;
      const tb = `${fmt(c.tb)} / ${fmt(100 - c.tb)}`;
      return `<div class="line"><span>${title} links/rechts</span><b>${lr}</b></div>
              <div class="line"><span>${title} oben/unten</span><b>${tb}</b></div>
              ${c.valid ? '' : '<p class="err" style="font-size:13px">Linien prüfen: Innenrahmen liegt außerhalb der Außenkante.</p>'}`;
    };
    $('#g-center', root).innerHTML = `
      <h2>Zentrierung</h2>
      ${row('Vorne', r.cf)}
      ${row('Hinten', r.cb)}
      <div class="line"><span>Zentrierung erlaubt höchstens</span><b>PSA ${r.cap}</b></div>
      <p class="date">PSA-Richtlinie (Vorderseite/Rückseite, größerer Rand): PSA 10 ≤ 60/40 und ≤ 75/25 · PSA 9 ≤ 65/35 und ≤ 90/10 · PSA 8 ≤ 70/30 · PSA 7 ≤ 75/25 · PSA 6 ≤ 85/15.</p>`;
  }

  function renderDefects() {
    const sd = side();
    const items = sd.defects
      .map((d, i) => `
      <div class="g-def ${st.selected === d.id ? 'sel' : ''}" data-id="${d.id}">
        <span class="g-num">${i + 1}</span>
        <div class="g-def-body">
          <div class="grid2">
            <select data-k="cat">${Object.entries(DEFECT_TYPES).map(([k, v]) => `<option value="${k}" ${k === d.cat ? 'selected' : ''}>${v.label}</option>`).join('')}</select>
            <select data-k="kind">${DEFECT_TYPES[d.cat].kinds.map((k) => `<option ${k === d.kind ? 'selected' : ''}>${k}</option>`).join('')}</select>
          </div>
          <div class="seg g-sev">${Object.entries(SEVERITY).map(([k, v]) => `<button data-sev="${k}" class="${+k === d.sev ? 'on' : ''}">${v.label}</button>`).join('')}</div>
          <input data-k="note" placeholder="Notiz, z. B. „Kratzer quer durchs Holo“" value="${esc(d.note)}" />
        </div>
        <button class="ghost small danger" data-del>×</button>
      </div>`)
      .join('');
    $('#g-defects', root).innerHTML = `
      <h2>Mängel ${st.side === 'front' ? 'vorne' : 'hinten'} (${sd.defects.length})</h2>
      ${items || '<p class="hint">Noch keine Mängel markiert. Modus „Mängel markieren“ wählen und auf die Stelle im Foto tippen.</p>'}`;
    $$('.g-def', root).forEach((row) => {
      const d = sd.defects.find((x) => x.id === row.dataset.id);
      row.addEventListener('click', (e) => {
        if (e.target.closest('select,input,button')) return;
        st.selected = d.id;
        draw();
        renderDefects();
      });
      $$('[data-k]', row).forEach((inp) =>
        inp.addEventListener('change', () => {
          d[inp.dataset.k] = inp.value;
          if (inp.dataset.k === 'cat') d.kind = DEFECT_TYPES[d.cat].kinds[0];
          draw();
          renderAll();
        }),
      );
      $$('[data-sev]', row).forEach((b) =>
        b.addEventListener('click', () => {
          d.sev = +b.dataset.sev;
          draw();
          renderAll();
        }),
      );
      $('[data-del]', row).addEventListener('click', () => {
        sd.defects = sd.defects.filter((x) => x.id !== d.id);
        draw();
        renderAll();
      });
    });
  }

  function renderResult() {
    const r = compute();
    const sel = (key) => `<select data-ov="${key}"><option value="">Auto (${fmt(r.auto[key])})</option>${[10, 9.5, 9, 8.5, 8, 7, 6, 5, 4, 3, 2, 1].map((g) => `<option value="${g}" ${st.overrides[key] === g ? 'selected' : ''}>${fmt(g)}</option>`).join('')}</select>`;
    $('#g-result', root).innerHTML = `
      <div class="hero">
        <div class="lbl">Geschätzte Note</div>
        <div class="val">PSA ~${r.overall}</div>
        <div class="sub">Zentrierung max. <b>${r.cap}</b> · Ecken <b>${fmt(r.sub.corners)}</b> · Kanten <b>${fmt(r.sub.edges)}</b> · Oberfläche <b>${fmt(r.sub.surface)}</b></div>
      </div>
      <h3>Teilnoten (automatisch aus Mängeln, änderbar)</h3>
      <div class="grid2">
        <label>Ecken${sel('corners')}</label>
        <label>Kanten${sel('edges')}</label>
        <label>Oberfläche${sel('surface')}</label>
      </div>
      <p class="date">Schätzung: niedrigste Teilnote, gedeckelt durch die Zentrierung. Abzug je Mangel: leicht 0,5 · mittel 1,5 · stark 3. Ersetzt kein offizielles Grading; Fotos zeigen feine Kratzer oft nicht.</p>
      <div class="grid2" style="margin-top:10px">
        <button class="primary" id="g-apply">Zur Karte übernehmen</button>
        <button id="g-clear" class="danger">Alles zurücksetzen</button>
      </div>`;
    $$('[data-ov]', root).forEach((s) =>
      s.addEventListener('change', () => {
        st.overrides[s.dataset.ov] = s.value === '' ? null : +s.value;
        renderResult();
      }),
    );
    $('#g-apply', root).addEventListener('click', () => {
      const res = result();
      if (!getCard()) return toast('Zuerst eine Karte unter „Suchen“ öffnen');
      onApply(res);
    });
    $('#g-clear', root).addEventListener('click', () => {
      if (!confirm('Fotos, Linien und Mängel zurücksetzen?')) return;
      st.sides = { front: newSide(), back: newSide() };
      st.overrides = { corners: null, edges: null, surface: null };
      filtered = null;
      $('#g-stage-wrap', root).classList.add('hidden');
      renderAll();
    });
  }

  function renderAll() {
    renderFor();
    renderHelp();
    renderCenter();
    renderDefects();
    renderResult();
  }

  /** Ergebnis-Objekt zum Speichern (Fotos verkleinert, damit IndexedDB klein bleibt). */
  function result() {
    const r = compute();
    const small = (sd) => {
      if (!sd.img) return null;
      const s = Math.min(1, 700 / sd.img.height);
      const c = document.createElement('canvas');
      c.width = Math.round(sd.img.width * s);
      c.height = Math.round(sd.img.height * s);
      c.getContext('2d').drawImage(sd.img, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.75);
    };
    return {
      date: Date.now(),
      overall: r.overall,
      cap: r.cap,
      sub: r.sub,
      centering: {
        front: r.cf && { lr: r.cf.lr, tb: r.cf.tb },
        back: r.cb && { lr: r.cb.lr, tb: r.cb.tb },
      },
      defects: ['front', 'back'].flatMap((s) => st.sides[s].defects.map((d) => ({ ...d, side: s }))),
      photos: { front: small(st.sides.front), back: small(st.sides.back) },
    };
  }

  renderAll();
  return {
    refresh() {
      renderFor();
      draw();
    },
  };
}
