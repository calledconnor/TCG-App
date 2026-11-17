// OCR der Kartennummer mit lokal eingebundenem Tesseract.js (funktioniert offline).
let workerP;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (window.Tesseract) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Tesseract konnte nicht geladen werden'));
    document.head.appendChild(s);
  });
}

async function getWorker() {
  if (workerP) return workerP;
  workerP = (async () => {
    const base = new URL('vendor/tesseract/', document.baseURI).href;
    await loadScript(base + 'tesseract.min.js');
    const w = await window.Tesseract.createWorker('eng', 1, {
      workerPath: base + 'worker.min.js',
      corePath: base + 'core/',
      langPath: base + 'lang',
      gzip: true,
    });
    await w.setParameters({
      tessedit_char_whitelist: '0123456789/ABCDEFGHJKMNPRSTVWXYZ',
      tessedit_pageseg_mode: '6',
    });
    return w;
  })();
  workerP.catch(() => (workerP = null));
  return workerP;
}

/** Ausschnitt vorbereiten: hochskalieren, Graustufen, Kontrast. */
export function preprocess(srcCanvas) {
  const scale = Math.max(1, Math.min(4, 1200 / srcCanvas.width));
  const c = document.createElement('canvas');
  c.width = Math.round(srcCanvas.width * scale);
  c.height = Math.round(srcCanvas.height * scale);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(srcCanvas, 0, 0, c.width, c.height);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  let min = 255, max = 0;
  const g = new Uint8ClampedArray(d.length / 4);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    const v = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    g[j] = v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = Math.max(1, max - min);
  // Mittelwert bestimmen: helle Schrift auf dunklem Grund -> invertieren
  let sum = 0;
  for (let j = 0; j < g.length; j++) sum += g[j];
  const invert = sum / g.length < 110;
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    let v = ((g[j] - min) / range) * 255;
    if (invert) v = 255 - v;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export async function recognize(canvas, onStatus) {
  onStatus && onStatus('OCR wird geladen …');
  const w = await getWorker();
  onStatus && onStatus('Lese Nummer …');
  const { data } = await w.recognize(preprocess(canvas));
  return data.text || '';
}
