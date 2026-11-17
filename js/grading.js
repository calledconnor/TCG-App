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

/** Homographie (3x3, h33=1), die die 4 Punkte src auf dst abbildet. */
export function homography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  // Gauß-Elimination
  const n = 8;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const h = b.map((v, i) => v / A[i][i]);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}
export function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

/** Perspektivisch entzerren: Ecken (TL, TR, BR, BL in Pixeln) -> gerades Rechteck W×H (Karte 63:88). */
export function warpCard(src, corners, H = 1000, margin = 0) {
  const cw = Math.round((H * 63) / 88), ch = H;
  const mx = Math.round(cw * margin), my = Math.round(ch * margin);
  const W = cw + 2 * mx;
  H = ch + 2 * my;
  const M = homography([[mx, my], [mx + cw, my], [mx + cw, my + ch], [mx, my + ch]], corners); // Ziel -> Quelle
  const sw = src.width, sh = src.height;
  const sd = src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, sw, sh).data;
  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  const octx = out.getContext('2d');
  const od = octx.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [fx, fy] = applyH(M, x + 0.5, y + 0.5);
      const x0 = Math.floor(fx - 0.5), y0 = Math.floor(fy - 0.5);
      const ax = fx - 0.5 - x0, ay = fy - 0.5 - y0;
      const o = (y * W + x) * 4;
      if (x0 < 0 || y0 < 0 || x0 + 1 >= sw || y0 + 1 >= sh) { od.data[o + 3] = 255; continue; }
      const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
      for (let k = 0; k < 3; k++) {
        od.data[o + k] = (sd[i00 + k] * (1 - ax) + sd[i10 + k] * ax) * (1 - ay) + (sd[i01 + k] * (1 - ax) + sd[i11 + k] * ax) * ay;
      }
      od.data[o + 3] = 255;
    }
  }
  octx.putImageData(od, 0, 0);
  return out;
}

/**
 * Kartenecken im Foto finden: Hintergrundfarbe vom Bildrand, Maske, je Seite eine Gerade durch die
 * Randpunkte (mittlere 60 %), Ecken = Schnittpunkte (funktioniert auch mit abgerundeten Ecken).
 * Rückgabe: [[x,y] TL, TR, BR, BL] in Pixeln des Quellbilds oder null.
 */
export function detectCorners(src) {
  try {
    const s = Math.min(1, 360 / Math.max(src.width, src.height));
    const w = Math.round(src.width * s), h = Math.round(src.height * s);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(src, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    // Hintergrund = Median der Randpixel
    const rs = [], gs = [], bs = [];
    const push = (x, y) => { const i = (y * w + x) * 4; rs.push(d[i]); gs.push(d[i + 1]); bs.push(d[i + 2]); };
    for (let x = 0; x < w; x += 2) { push(x, 1); push(x, h - 2); }
    for (let y = 0; y < h; y += 2) { push(1, y); push(w - 2, y); }
    const med = (a) => a.sort((p, q) => p - q)[a.length >> 1];
    const br = med(rs), bg = med(gs), bb = med(bs);
    let mask = new Uint8Array(w * h), cnt = 0;
    for (let i = 0, j = 0; j < w * h; i += 4, j++) {
      const dist = Math.abs(d[i] - br) + Math.abs(d[i + 1] - bg) + Math.abs(d[i + 2] - bb);
      if (dist > 70) { mask[j] = 1; cnt++; }
    }
    if (cnt < w * h * 0.12 || cnt > w * h * 0.97) return null;
    // Erosion (2x) gegen Rauschen
    for (let pass = 0; pass < 2; pass++) {
      const m2 = new Uint8Array(w * h);
      for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
        const j = y * w + x;
        m2[j] = mask[j] && mask[j - 1] && mask[j + 1] && mask[j - w] && mask[j + w] ? 1 : 0;
      }
      mask = m2;
    }
    // grobe Ausdehnung
    let minX = w, maxX = 0, minY = h, maxY = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) {
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    if (maxX - minX < w * 0.3 || maxY - minY < h * 0.3) return null;
    const fit = (pts) => { // x = a*t + b (kleinste Quadrate)
      const n = pts.length; let st = 0, sx = 0, stt = 0, stx = 0;
      for (const [t, x] of pts) { st += t; sx += x; stt += t * t; stx += t * x; }
      const a = (n * stx - st * sx) / (n * stt - st * st || 1);
      return { a, b: (sx - a * st) / n };
    };
    const L = [], R = [], T = [], B = [];
    const y0 = minY + (maxY - minY) * 0.2, y1 = minY + (maxY - minY) * 0.8;
    for (let y = Math.round(y0); y <= y1; y++) {
      let x = 0; while (x < w && !mask[y * w + x]) x++; if (x < w) L.push([y, x]);
      x = w - 1; while (x >= 0 && !mask[y * w + x]) x--; if (x >= 0) R.push([y, x]);
    }
    const x0 = minX + (maxX - minX) * 0.2, x1 = minX + (maxX - minX) * 0.8;
    for (let x = Math.round(x0); x <= x1; x++) {
      let y = 0; while (y < h && !mask[y * w + x]) y++; if (y < h) T.push([x, y]);
      y = h - 1; while (y >= 0 && !mask[y * w + x]) y--; if (y >= 0) B.push([x, y]);
    }
    if (L.length < 5 || R.length < 5 || T.length < 5 || B.length < 5) return null;
    const fl = fit(L), fr = fit(R), ft = fit(T), fb = fit(B);
    // Erosion hat die Kante um ~2 px nach innen verschoben -> ausgleichen
    fl.b -= 2; fr.b += 2; ft.b -= 2; fb.b += 2;
    const cross = (v, hz) => { // v: x = a*y + b ; hz: y = a*x + b
      const x = (v.a * hz.b + v.b) / (1 - v.a * hz.a);
      return [x / s, (hz.a * x + hz.b) / s];
    };
    return [cross(fl, ft), cross(fr, ft), cross(fr, fb), cross(fl, fb)];
  } catch {
    return null;
  }
}

/** Grading-Bericht als PNG (Blob): Karte, Note, Teilnoten, Zentrierung, annotierte Fotos, Mängelliste. */
export async function makeReport(meta, g) {
  const load = (src) => new Promise((res) => { if (!src) return res(null); const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src; });
  const imgs = await Promise.all([load(g.annotated?.front || g.photos?.front), load(g.annotated?.back || g.photos?.back)]);
  const W = 1200, pad = 48, photoH = 640;
  const defects = g.defects || [];
  const H = pad * 2 + 250 + (imgs.some(Boolean) ? photoH + 40 : 0) + 60 + defects.length * 40 + 60;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, W, H);
  x.fillStyle = '#0a0a0a'; x.textBaseline = 'top';
  x.font = '600 22px system-ui, sans-serif'; x.fillStyle = '#71717a';
  x.fillText('Grading-Check · ' + new Date(g.date).toLocaleString('de-DE'), pad, pad);
  x.fillStyle = '#0a0a0a'; x.font = '700 44px system-ui, sans-serif';
  x.fillText(meta.name || 'Karte', pad, pad + 36);
  x.font = '400 24px system-ui, sans-serif'; x.fillStyle = '#71717a';
  x.fillText(meta.sub || '', pad, pad + 92);
  x.fillStyle = '#0a0a0a'; x.font = '700 64px system-ui, sans-serif';
  x.fillText('PSA ~' + g.overall, pad, pad + 132);
  x.font = '400 24px system-ui, sans-serif'; x.fillStyle = '#3f3f46';
  const f1 = (v) => (v == null ? '–' : v.toLocaleString('de-DE', { maximumFractionDigits: 1 }));
  const cen = (c2) => (c2 ? `${f1(c2.lr)}/${f1(100 - c2.lr)} · ${f1(c2.tb)}/${f1(100 - c2.tb)}` : '–');
  x.fillText(`Zentrierung max. ${g.cap}  ·  vorne ${cen(g.centering?.front)}  ·  hinten ${cen(g.centering?.back)}`, pad + 300, pad + 140);
  x.fillText(`Ecken ${f1(g.sub.corners)}  ·  Kanten ${f1(g.sub.edges)}  ·  Oberfläche ${f1(g.sub.surface)}`, pad + 300, pad + 176);
  let y = pad + 250;
  if (imgs.some(Boolean)) {
    let px = pad;
    for (const [i, im] of imgs.entries()) {
      if (!im) continue;
      const w = Math.round((photoH * im.width) / im.height);
      x.drawImage(im, px, y, w, photoH);
      x.font = '500 20px system-ui, sans-serif'; x.fillStyle = '#71717a';
      x.fillText(i === 0 ? 'Vorderseite' : 'Rückseite', px, y + photoH + 8);
      px += w + 32;
    }
    y += photoH + 50;
  }
  x.fillStyle = '#0a0a0a'; x.font = '600 26px system-ui, sans-serif';
  x.fillText(`Mängel (${defects.length})`, pad, y);
  y += 44;
  x.font = '400 22px system-ui, sans-serif';
  const sevL = { 1: 'leicht', 2: 'mittel', 3: 'stark' };
  const catL = { surface: 'Oberfläche', corner: 'Ecke', edge: 'Kante' };
  const per = { front: 0, back: 0 };
  for (const d of defects) {
    per[d.side] = (per[d.side] || 0) + 1;
    x.fillStyle = '#0a0a0a';
    x.fillText(`${d.side === 'back' ? 'H' : 'V'}${per[d.side]}  ${catL[d.cat] || d.cat} · ${d.kind} · ${sevL[d.sev]}${d.note ? ' – ' + d.note : ''}`, pad, y);
    y += 40;
  }
  x.font = '400 18px system-ui, sans-serif'; x.fillStyle = '#a1a1aa';
  x.fillText('Schätzung nach PSA-Zentrierungsrichtlinie, kein offizielles Grading. Erstellt mit Kartenwert.', pad, H - pad);
  return new Promise((res) => c.toBlob(res, 'image/png'));
}

// ---------------- UI ----------------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v) => v.toLocaleString('de-DE', { maximumFractionDigits: 1 });

const defaultLines = () => ({ outerL: 0.03, outerR: 0.97, outerT: 0.02, outerB: 0.98, innerL: 0.085, innerR: 0.915, innerT: 0.065, innerB: 0.935 });
const newSide = () => ({ raw: null, corners: null, straight: false, img: null, lines: defaultLines(), defects: [] });

/** Bericht erzeugen und teilen (Teilen-Menü) bzw. herunterladen. */
export async function shareReport(meta, g, toast) {
  const blob = await makeReport(meta, g);
  const name = `grading-${(meta.name || 'karte').replace(/[^\w-]+/g, '_')}-${new Date(g.date).toISOString().slice(0, 10)}.png`;
  const file = new File([blob], name, { type: 'image/png' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Grading-Bericht' });
      return;
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  toast && toast('Bericht gespeichert');
}

export function createGrading({ root, getCard, onApply, toast }) {
  const st = {
    side: 'front',
    mode: 'straighten',
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
      <div class="grid2" style="margin-top:6px">
        <label class="btn primary">Kamera<input id="g-file" type="file" accept="image/*" capture="environment" hidden /></label>
        <label class="btn">Aus Galerie<input id="g-gal" type="file" accept="image/*" hidden /></label>
      </div>
      <p class="hint">Karte gerade, flach und formatfüllend fotografieren, ohne Hülle und bei gleichmäßigem Licht ohne Spiegelung.</p>
      <div id="g-stage-wrap" class="hidden">
        <div class="seg" id="g-mode"><button data-m="straighten" class="on">Begradigen</button><button data-m="center">Zentrierung</button><button data-m="defect">Mängel</button></div>
        <div class="inline g-tools" id="g-tools-straight">
          <button class="small primary" id="g-apply-straight">Begradigen und weiter</button>
          <button class="small" id="g-auto-corners">Ecken neu erkennen</button>
          <button class="small" id="g-skip-straight">Ohne Begradigen</button>
        </div>
        <div class="inline g-tools hidden" id="g-tools-measure">
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
  const onPick = (e) => {
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
      sd.raw = c;
      sd.img = c;
      sd.straight = false;
      sd.defects = [];
      sd.corners = detectCorners(c) || defaultCorners(c);
      sd.lines = autoDetect(c) || defaultLines();
      filtered = null;
      $('#g-stage-wrap', root).classList.remove('hidden');
      setMode('straighten');
      renderAll();
      URL.revokeObjectURL(im.src);
    };
    im.src = URL.createObjectURL(f);
    e.target.value = '';
  };
  $('#g-file', root).addEventListener('change', onPick);
  $('#g-gal', root).addEventListener('change', onPick);
  const defaultCorners = (c) => [[c.width * 0.05, c.height * 0.04], [c.width * 0.95, c.height * 0.04], [c.width * 0.95, c.height * 0.96], [c.width * 0.05, c.height * 0.96]];

  function setMode(m) {
    st.mode = m;
    $$('#g-mode button', root).forEach((x) => x.classList.toggle('on', x.dataset.m === m));
    $('#g-tools-straight', root).classList.toggle('hidden', m !== 'straighten');
    $('#g-tools-measure', root).classList.toggle('hidden', m === 'straighten');
    draw();
    renderHelp();
  }
  $('#g-apply-straight', root).addEventListener('click', () => {
    const sd = side();
    if (!sd.raw) return;
    // mit 4 % Rand entzerren: die echte Außenkante wird danach in voller Auflösung gemessen
    sd.img = warpCard(sd.raw, sd.corners, Math.min(1200, Math.max(800, Math.round(sd.raw.height * 0.8))), 0.04);
    sd.straight = true;
    sd.lines = autoDetect(sd.img, { cropped: false }) || defaultLines();
    sd.defects = [];
    filtered = null;
    setMode('center');
    renderAll();
  });
  $('#g-auto-corners', root).addEventListener('click', () => {
    const sd = side();
    if (!sd.raw) return;
    const c = detectCorners(sd.raw);
    if (!c) toast('Ecken nicht sicher erkannt – bitte von Hand an die Kartenecken ziehen');
    sd.corners = c || defaultCorners(sd.raw);
    draw();
  });
  $('#g-skip-straight', root).addEventListener('click', () => {
    const sd = side();
    sd.img = sd.raw;
    sd.straight = false;
    sd.lines = autoDetect(sd.img) || defaultLines();
    filtered = null;
    setMode('center');
    renderAll();
  });

  $$('#g-side button', root).forEach((b) =>
    b.addEventListener('click', () => {
      st.side = b.dataset.s;
      $$('#g-side button', root).forEach((x) => x.classList.toggle('on', x === b));
      filtered = null;
      $('#g-stage-wrap', root).classList.toggle('hidden', !side().img);
      setMode(side().img ? (side().straight ? 'center' : 'straighten') : 'straighten');
      renderAll();
    }),
  );
  $$('#g-mode button', root).forEach((b) => b.addEventListener('click', () => setMode(b.dataset.m)));
  $('#g-filter', root).addEventListener('click', () => {
    st.filter = !st.filter;
    $('#g-filter', root).classList.toggle('primary', st.filter);
    draw();
  });
  $('#g-reset-lines', root).addEventListener('click', () => {
    side().lines = (side().img && autoDetect(side().img, side().straight ? { cropped: false } : {})) || defaultLines();
    draw();
    renderAll();
  });

  function renderHelp() {
    $('#g-help', root).textContent =
      st.mode === 'straighten'
        ? 'Die vier Punkte auf die Ecken der Karte ziehen (Lupe hilft). „Begradigen und weiter“ legt die Karte gerade und formatfüllend hin.'
        : st.mode === 'center'
        ? 'Gelbe Linien an die Außenkante der Karte, türkise Linien an den inneren Bildrahmen schieben. Beim Ziehen zeigt eine Lupe die Stelle vergrößert.'
        : 'Auf eine Stelle tippen, um einen Mangel zu markieren. Art und Schwere darunter einstellen. Der Oberflächen-Filter macht Kratzer und Dellen sichtbarer.';
  }

  // ---------- Automatische Erkennung (Startwerte) ----------
  function autoDetect(c, opts = {}) {
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
      const cropped = opts.cropped ?? (aspect > 0.69 && aspect < 0.745);
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
  const srcOf = (sd) => (st.mode === 'straighten' ? sd.raw : sd.img);
  function geom() {
    const im = srcOf(side());
    const w = cv.clientWidth || 600;
    const h = Math.round((w * im.height) / im.width);
    return { w, h };
  }
  function draw() {
    const sd = side();
    if (!srcOf(sd)) return;
    const { w, h } = geom();
    const dpr = devicePixelRatio || 1;
    cv.width = w * dpr; cv.height = h * dpr; cv.style.height = h + 'px';
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    let src = srcOf(sd);
    if (st.filter && st.mode !== 'straighten') src = filtered || (filtered = edgeFilter(sd.img));
    ctx.drawImage(src, 0, 0, w, h);
    const L = sd.lines;
    if (st.mode === 'straighten' && sd.corners) {
      const k = w / sd.raw.width;
      const P = sd.corners.map(([x, y]) => [x * k, y * k]);
      ctx.fillStyle = 'rgba(48,209,88,.12)';
      ctx.strokeStyle = '#30d158'; ctx.lineWidth = 2;
      ctx.beginPath(); P.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); ctx.fill(); ctx.stroke();
      P.forEach(([x, y], i) => {
        ctx.fillStyle = st.drag === 'c' + i ? '#fff' : '#30d158';
        ctx.beginPath(); ctx.arc(x, y, 11, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5; ctx.stroke();
      });
    }
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
    if (st.mode !== 'straighten') sd.defects.forEach((d, i) => {
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
    if (!srcOf(sd)) return;
    const p = rel(e);
    if (st.mode === 'straighten') {
      const k = p.w / sd.raw.width;
      let best = null, bd = 40;
      sd.corners.forEach(([x, y], i) => { const dd = Math.hypot(x * k - p.x, y * k - p.y); if (dd < bd) { bd = dd; best = i; } });
      if (best != null) {
        st.drag = 'c' + best;
        cv.setPointerCapture(e.pointerId);
        st.loupe = { x: p.x, y: p.y };
        e.preventDefault();
        draw();
      }
      return;
    }
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
    if (k.startsWith('c')) {
      const sd = side(), sc = sd.raw.width / p.w;
      sd.corners[+k.slice(1)] = [Math.min(sd.raw.width, Math.max(0, p.x * sc)), Math.min(sd.raw.height, Math.max(0, p.y * sc))];
      st.loupe = { x: p.x, y: p.y };
      draw();
      return;
    }
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
        <button id="g-report">Bericht teilen</button>
      </div>
      <button id="g-clear" class="block ghost danger">Alles zurücksetzen</button>`;
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
    $('#g-report', root).addEventListener('click', async () => {
      const c = getCard();
      const res = result();
      await shareReport({ name: c ? c.name : 'Karte', sub: c ? `${c.set?.name || ''} · Nr. ${c.localId}${c.set?.cardCount?.official ? '/' + c.set.cardCount.official : ''}` : '' }, res, toast);
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
    const annotated = (sd) => {
      if (!sd.img) return null;
      const s2 = Math.min(1, 900 / sd.img.height);
      const c = document.createElement('canvas');
      c.width = Math.round(sd.img.width * s2);
      c.height = Math.round(sd.img.height * s2);
      const x = c.getContext('2d');
      x.drawImage(sd.img, 0, 0, c.width, c.height);
      const w = c.width, h = c.height, L = sd.lines;
      x.lineWidth = 2;
      for (const k of LINE_KEYS) {
        x.strokeStyle = k.startsWith('outer') ? '#ffd60a' : '#22d3ee';
        x.beginPath();
        if (/L$|R$/.test(k)) { x.moveTo(L[k] * w, 0); x.lineTo(L[k] * w, h); } else { x.moveTo(0, L[k] * h); x.lineTo(w, L[k] * h); }
        x.stroke();
      }
      sd.defects.forEach((d, i) => {
        x.strokeStyle = d.sev >= 3 ? '#ff453a' : d.sev === 2 ? '#ff9f0a' : '#ffd60a';
        x.lineWidth = 3; x.fillStyle = 'rgba(0,0,0,.6)';
        x.beginPath(); x.arc(d.x * w, d.y * h, 16, 0, Math.PI * 2); x.fill(); x.stroke();
        x.fillStyle = '#fff'; x.font = '700 16px system-ui'; x.textAlign = 'center'; x.textBaseline = 'middle';
        x.fillText(String(i + 1), d.x * w, d.y * h);
      });
      return c.toDataURL('image/jpeg', 0.8);
    };
    return {
      date: Date.now(),
      annotated: { front: annotated(st.sides.front), back: annotated(st.sides.back) },
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
