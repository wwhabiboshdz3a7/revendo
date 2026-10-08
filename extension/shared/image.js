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

/** Dessine l'image réduite (côté max) sur fond blanc. */
function render(img, width, height, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return { canvas, w, h };
}

async function finish(blob, w, h, quality) {
  const dataUrl = await blobToDataUrl(blob);
  return { dataUrl, base64: dataUrlToBase64(dataUrl), width: w, height: h, bytes: blob.size, quality };
}

/** Redimensionne (côté max) et réencode en JPEG. */
export async function toJpeg(source, { maxSide = 1600, quality = 0.85 } = {}) {
  const { img, width, height, release } = await decode(source);
  try {
    const { canvas, w, h } = render(img, width, height, maxSide);
    return finish(await canvasToBlob(canvas, quality), w, h, quality);
  } finally {
    release();
  }
}

/**
 * Comme toJpeg, mais vise un POIDS maximal : on baisse la qualité jusqu'à
 * passer sous `maxBytes`. Indispensable car les encodeurs JPEG n'ont pas la
 * même échelle : « 0,85 » sur iPhone (Safari) donne ~95 % ailleurs, soit
 * ~900 Ko pour une photo 1200×1600 au lieu de ~300 Ko.
 */
export async function toJpegTarget(source, { maxSide = 1600, maxBytes = 400 * 1024, qualities = [0.82, 0.74, 0.66, 0.58, 0.5] } = {}) {
  const { img, width, height, release } = await decode(source);
  try {
    let side = maxSide;
    for (let pass = 0; pass < 2; pass += 1) {
      const { canvas, w, h } = render(img, width, height, side);
      let blob = null;
      let q = qualities[0];
      for (q of qualities) {
        blob = await canvasToBlob(canvas, q);
        if (blob.size <= maxBytes) return finish(blob, w, h, q);
      }
      // Toujours trop lourd à la qualité minimale (photo très détaillée) : on réduit un peu.
      if (pass === 1) return finish(blob, w, h, q);
      side = Math.round(side * 0.8);
    }
    throw new Error('compression impossible');
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
