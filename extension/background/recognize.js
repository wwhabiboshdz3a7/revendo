/**
 * Revendo — reconnaissance de l'article à partir des photos.
 *  - Avec une clé IA (Gemini gratuit, OpenAI…) : catégorie, marque, taille,
 *    couleurs, matières, état, titre et texte.
 *  - Sans clé (mode gratuit) : couleur dominante (analyse des pixels) +
 *    lecture des étiquettes par OCR (marque, taille, composition). La
 *    catégorie est alors choisie sur Vinted à partir de SES propres
 *    recommandations (calculées depuis les photos).
 */
import { recognizeItem } from '../shared/ai.js';
import { dominantColors, pickListingColors } from '../shared/colors.js';
import { getPixels, toJpeg } from '../shared/image.js';
import { buildDescription, buildTitle, detectBrand, detectMaterials, detectSize, mergeFields } from '../shared/listing.js';
import { analyzeListing, optimizeTitle } from '../shared/seo.js';
import { aiConfigured } from './store.js';

const dataUrl = (p) => `data:${p.mime || 'image/jpeg'};base64,${p.base64}`;

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

export async function ocrImages(images) {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'RV_OCR', images });
  if (!res?.ok) throw new Error(res?.error || 'OCR indisponible');
  return res.texts || [];
}

// ---------------------------------------------------------------------------
// Analyse
// ---------------------------------------------------------------------------

async function localAnalysis(photos, { ocr = true, labelIndexes = [] } = {}) {
  const out = { colors: [], brand: '', size: '', materials: [], ocrText: '' };
  try {
    const px = await getPixels(dataUrl(photos[0]), 160);
    out.colors = pickListingColors(dominantColors(px.data, px.width, px.height));
  } catch (err) {
    console.warn('[Revendo] couleur', err);
  }
  if (ocr) {
    try {
      const idx = labelIndexes.length ? labelIndexes : photos.map((_, i) => i).slice(0, 4);
      const imgs = [];
      for (const i of idx) if (photos[i]) imgs.push((await toJpeg(dataUrl(photos[i]), { maxSide: 1400, quality: 0.9 })).dataUrl);
      const text = (await ocrImages(imgs)).join('\n');
      out.ocrText = text.slice(0, 2000);
      out.brand = detectBrand(text) || '';
      out.size = detectSize(text) || '';
      out.materials = detectMaterials(text);
    } catch (err) {
      console.warn('[Revendo] OCR', err);
    }
  }
  return out;
}

/**
 * photos = [{ base64, mime }], hints = indices saisis (prix, rayon, marque…).
 * Renvoie { fields, recognition } prêts pour la composition de l'annonce.
 */
export async function analyzePhotos({ photos, hints = {}, settings }) {
  const recognition = { mode: 'free', model: '', error: '' };
  let ai = null;
  if (aiConfigured(settings) && !hints.skipAi) {
    try {
      const images = [];
      for (const p of photos.slice(0, 6)) images.push((await toJpeg(dataUrl(p), { maxSide: 1024, quality: 0.85 })).dataUrl);
      ai = await recognizeItem({ images, hints, config: settings.ai, timeoutMs: 90000 });
      recognition.mode = 'ai';
      recognition.model = ai.model;
    } catch (err) {
      recognition.error = err.message;
    }
  }
  // Le mode gratuit complète ce que l'IA n'a pas trouvé (ou la remplace si elle a échoué).
  const needLocal = !ai || !ai.colors?.length || (!ai.brand && !hints.brand) || (!ai.size && !hints.size);
  const local = needLocal ? await localAnalysis(photos, { ocr: settings.worker?.ocr !== false, labelIndexes: hints.labelIndexes || [] }) : null;
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
