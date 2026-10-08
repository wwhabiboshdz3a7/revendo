/**
 * Revendo — reconnaissance de l'article à partir des photos.
 *  - Avec une clé IA (Gemini gratuit, OpenAI…) : lecture des étiquettes
 *    d'abord, puis catégorie, marque, taille, couleurs, matières, état, titre
 *    et texte ; seconde passe « étiquette » en haute définition si la marque
 *    ou la taille manque.
 *  - Sans clé (mode gratuit) : couleur dominante (analyse des pixels) +
 *    lecture des étiquettes par OCR (marque, taille, composition). La
 *    catégorie est alors choisie sur Vinted à partir de SES propres
 *    recommandations (calculées depuis les photos).
 * Le mode gratuit complète toujours ce que l'IA n'a pas trouvé.
 */
import { MAX_AI_IMAGES, pickPhotosForAi, recognizeItem } from '../shared/ai.js';
import { dominantColors, pickListingColors } from '../shared/colors.js';
import { getPixels, toJpeg } from '../shared/image.js';
import { buildDescription, buildTitle, detectBrand, detectBrandFuzzy, detectMaterials, detectSizeStrict, mergeFields } from '../shared/listing.js';
import { analyzeListing, optimizeTitle } from '../shared/seo.js';

const dataUrl = (p) => `data:${p.mime || 'image/jpeg'};base64,${p.base64}`;

/**
 * Dimensions d'un JPEG lues dans son en-tête (marqueur SOF), sans le décoder.
 * Renvoie { width, height } ou null (pas un JPEG, en-tête illisible).
 */
export function jpegDims(base64) {
  try {
    const head = String(base64 || '').slice(0, 262144); // 192 Ko suffisent (EXIF compris)
    const bin = atob(head.slice(0, head.length - (head.length % 4)));
    const at = (i) => bin.charCodeAt(i);
    if (at(0) !== 0xff || at(1) !== 0xd8) return null;
    let i = 2;
    while (i + 9 < bin.length) {
      if (at(i) !== 0xff) return null;
      const marker = at(i + 1);
      if (marker === 0xff) {
        i += 1;
        continue;
      }
      const len = (at(i + 2) << 8) | at(i + 3);
      // SOF0..SOF15 sauf DHT (C4), JPG (C8) et DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: (at(i + 5) << 8) | at(i + 6), width: (at(i + 7) << 8) | at(i + 8) };
      }
      if (marker === 0xda || len < 2) return null;
      i += 2 + len;
    }
  } catch (_e) {
    /* base64 invalide */
  }
  return null;
}

/** La photo telle quelle si elle ne dépasse pas `maxSide` (pas de réencodage), sinon réduite. */
async function atMost(photo, maxSide, quality) {
  const dims = photo.mime && photo.mime !== 'image/jpeg' ? null : jpegDims(photo.base64);
  if (dims && Math.max(dims.width, dims.height) <= maxSide) return dataUrl(photo);
  return (await toJpeg(dataUrl(photo), { maxSide, quality })).dataUrl;
}

/** Indices de photos valides et uniques (hints.labelIndexes). */
function validIndexes(list, count) {
  return [...new Set((Array.isArray(list) ? list : []).map(Number))].filter((i) => Number.isInteger(i) && i >= 0 && i < count);
}

// ---------------------------------------------------------------------------
// OCR via document offscreen (Tesseract a besoin d'un Worker)
// ---------------------------------------------------------------------------

async function ensureOffscreen() {
  const url = chrome.runtime.getURL('offscreen/offscreen.html');
  if (chrome.runtime.getContexts) {
    const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
    if (ctx.length) return;
  }
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['WORKERS'],
      justification: 'Lecture des étiquettes (OCR Tesseract) pour remplir la marque et la taille.',
    });
  } catch (err) {
    if (!/single offscreen|already exists/i.test(String(err?.message || err))) throw err;
  }
}

/** Texte lu sur chaque image (même ordre). opts.retryUpsideDown : relit à 180° une image presque vide. */
export async function ocrImages(images, opts = {}) {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'RV_OCR', images, ...opts });
  if (!res?.ok) throw new Error(res?.error || 'OCR indisponible');
  return res.texts || [];
}

// ---------------------------------------------------------------------------
// Analyse
// ---------------------------------------------------------------------------

/**
 * Mode gratuit : couleur dominante (photo principale) + OCR des photos
 * d'étiquette, sinon de TOUTES les photos (8 max), à leur résolution
 * d'origine (≤ 1600 px : on ne réduit pas davantage, l'OCR en a besoin).
 */
async function localAnalysis(photos, { ocr = true, colors = true, labelIndexes = [] } = {}) {
  const out = { colors: [], brand: '', size: '', materials: [], ocrText: '' };
  if (colors) {
    try {
      // Couleur sur la première photo qui n'est pas un gros plan d'étiquette.
      const main = photos.find((_, i) => !labelIndexes.includes(i)) || photos[0];
      const px = await getPixels(dataUrl(main), 160);
      out.colors = pickListingColors(dominantColors(px.data, px.width, px.height));
    } catch (err) {
      console.warn('[Revendo] couleur', err);
    }
  }
  if (ocr) {
    try {
      const idx = (labelIndexes.length ? labelIndexes : photos.map((_, i) => i)).slice(0, 8);
      const imgs = [];
      for (const i of idx) {
        try {
          imgs.push(await atMost(photos[i], 1600, 0.92));
        } catch (err) {
          console.warn('[Revendo] photo illisible pour l’OCR', i, err);
        }
      }
      const text = (await ocrImages(imgs, { retryUpsideDown: labelIndexes.length > 0 })).join('\n');
      out.ocrText = text.slice(0, 4000);
      out.brand = detectBrand(text) || detectBrandFuzzy(text) || '';
      out.size = detectSizeStrict(text, { anchored: true }) || '';
      out.materials = detectMaterials(text);
    } catch (err) {
      console.warn('[Revendo] OCR', err);
    }
  }
  return out;
}

/**
 * Images pour la passe principale : 8 au plus, toutes les photos d'étiquette
 * comprises (1600 px, qualité 0,88 — gardées telles quelles si elles sont
 * déjà assez petites, pour ne pas dégrader le texte), les autres en 1280 px
 * (qualité 0,82). Chaque image garde l'indice de sa photo d'origine.
 */
async function prepareAiImages(photos, labelIndexes) {
  const labels = new Set(labelIndexes);
  const images = [];
  for (const i of pickPhotosForAi(photos.length, labelIndexes, MAX_AI_IMAGES)) {
    const label = labels.has(i);
    try {
      const url = label ? await atMost(photos[i], 1600, 0.88) : (await toJpeg(dataUrl(photos[i]), { maxSide: 1280, quality: 0.82 })).dataUrl;
      images.push({ url, index: i, label });
    } catch (err) {
      console.warn('[Revendo] photo illisible', i, err);
    }
  }
  return images;
}

/** Photos d'étiquette en haute définition (2048 px, qualité 0,9) pour la seconde passe. */
async function labelImagesHD(photos, indexes) {
  const out = [];
  for (const i of indexes) {
    if (!photos[i]) continue;
    try {
      out.push(await atMost(photos[i], 2048, 0.9));
    } catch (err) {
      console.warn('[Revendo] photo d’étiquette illisible', i, err);
    }
  }
  return out;
}

/**
 * photos = [{ base64, mime }], hints = indices saisis (prix, rayon, marque,
 * labelIndexes…). Renvoie { fields, recognition, local } :
 * recognition = { mode: 'ai'|'free', model, error (pourquoi l'IA n'a pas servi,
 * '' sinon), noKey (aucune clé IA dans ce profil), passes (0, 1 ou 2) }.
 */
export async function analyzePhotos({ photos, hints = {}, settings }) {
  const key = String(settings.ai?.key || '').trim();
  const recognition = { mode: 'free', model: '', error: '', noKey: !key, passes: 0 };
  const labelIndexes = validIndexes(hints.labelIndexes, photos.length);
  let ai = null;
  if (key && !hints.skipAi) {
    if (settings.ai?.enabled === false) {
      recognition.error = 'IA désactivée dans les réglages';
    } else {
      try {
        const images = await prepareAiImages(photos, labelIndexes);
        ai = await recognizeItem({
          images,
          hints: { ...hints, labelIndexes },
          config: settings.ai,
          timeoutMs: 90000,
          labelTimeoutMs: 45000,
          labelImages: (idx) => labelImagesHD(photos, idx),
        });
        recognition.mode = 'ai';
        recognition.model = ai.model;
        recognition.passes = ai.passes;
      } catch (err) {
        recognition.error = err?.message || String(err);
        console.warn('[Revendo] IA', err?.detail || err);
      }
    }
  }
  // Le mode gratuit complète ce que l'IA n'a pas trouvé (ou la remplace si elle a échoué).
  const needBrand = !hints.brand && !ai?.brand;
  const needSize = !hints.size && !ai?.size;
  const needColors = !ai?.colors?.length;
  const local =
    needBrand || needSize || needColors
      ? await localAnalysis(photos, { ocr: settings.worker?.ocr !== false && (needBrand || needSize || !ai), colors: needColors, labelIndexes })
      : null;
  const fields = mergeFields({ hints, ai, local, defaults: { condition: settings.worker?.defaultCondition } });
  return { fields, recognition, local };
}

/** Annonce complète (titre + description) pour le content script. */
export function composeListing(fields, settings, { categoryName = '', photoCount = 0 } = {}) {
  const f = { ...fields };
  if (categoryName && !fields.title) f.categoryName = categoryName;
  // Titre « boost référencement » : type + marque + couleur + taille, avec les seules infos connues.
  const title = fields.title ? optimizeTitle(fields.title, f) : f.category || f.categoryName ? buildTitle(f) : '';
  const description = buildDescription({ ...f, title }, { hashtags: settings.profile?.hashtags ?? 80, signature: settings.profile?.signature || '' });
  const a = analyzeListing({ ...f, category: f.category || f.categoryName, title, description }, { photoCount });
  const seo = { score: a.score, grade: a.grade, todo: a.todo.slice(0, 4).map((c) => c.tip) };
  return { ...f, title, description, seo };
}
