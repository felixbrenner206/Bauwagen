// Offline-Texterkennung für Kassenbons mit Tesseract.js (läuft komplett auf dem Handy).
// Beim ersten Gebrauch werden ~10 MB (Programm + deutsche Sprachdaten) von jsDelivr geladen und vom
// Service Worker bzw. Tesseract selbst (IndexedDB) gespeichert – danach geht es ohne Internet.

const TESS_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
let libPromise = null, workerPromise = null;

function loadLib() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (!libPromise) libPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = TESS_URL; s.async = true;
    s.onload = () => window.Tesseract ? resolve(window.Tesseract) : reject(new Error('Tesseract nicht geladen'));
    s.onerror = () => { libPromise = null; reject(new Error('Texterkennung konnte nicht geladen werden (beim ersten Mal Internet nötig).')); };
    document.head.appendChild(s);
  });
  return libPromise;
}

let progressCb = null;
function getWorker() {
  if (!workerPromise) workerPromise = (async () => {
    const T = await loadLib();
    const w = await T.createWorker('deu', 1, {
      logger: (m) => progressCb && m && typeof m.progress === 'number' && progressCb(m.status, m.progress)
    });
    await w.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' });   // 6 = ein Textblock (Bon)
    return w;
  })().catch(e => { workerPromise = null; throw e; });
  return workerPromise;
}

// Im Hintergrund vorladen, sobald jemand den Scan öffnet (nur mit Netz sinnvoll)
export function preload() { getWorker().catch(() => {}); }
export function isReady() { return !!workerPromise; }

// Bild für Thermopapier aufbereiten: verkleinern, Graustufen, Kontrast strecken
export function prepare(canvas, maxW = 1800) {
  const scale = Math.min(1, maxW / canvas.width);
  const c = document.createElement('canvas');
  c.width = Math.round(canvas.width * scale); c.height = Math.round(canvas.height * scale);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, c.width, c.height);
  const img = ctx.getImageData(0, 0, c.width, c.height), d = img.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0;
    d[i] = g; hist[g]++;
  }
  // 2 % / 98 % Perzentil als Schwarz-/Weißpunkt
  const total = c.width * c.height; let lo = 0, hi = 255, acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > total * 0.02) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > total * 0.02) { hi = v; break; } }
  const span = Math.max(1, hi - lo);
  for (let i = 0; i < d.length; i += 4) {
    const v = Math.max(0, Math.min(255, (d[i] - lo) * 255 / span));
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// canvases: Fotos (Canvas) → Array mit erkanntem Text je Foto
export async function recognize(canvases, onProgress) {
  progressCb = null;
  onProgress && onProgress('Texterkennung wird geladen …', 0);
  const w = await getWorker();
  const out = [];
  for (let i = 0; i < canvases.length; i++) {
    progressCb = (status, p) => onProgress && onProgress(`Foto ${i + 1}/${canvases.length} wird gelesen …`, (i + (status === 'recognizing text' ? p : 0)) / canvases.length);
    const { data } = await w.recognize(prepare(canvases[i]));
    out.push(data.text || '');
  }
  progressCb = null;
  return out;
}
