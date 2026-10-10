/**
 * Revendo — reconnaissance de l'article à partir des photos, SANS IA :
 *  - lecture des étiquettes (OCR Tesseract embarqué, voir offscreen/) :
 *    marque, taille, composition, rayon (« WOMEN », « 10 ans »), ticket de
 *    prix (neuf avec étiquette) ; chaque zone de texte est recadrée,
 *    agrandie et redressée avant d'être lue ;
 *  - couleur dominante votée sur plusieurs photos (analyse des pixels) ;
 *  - indices de catégorie (étiquette + marque spécialisée) ; la catégorie
 *    elle-même est choisie sur Vinted parmi SES recommandations (calculées
 *    depuis les photos), classées avec ces indices ;
 *  - marque inconnue de notre liste : les textes les plus gros de l'étiquette
 *    sont vérifiés dans la recherche de marques de Vinted au remplissage.
 */
import { dominantColors, pickListingColors, voteColors } from '../shared/colors.js';
import { getPixels, toJpeg } from '../shared/image.js';
import {
  brandCandidates,
  buildDescription,
  buildTitle,
  categoryHints,
  detectBrand,
  detectBrandFuzzy,
  detectMaterials,
  detectSizeStrict,
  labelClues,
  mergeFields,
} from '../shared/listing.js';
import { analyzeListing, optimizeTitle } from '../shared/seo.js';

const dataUrl = (p) => `data:${p.mime || 'image/jpeg'};base64,${p.base64}`;

/** Photos lues au plus (les étiquettes marquées d'abord). */
const MAX_OCR_PHOTOS = 10;
/** Au-delà, plus de lecture rapprochée des zones (la lecture complète continue). */
const ZONE_BUDGET_MS = 45000;

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

/**
 * Délai maximal de lecture d'UNE photo (la première charge aussi le moteur et
 * les packs de langue). Sans lui, un moteur figé bloquait l'analyse, donc le
 * robot, indéfiniment.
 */
const OCR_PHOTO_TIMEOUT_MS = 60000;

/**
 * Lit une photo (dataURL) : { text, score, lines, regions }.
 * opts.label : photo marquée « étiquette » ; opts.deadline : fin des lectures rapprochées.
 */
export async function ocrPhoto(image, opts = {}) {
  await ensureOffscreen();
  let timer = null;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Lecture des étiquettes trop longue')), OCR_PHOTO_TIMEOUT_MS);
  });
  try {
    const res = await Promise.race([
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'RV_OCR_PHOTO', image, label: !!opts.label, deadline: opts.deadline || 0 }),
      timeout,
    ]);
    if (!res?.ok) throw new Error(res?.error || 'lecture des étiquettes indisponible');
    return { text: res.text || '', score: res.score || 0, lines: res.lines || [], regions: res.regions || 0 };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Analyse
// ---------------------------------------------------------------------------

/** Ce qu'on sait d'un texte d'étiquettes : marque, taille, matières, indices. */
export function readLabels(text) {
  return {
    brand: detectBrand(text) || detectBrandFuzzy(text) || '',
    size: detectSizeStrict(text, { anchored: true }) || '',
    materials: detectMaterials(text),
    clues: labelClues(text),
  };
}

/**
 * Lecture des étiquettes : photos marquées d'abord, puis les autres dans
 * l'ordre (10 au plus). On s'arrête dès que marque ET taille sont lues (les
 * photos marquées sont toujours lues). Une photo qu'on ne peut pas décoder
 * est sautée ; un moteur qui ne démarre pas (ou se fige) arrête la lecture.
 */
async function readAllLabels(photos, labelIndexes, { read = ocrPhoto, now = Date.now, prepare = atMost } = {}) {
  const order = [...labelIndexes, ...photos.map((_, i) => i).filter((i) => !labelIndexes.includes(i))].slice(0, MAX_OCR_PHOTOS);
  const deadline = now() + ZONE_BUDGET_MS;
  const out = { text: '', lines: [], scores: new Map(), read: 0, error: '' };
  const texts = [];
  for (const i of order) {
    const isLabel = labelIndexes.includes(i);
    if (!isLabel && out.read > 0) {
      const sofar = readLabels(texts.join('\n'));
      if (sofar.brand && sofar.size) break;
    }
    let image;
    try {
      // Étiquette marquée : envoyée en haute définition par le téléphone, lue telle quelle (2048 px).
      image = await prepare(photos[i], isLabel ? 2048 : 1600, 0.92);
    } catch (err) {
      console.warn('[Revendo] photo illisible pour la lecture des étiquettes', i, err);
      continue;
    }
    try {
      const res = await read(image, { label: isLabel, deadline });
      texts.push(res.text);
      out.lines.push(...res.lines);
      out.scores.set(i, res.score);
      out.read += 1;
    } catch (err) {
      // Moteur qui ne démarre pas ou figé : inutile d'essayer les autres photos.
      out.error = err?.message || String(err);
      console.warn('[Revendo] lecture des étiquettes', i, err);
      break;
    }
  }
  out.text = texts.join('\n').slice(0, 8000);
  return out;
}

/**
 * Couleur : vote sur 3 photos de l'article au plus (ni étiquette marquée, ni
 * photo où l'on a lu beaucoup de texte), la première comptant davantage.
 */
async function colorsOf(photos, skip) {
  const picked = photos.map((_, i) => i).filter((i) => !skip.has(i)).slice(0, 3);
  if (!picked.length && photos.length) picked.push(0);
  const votes = [];
  for (const [k, i] of picked.entries()) {
    try {
      const px = await getPixels(dataUrl(photos[i]), 160);
      votes.push({ colors: dominantColors(px.data, px.width, px.height), weight: k === 0 ? 1.5 : 1 });
    } catch (err) {
      console.warn('[Revendo] couleur', i, err);
    }
  }
  return pickListingColors(voteColors(votes));
}

/**
 * photos = [{ base64, mime }], hints = ce que le vendeur a saisi (prix, rayon,
 * marque, taille, état, labelIndexes…). Renvoie { fields, recognition, local } :
 * fields.categoryHints = { rayon, words, search } et fields.brandCandidates
 * (à vérifier sur Vinted) servent au remplissage ; recognition résume ce qui
 * a été trouvé et d'où ({ mode: 'auto', found: { brand, size, … }, ocr }).
 */
export async function analyzePhotos({ photos, hints = {}, settings = {} }, deps = {}) {
  const labelIndexes = validIndexes(hints.labelIndexes, photos.length);
  const recognition = { mode: 'auto', found: {}, ocr: { photos: 0, error: '' } };
  const local = { brand: '', size: '', materials: [], colors: [], rayon: '', condition: '' };
  let labels = { text: '', lines: [], scores: new Map(), read: 0, error: '' };
  const wantOcr = settings.worker?.ocr !== false && photos.length > 0;
  if (wantOcr) {
    labels = await readAllLabels(photos, labelIndexes, deps);
    recognition.ocr = { photos: labels.read, error: labels.error };
    const found = readLabels(labels.text);
    Object.assign(local, { brand: found.brand, size: found.size, materials: found.materials, rayon: found.clues.rayon });
    if (found.clues.newWithTag) local.condition = 'Neuf avec étiquette';
  }
  // Photos « étiquette » (marquées ou très textuelles) : pas pour la couleur.
  const skip = new Set(labelIndexes);
  for (const [i, score] of labels.scores) if (score >= 8) skip.add(i);
  if (!hints.colors?.length) local.colors = await (deps.colors || colorsOf)(photos, skip);

  const fields = mergeFields({ hints, local, defaults: { condition: settings.worker?.defaultCondition } });
  fields.categoryHints = categoryHints({ rayon: fields.rayon, text: labels.text, brand: fields.brand });
  if (!fields.rayon && fields.categoryHints.rayon) fields.rayon = fields.categoryHints.rayon;
  fields.brandCandidates = fields.brand ? [] : brandCandidates(labels.lines);

  const from = (typed, readValue) => (typed ? 'saisie' : readValue ? 'étiquette' : '');
  recognition.found = {
    brand: from(hints.brand, local.brand),
    size: from(hints.size, local.size),
    materials: from(hints.materials?.length, local.materials.length),
    rayon: from(hints.rayon, local.rayon || fields.categoryHints.rayon),
    condition: hints.condition ? 'saisie' : local.condition ? 'étiquette' : '',
    colors: hints.colors?.length ? 'saisie' : local.colors.length ? 'photos' : '',
  };
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
