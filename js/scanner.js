// Live-Scanner: Kamera mit Kartenrahmen. Sobald das Bild scharf und ruhig ist,
// wird der untere Streifen (Kartennummer) per OCR gelesen. Zwei gleiche Lesungen = Treffer.
import { parseCardNumberLoose } from './calc.js';

/** Schärfe: Varianz des Laplace-Operators auf Graustufen (höher = schärfer). */
export function sharpness(gray, w, h) {
  let sum = 0, sum2 = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const l = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
      sum += l; sum2 += l * l; n++;
    }
  }
  const m = sum / n;
  return sum2 / n - m * m;
}

function toGray(data) {
  const g = new Float32Array(data.length / 4);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) g[j] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  return g;
}

export function createScanner({ wrap, video, frame, onStatus, onResult, recognize, isValidTotal }) {
  let stream = null, track = null, timer = null, busy = false, stopped = true;
  let prevGray = null, stableTicks = 0, maxSharp = 0, lastRead = null, started = 0, torchOn = false, lastText = '', attempts = 0;
  const work = document.createElement('canvas');
  const wctx = work.getContext('2d', { willReadFrequently: true });

  /** Rahmen- bzw. Streifen-Rechteck in Video-Pixeln (Video mit object-fit: cover). */
  function regions() {
    const vw = video.videoWidth, vh = video.videoHeight;
    const wr = wrap.getBoundingClientRect(), fr = frame.getBoundingClientRect();
    const scale = Math.max(wr.width / vw, wr.height / vh);
    const ox = (wr.width - vw * scale) / 2, oy = (wr.height - vh * scale) / 2;
    const toV = (x, y) => ({ x: (x - wr.left - ox) / scale, y: (y - wr.top - oy) / scale });
    const a = toV(fr.left, fr.top), b = toV(fr.right, fr.bottom);
    const card = { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
    // Nummer steht unten links (neu) oder unten rechts (alt): unterer Streifen über die ganze Breite
    const strip = { x: card.x, y: card.y + card.h * 0.89, w: card.w, h: card.h * 0.11 };
    return { card, strip };
  }

  function grab(r, targetW) {
    const s = targetW / r.w;
    work.width = Math.max(1, Math.round(r.w * s));
    work.height = Math.max(1, Math.round(r.h * s));
    wctx.drawImage(video, r.x, r.y, r.w, r.h, 0, 0, work.width, work.height);
    return wctx.getImageData(0, 0, work.width, work.height);
  }

  async function tick() {
    if (stopped || !video.videoWidth) return;
    const { strip } = regions();
    const img = grab(strip, 360);
    const gray = toGray(img.data);
    const sh = sharpness(gray, img.width, img.height);
    maxSharp = Math.max(maxSharp * 0.995, sh);
    let motion = 0;
    if (prevGray && prevGray.length === gray.length) {
      for (let i = 0; i < gray.length; i += 7) motion += Math.abs(gray[i] - prevGray[i]);
      motion /= gray.length / 7;
    }
    prevGray = gray;
    const sharpEnough = sh > 60 && sh > maxSharp * 0.55;
    const still = motion < 6;
    stableTicks = sharpEnough && still ? stableTicks + 1 : 0;
    frame.classList.toggle('ready', stableTicks >= 2);

    if (Date.now() - started > 20000 && !lastRead) onStatus('Nummer schwer lesbar: näher ran, Licht an oder Nummer manuell eingeben.', 'warn');
    else if (!sharpEnough) onStatus('Karte in den Rahmen halten …');
    else if (!still) onStatus('Ruhig halten …');

    if (stableTicks >= 2 && !busy) {
      busy = true;
      onStatus('Scharf – lese Nummer …');
      try {
        // in voller Auflösung lesen
        const c = document.createElement('canvas');
        c.width = Math.round(strip.w);
        c.height = Math.round(strip.h);
        c.getContext('2d').drawImage(video, strip.x, strip.y, strip.w, strip.h, 0, 0, c.width, c.height);
        const text = await recognize(c);
        lastText = text;
        attempts++;
        const p = parseCardNumberLoose(text, isValidTotal);
        if (p && plausible(p)) {
          const key = `${p.number}/${p.total}`;
          if (lastRead === key) {
            frame.classList.add('hit');
            if (navigator.vibrate) navigator.vibrate(60);
            onStatus(`Erkannt: ${key}`, 'ok');
            stop();
            onResult(p, c);
            return;
          }
          lastRead = key;
          onStatus(`Gelesen ${key} – bestätige …`);
        } else {
          onStatus(`Suche Nummer … (Versuch ${attempts})`);
        }
      } catch (e) {
        onStatus('Texterkennung fehlgeschlagen: ' + e.message, 'warn');
      } finally {
        busy = false;
      }
    }
  }

  function plausible(p) {
    const n = parseInt(p.number.replace(/^[A-Z]+/, ''), 10);
    const t = parseInt(p.total.replace(/^[A-Z]+/, ''), 10);
    return n > 0 && t > 0 && t < 500 && n < 600;
  }

  async function start() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Kamera wird von diesem Browser nicht unterstützt');
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
    track = stream.getVideoTracks()[0];
    try {
      const caps = track.getCapabilities ? track.getCapabilities() : {};
      if (caps.focusMode && caps.focusMode.includes('continuous')) await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
    } catch {}
    video.srcObject = stream;
    video.setAttribute('playsinline', '');
    video.muted = true;
    await video.play();
    stopped = false;
    busy = false;
    prevGray = null; stableTicks = 0; maxSharp = 0; lastRead = null; started = Date.now();
    frame.classList.remove('hit', 'ready');
    timer = setInterval(tick, 220);
    onStatus('Karte in den Rahmen halten …');
  }

  function stop() {
    stopped = true;
    clearInterval(timer);
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null; track = null; torchOn = false;
    video.srcObject = null;
  }

  function torchSupported() {
    try { return !!(track && track.getCapabilities && track.getCapabilities().torch); } catch { return false; }
  }
  async function toggleTorch() {
    if (!torchSupported()) return false;
    torchOn = !torchOn;
    await track.applyConstraints({ advanced: [{ torch: torchOn }] });
    return torchOn;
  }

  return { start, stop, toggleTorch, torchSupported, get running() { return !stopped; }, get lastText() { return lastText; } };
}
