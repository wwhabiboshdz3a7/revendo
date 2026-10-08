/**
 * Revendo — outils image (navigateur, page d'extension, service worker).
 * Compression JPEG, miniatures, pixels pour la détection de couleur.
 */

const hasDOM = typeof document !== 'undefined' && typeof document.createElement === 'function';

export function base64ToBlob(base64, mime = 'image/jpeg') {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export function dataUrlToBase64(dataUrl) {
  return String(dataUrl).split(',')[1] || '';
}

async function blobToDataUrl(blob) {
  if (typeof FileReader !== 'undefined') {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return `data:${blob.type || 'image/jpeg'};base64,${btoa(bin)}`;
}

/** Décode une image (File/Blob/dataURL) en tenant compte de l'orientation EXIF. */
async function decode(source) {
  const blob = typeof source === 'string' ? base64ToBlob(dataUrlToBase64(source), (/^data:([^;]+)/.exec(source) || [])[1] || 'image/jpeg') : source;
  if (hasDOM) {
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      await img.decode();
      return { img, width: img.naturalWidth, height: img.naturalHeight, release: () => URL.revokeObjectURL(url) };
    } catch (err) {
      URL.revokeObjectURL(url);
      throw new Error('Image illisible (format non pris en charge ?)');
    }
  }
  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  return { img: bmp, width: bmp.width, height: bmp.height, release: () => bmp.close?.() };
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

async function canvasToBlob(canvas, quality) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type: 'image/jpeg', quality });
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

/** Redimensionne (côté max) et réencode en JPEG. */
export async function toJpeg(source, { maxSide = 1600, quality = 0.85 } = {}) {
  const { img, width, height, release } = await decode(source);
  try {
    const scale = Math.min(1, maxSide / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const canvas = makeCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const blob = await canvasToBlob(canvas, quality);
    const dataUrl = await blobToDataUrl(blob);
    return { dataUrl, base64: dataUrlToBase64(dataUrl), width: w, height: h, bytes: blob.size };
  } finally {
    release();
  }
}

/** Pixels RGBA d'une version réduite (pour la couleur dominante). */
export async function getPixels(source, maxSide = 160) {
  const { img, width, height, release } = await decode(source);
  try {
    const scale = Math.min(1, maxSide / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const canvas = makeCanvas(w, h);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    return { data: ctx.getImageData(0, 0, w, h).data, width: w, height: h };
  } finally {
    release();
  }
}
