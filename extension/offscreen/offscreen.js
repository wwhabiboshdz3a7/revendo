/**
 * Revendo — document « offscreen » : lecture des étiquettes avec Tesseract
 * (moteur OCR embarqué, gratuit, sans IA ni service en ligne). Les packs de
 * langue (fra + eng) sont DANS l'extension (lib/tesseract/lang) : rien n'est
 * téléchargé, l'OCR marche hors ligne et derrière un proxy.
 * Le worker est chargé depuis son fichier (workerBlobURL: false) : la
 * politique de sécurité des extensions MV3 interdit les workers « blob: ».
 *
 * Une photo = un message : lecture complète, puis lecture rapprochée des
 * zones de texte repérées (voir label-ocr.js) — recadrées, agrandies, en
 * noir sur blanc et redressées.
 */
/* global Tesseract */
import { detectBrand, detectBrandFuzzy } from '../shared/listing.js';
import { prepareForOcr, readPhoto } from './label-ocr.js';

const isBrand = (text) => !!(detectBrand(text) || detectBrandFuzzy(text));

let workerPromise = null;
let currentPsm = '11';

function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const worker = await Tesseract.createWorker('fra+eng', 1, {
        workerPath: chrome.runtime.getURL('lib/tesseract/worker.min.js'),
        corePath: chrome.runtime.getURL('lib/tesseract/'),
        langPath: chrome.runtime.getURL('lib/tesseract/lang'),
        cacheMethod: 'none', // fichiers de l'extension : pas de copie en cache
        workerBlobURL: false,
      });
      // Texte épars (petites étiquettes n'importe où sur la photo) plutôt qu'une page de livre.
      await worker.setParameters({ tessedit_pageseg_mode: '11' });
      currentPsm = '11';
      return worker;
    })().catch((err) => {
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

async function setPsm(worker, psm) {
  if (psm === currentPsm) return;
  await worker.setParameters({ tessedit_pageseg_mode: psm });
  currentPsm = psm;
}

/** Image décodée (ImageBitmap, orientation EXIF appliquée) + Blob d'origine. */
async function load(src) {
  const blob = await (await fetch(src)).blob();
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  return { blob, bitmap };
}

/** Pixels de la photo entière (repérage des zones de texte). */
function pixelsOf(bitmap) {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
}

/**
 * Zone recadrée, agrandie (scale), tournée (degrés, sens horaire) en une
 * seule passe, puis retouchée (gris, contraste, inversion, accentuation).
 */
async function zoneBlob(bitmap, { box, scale, invert, rotate, sharpen }) {
  const bw = box.x1 - box.x0;
  const bh = box.y1 - box.y0;
  const sw = Math.max(1, Math.round(bw * scale));
  const sh = Math.max(1, Math.round(bh * scale));
  const rad = (rotate * Math.PI) / 180;
  const W = Math.max(1, Math.ceil(Math.abs(sw * Math.cos(rad)) + Math.abs(sh * Math.sin(rad))));
  const H = Math.max(1, Math.ceil(Math.abs(sw * Math.sin(rad)) + Math.abs(sh * Math.cos(rad))));
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.translate(W / 2, H / 2);
  ctx.rotate(rad);
  ctx.drawImage(bitmap, box.x0, box.y0, bw, bh, -sw / 2, -sh / 2, sw, sh);
  const data = ctx.getImageData(0, 0, W, H);
  prepareForOcr(data, { invert, sharpen });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.putImageData(data, 0, 0);
  return canvas.convertToBlob({ type: 'image/png' });
}

/** Photo entière tournée (étiquette photographiée à l'envers). */
async function turnedBlob(bitmap, rotate) {
  const quarter = Math.abs(rotate) % 180 === 90;
  const W = quarter ? bitmap.height : bitmap.width;
  const H = quarter ? bitmap.width : bitmap.height;
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.translate(W / 2, H / 2);
  ctx.rotate((rotate * Math.PI) / 180);
  ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
}

async function readOne(worker, msg) {
  const { blob, bitmap } = await load(msg.image);
  try {
    const recognize = async (op) => {
      await setPsm(worker, op.psm || '11');
      const source = op.box ? await zoneBlob(bitmap, op) : op.rotate ? await turnedBlob(bitmap, op.rotate) : blob;
      const { data } = await worker.recognize(source, {}, { text: true, blocks: true });
      return data;
    };
    return await readPhoto({ img: pixelsOf(bitmap), recognize, label: !!msg.label, deadline: Number(msg.deadline) || Infinity, isBrand });
  } finally {
    bitmap.close();
  }
}

/**
 * Message { target: 'offscreen', type: 'RV_OCR_PHOTO', image: dataURL, label, deadline }
 * → { ok, text, score, lines, regions }.
 */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen' || msg.type !== 'RV_OCR_PHOTO') return false;
  (async () => {
    try {
      const worker = await getWorker();
      const res = await readOne(worker, msg);
      sendResponse({ ok: true, text: res.text, score: res.score, lines: res.lines, regions: res.regions });
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message || err) });
    }
  })();
  return true;
});
