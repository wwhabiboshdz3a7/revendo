/**
 * Revendo — tests de la reconnaissance de l'article (IA + mode gratuit) :
 * lecture de la réponse, marques (orthographe, détection tolérante à l'OCR),
 * tailles, fusion des sources, et appels IA avec un fetch simulé (mode JSON,
 * replis, seconde passe « étiquette »). Sans réseau ni navigateur.
 * Lancement : node --test tools/test/*.test.mjs
 */
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import {
  AI_PRESETS,
  buildPrompt,
  chatWithFallback,
  mergeLabelPass,
  normalizeAiResult,
  normalizeCategory,
  parseJsonLoose,
  pickPhotosForAi,
  recognizeItem,
} from '../../extension/shared/ai.js';
import { nearestVintedColor, pickListingColors } from '../../extension/shared/colors.js';
import {
  canonicalBrand,
  detectBrand,
  detectBrandFuzzy,
  detectSize,
  detectSizeStrict,
  mergeFields,
  normalizeSize,
} from '../../extension/shared/listing.js';
import { BRANDS, BRAND_ALIASES, BRAND_AMBIGUOUS } from '../../extension/shared/vinted-data.js';
import { jpegDims, ocrImages } from '../../extension/background/recognize.js';

// ---------------------------------------------------------------------------
// Faux fournisseur IA
// ---------------------------------------------------------------------------

/** fetch simulé : `replies` = liste de réponses (objet JSON du modèle, { status, error } ou fonction). */
function fakeFetch(replies) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const content = body.messages[0].content;
    const parts = Array.isArray(content) ? content : [{ type: 'text', text: content }];
    calls.push({
      url,
      body,
      model: body.model,
      json: !!body.response_format,
      prompt: parts.find((p) => p.type === 'text')?.text || '',
      images: parts.filter((p) => p.type === 'image_url').map((p) => p.image_url.url),
    });
    let r = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (typeof r === 'function') r = await r(init, body);
    if (r && r.status) {
      const err = Array.isArray(r.error) ? r.error : { error: { message: r.error || 'erreur' } };
      return new Response(JSON.stringify(err), { status: r.status });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: typeof r === 'string' ? r : JSON.stringify(r) } }] }), { status: 200 });
  };
  return { fetchImpl, calls };
}

const GEMINI = { preset: 'gemini', key: 'cle-test' };
const img = (n) => `data:image/jpeg;base64,IMG${n}`;

// ---------------------------------------------------------------------------
// Réponse de l'IA
// ---------------------------------------------------------------------------

test('parseJsonLoose : blocs ```json, texte parasite, tableau, accolades dans les chaînes', () => {
  assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonLoose('Voici la fiche : {"title":"Pull {rare}","n":2} merci'), { title: 'Pull {rare}', n: 2 });
  assert.deepEqual(parseJsonLoose('[{"brand":"Gant"}]'), { brand: 'Gant' });
  assert.deepEqual(parseJsonLoose('{"t":"guillemet \\" et }"}'), { t: 'guillemet " et }' });
  assert.equal(parseJsonLoose('pas de json'), null);
  assert.equal(parseJsonLoose(''), null);
  assert.equal(parseJsonLoose('{"a": }'), null);
});

test('normalizeAiResult : champs étiquette conservés, marque à la bonne orthographe', () => {
  const r = normalizeAiResult({
    label_text: 'TOMMY HILFIGER\nM | MADE IN CHINA',
    label_photos: [1, '3', 1, -2, 'x'],
    brand: 'TOMMY HILFIGER',
    brand_evidence: 'etiquette',
    size: 'm',
    rayon: 'femmes',
    category: 'Pull',
    colors: ['bleu marine', 'blanc', 'rouge'],
    materials: [],
    condition: 'très bon état',
    package: 'moyen',
    confidence: 1.4,
  });
  assert.equal(r.labelText, 'TOMMY HILFIGER | M | MADE IN CHINA');
  assert.deepEqual(r.labelPhotos, [1, 3]);
  assert.equal(r.brand, 'Tommy Hilfiger');
  assert.equal(r.brandEvidence, 'étiquette');
  assert.equal(r.size, 'M');
  assert.equal(r.rayon, 'Femmes');
  assert.equal(r.category, 'Pulls');
  assert.deepEqual(r.colors, ['Marine', 'Blanc']);
  assert.equal(r.condition, 'Très bon état');
  assert.equal(r.package, 'Moyen');
  assert.equal(r.confidence, 1);
});

test('normalizeAiResult : marque, taille et matières complétées depuis label_text', () => {
  const r = normalizeAiResult({
    label_text: 'GANT | L | 80% COTON 20% POLYESTER | MADE IN PORTUGAL',
    brand: 'inconnue',
    size: '',
    materials: [],
  });
  assert.equal(r.brand, 'Gant');
  assert.equal(r.brandEvidence, 'étiquette');
  assert.equal(r.size, 'L');
  assert.deepEqual(r.materials, ['Coton', 'Polyester']);
  // Rien de lisible : rien d'inventé.
  const empty = normalizeAiResult({ label_text: 'MADE IN U.S.A. | DRY CLEAN ONLY', brand: '', size: '' });
  assert.equal(empty.brand, '');
  assert.equal(empty.brandEvidence, '');
  assert.equal(empty.size, '');
  assert.equal(normalizeAiResult(null), null);
  assert.equal(normalizeAiResult([1, 2]), null);
});

test('normalizeAiResult : tailles et catégories ramenées au format Vinted', () => {
  assert.equal(normalizeAiResult({ size: '10Y' }).size, '10 ans');
  assert.equal(normalizeAiResult({ size: 'W32 L34' }).size, 'W32');
  assert.equal(normalizeAiResult({ size: 'EU 38.5' }).size, '38,5');
  assert.equal(normalizeAiResult({ size: 'unknown' }).size, '');
  assert.equal(normalizeSize('One size'), 'Taille unique');
  assert.equal(normalizeSize('Medium'), 'M');
  assert.equal(normalizeCategory('hoodie'), 'Sweats');
  assert.equal(normalizeCategory('T-shirt'), 'T-shirts');
  assert.equal(normalizeCategory('Pulls à col roulé'), 'Pulls à col roulé');
  assert.equal(normalizeCategory('Chaussons'), 'Chaussons');
});

// ---------------------------------------------------------------------------
// Marques
// ---------------------------------------------------------------------------

test('données marques : alias et marques ambiguës pointent vers BRANDS, sans doublon', () => {
  const seen = new Set();
  for (const b of BRANDS) {
    assert.ok(!seen.has(b.toLowerCase()), `doublon ${b}`);
    seen.add(b.toLowerCase());
  }
  for (const [alias, name] of Object.entries(BRAND_ALIASES)) assert.ok(BRANDS.includes(name), `alias ${alias} → ${name}`);
  for (const b of BRAND_AMBIGUOUS) assert.ok(BRANDS.includes(b), `ambiguë ${b}`);
  for (const b of ['Gant', 'Tommy Jeans', 'Calvin Klein Jeans', 'Eden Park', 'Serge Blanco', 'Façonnable', 'Hackett', 'American Vintage', 'Father & Sons', 'Devred', 'Armand Thiery', 'Damart', 'Bréal', 'Tex', 'In Extenso', 'Hoka', 'Saucony', 'Mizuno', 'Merrell', 'Palladium', 'Caterpillar', 'New Era', "Arc'teryx"]) {
    assert.ok(BRANDS.includes(b), `marque manquante ${b}`);
  }
  assert.ok(BRANDS.length >= 290);
});

test('canonicalBrand : orthographe de BRANDS, alias, mots décoratifs, casse propre', () => {
  const cases = [
    ['TOMMY HILFIGER', 'Tommy Hilfiger'],
    ['levis', "Levi's"],
    ['LEVI’S', "Levi's"],
    ['the northface', 'The North Face'],
    ['North Face', 'The North Face'],
    ['STUSSY', 'Stüssy'],
    ['GANT USA', 'Gant'],
    ['Sandro Paris', 'Sandro'],
    ['TOMMY HILFIGER DENIM', 'Tommy Hilfiger'],
    ['zadig et voltaire', 'Zadig & Voltaire'],
    ['h & m', 'H&M'],
    ['Dr Martens', 'Dr. Martens'],
    ["tape a l'oeil", "Tape à l'œil"],
    ['Calvin Klein Jeans', 'Calvin Klein Jeans'],
    ['ARC’TERYX', "Arc'teryx"],
    ['LA PETITE ETOILE', 'La Petite Etoile'],
    ['maison du monde', 'Maison du Monde'],
    ['NKD', 'NKD'],
    ['McQueen Studio', 'McQueen Studio'],
    ['  ', ''],
    [null, ''],
  ];
  for (const [input, want] of cases) assert.equal(canonicalBrand(input), want, String(input));
});

test('detectBrand : marques ambiguës seulement seules sur une ligne, pays ignoré', () => {
  assert.equal(detectBrand('TOMMY HILFIGER\nM\nMADE IN CHINA'), 'Tommy Hilfiger');
  assert.equal(detectBrand('LEVIS STRAUSS'), "Levi's");
  assert.equal(detectBrand('DRY CLEAN ONLY\n100% COTTON'), null);
  assert.equal(detectBrand('ONLY\nM'), 'Only');
  assert.equal(detectBrand('GORE-TEX membrane'), null);
  assert.equal(detectBrand('MADE IN JORDAN\n100% COTTON'), null);
  assert.equal(detectBrand('all rights reserved'), null);
  assert.equal(detectBrand('Lee Cooper | W32'), 'Lee Cooper');
  // Mots décoratifs de fin tolérés (« GUESS JEANS », « GAP KIDS »), pas les mots courants.
  assert.equal(detectBrand('GUESS JEANS\nMADE IN TUNISIA'), 'Guess');
  assert.equal(detectBrand('SELECTED HOMME | L'), 'Selected');
  assert.equal(detectBrand('GAP KIDS'), 'Gap');
  assert.equal(detectBrand('guess who'), null);
  assert.equal(detectBrand('pieces of cloth'), null);
});

test('detectBrandFuzzy : erreurs d’OCR reconnues', () => {
  const ok = [
    ['TOMMY = HILFIGER\nM', 'Tommy Hilfiger'],
    ['T0MMY HILFICER', 'Tommy Hilfiger'],
    ['TOMMY E HILFIGER', 'Tommy Hilfiger'],
    ['LAC0STE', 'Lacoste'],
    ['Ralph Laurcn', 'Ralph Lauren'],
    ['PETIT BATEAV', 'Petit Bateau'],
    ['ABERCR0MBIE', 'Abercrombie & Fitch'],
    ['NAPAPIJRl', 'Napapijri'],
    ['the n0rth face', 'The North Face'],
    ['SUPERDRV', 'Superdry'],
  ];
  for (const [text, want] of ok) assert.equal(detectBrandFuzzy(text), want, text);
});

test('detectBrandFuzzy : pas de faux positif sur des étiquettes d’entretien et des mots courants', () => {
  const corpus = [
    'MADE IN CHINA RN 77806 CA 00474 100% COTTON MACHINE WASH COLD WITH LIKE COLORS TUMBLE DRY LOW DO NOT BLEACH',
    'Lavage en machine à 30° ne pas utiliser de sèche-linge repassage doux ne pas nettoyer à sec composition polyester viscose élasthanne doublure',
    'Hecho en Bangladesh 95% algodón 5% elastano lavar a máquina no usar lejía',
    'Prodotto in Italia lavare a mano non candeggiare 70% lana 30% poliammide',
    'Hergestellt in der Türkei 100% Baumwolle Maschinenwäsche nicht im Trockner trocknen',
    'MADE IN COLOMBIA MADE IN CAMBODIA MADE IN PORTUGAL FABRIQUÉ EN TUNISIE',
    'salmon pink saumon channel chapel herbes lancer primary promo converses fossile diesels absorbe orchestre',
    'size M taille 38 EUR 40 UK 12 US 8 IT 44 cm 170/88A',
    'polyamide acrylique mohair alpaga cachemire mérinos laine coton lin soie',
  ];
  for (const text of corpus) assert.equal(detectBrandFuzzy(text), null, text);
  assert.equal(detectBrandFuzzy(''), null);
});

// ---------------------------------------------------------------------------
// Tailles
// ---------------------------------------------------------------------------

test('detectSizeStrict : lettre seule seulement après « taille/size… » ou sur une ligne courte', () => {
  const cases = [
    ['MADE IN U.S.A.', null],
    ["L'ÉTIQUETTE DE COMPOSITION", null],
    ['TOMMY HILFIGER\nM\nMADE IN CHINA', 'M'],
    ['TOMMY HILFIGER | M | MADE IN CHINA', 'M'],
    ['Taille : L', 'L'],
    ['size m', 'M'],
    ['Talla XL', 'XL'],
    ['Größe S', 'S'],
    ['SIZE: MEDIUM', 'M'],
    ['M / FR 40 / UK 12', 'M'],
    ['EU 42', '42'],
    ['TAILLE 38', '38'],
    ['40', null],
    ['30° lavage délicat', null],
    ['10 ANS', '10 ans'],
    ['10A', '10 ans'],
    ['18 mois', '18 mois'],
    ['W32 L34', 'W32'],
    ['ONE SIZE', 'Taille unique'],
    ['l', null],
  ];
  for (const [text, want] of cases) assert.equal(detectSizeStrict(text), want, text);
  // detectSize garde son comportement historique (texte saisi par le vendeur).
  assert.equal(detectSize('Pull taille M'), 'M');
  assert.equal(detectSize('Jean W30 L32'), 'W30');
});

test('mode gratuit : texte d’OCR réel (photo 2 du job lauraaix) → Tommy Hilfiger, M', () => {
  // Lecture Tesseract filtrée par confiance (offscreen.js) : HILFIGER illisible, TOMMY et M nets.
  const ocr = '17,\n=\n1%\nté\nad\n7\n»\n«\nNN\n$\nA\n7\nTOMMY\nM\nMADE\nCHINA\nvale';
  assert.equal(detectBrand(ocr) || detectBrandFuzzy(ocr), 'Tommy Hilfiger');
  assert.equal(detectSizeStrict(ocr, { anchored: true }), 'M');
  // Lettres isolées lues dans la texture du tissu, loin de toute étiquette : pas de taille.
  assert.equal(detectSizeStrict('fl\nBi\n8\nA\n;\na\n7\n7\nN\nS\nN', { anchored: true }), null);
  assert.equal(detectSizeStrict('xx\nS\nAR\nRNA\nLi\nqq\nTOMMY\nvv\nM\nMADE IN CHINA', { anchored: true }), 'M');
  assert.equal(detectBrandFuzzy('TOMNY'), null); // alias court : égalité stricte seulement
});

// ---------------------------------------------------------------------------
// Fusion
// ---------------------------------------------------------------------------

test('mergeFields : saisie > IA > local, marque à la bonne orthographe, champs attendus', () => {
  const ai = normalizeAiResult({ brand: '', size: 'M', category: 'Pulls', rayon: 'Femmes', colors: ['marine'], title: 'Pull à pois marine', description: 'Joli pull.', defects: '' });
  const local = { brand: 'TOMMY HILFIGER', size: 'L', colors: ['Noir'], materials: ['Coton'] };
  const f = mergeFields({ hints: { price: '18', rayon: 'Femmes' }, ai, local, defaults: { condition: 'Bon état' } });
  for (const k of ['rayon', 'category', 'categoryPath', 'brand', 'size', 'colors', 'materials', 'condition', 'package', 'title', 'aiBody', 'notes', 'keywords', 'price']) assert.ok(k in f, k);
  assert.equal(f.brand, 'Tommy Hilfiger');
  assert.equal(f.size, 'M');
  assert.deepEqual(f.colors, ['Marine']);
  assert.deepEqual(f.materials, ['Coton']);
  assert.equal(f.condition, 'Bon état');
  assert.equal(f.title, 'Pull à pois marine');
  assert.equal(f.aiBody, 'Joli pull.');
  assert.equal(f.price, '18');
  const typed = mergeFields({ hints: { brand: 'levis', size: '42' }, ai, local });
  assert.equal(typed.brand, "Levi's");
  assert.equal(typed.size, '42');
});

test('mergeLabelPass : complète sans écraser', () => {
  const main = { brand: '', size: 'M', materials: [], labelText: 'MADE IN CHINA', brandEvidence: '' };
  const out = mergeLabelPass(main, { brand: 'Tommy Hilfiger', size: 'L', materials: ['Coton'], labelText: 'TOMMY HILFIGER | L', brandEvidence: 'étiquette' });
  assert.equal(out.brand, 'Tommy Hilfiger');
  assert.equal(out.size, 'M');
  assert.deepEqual(out.materials, ['Coton']);
  assert.equal(out.labelText, 'MADE IN CHINA | TOMMY HILFIGER | L');
});

// ---------------------------------------------------------------------------
// Appels IA (fetch simulé)
// ---------------------------------------------------------------------------

test('presets Gemini : modèles de secours', () => {
  assert.equal(AI_PRESETS.gemini.model, 'gemini-flash-latest');
  // Modèles de secours de la v3.2.2 conservés (gemini-3.8-flash, gemini-3.5-flash-lite).
  assert.deepEqual(AI_PRESETS.gemini.fallbackModels, ['gemini-flash-lite-latest', 'gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-flash-lite']);
  assert.equal(AI_PRESETS.gemini.extra.reasoning_effort, 'low');
});

test('pickPhotosForAi : 8 photos max, étiquettes toujours incluses', () => {
  assert.deepEqual(pickPhotosForAi(3, []), [0, 1, 2]);
  assert.deepEqual(pickPhotosForAi(12, [10]), [0, 1, 2, 3, 4, 5, 6, 10]);
  assert.deepEqual(pickPhotosForAi(12, [9, 11, 99, -1]), [0, 1, 2, 3, 4, 5, 9, 11]);
});

test('recognizeItem : mode JSON, 8 images max, indices des étiquettes dans le prompt', async () => {
  const { fetchImpl, calls } = fakeFetch([{ label_text: 'GANT | L', brand: 'GANT', size: 'L', category: 'Sweats', colors: ['jaune'] }]);
  const images = pickPhotosForAi(10, [9]).map((i) => ({ url: img(i), index: i, label: i === 9 }));
  const r = await recognizeItem({ images, hints: { rayon: 'Hommes', notes: 'petite tache' }, config: GEMINI, fetchImpl });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'gemini-flash-latest');
  assert.deepEqual(calls[0].body.response_format, { type: 'json_object' });
  assert.equal(calls[0].body.reasoning_effort, 'low');
  assert.equal(calls[0].images.length, 8);
  assert.equal(calls[0].images[7], img(9));
  assert.match(calls[0].prompt, /label_text/);
  assert.match(calls[0].prompt, /image 7 comme photo d'étiquette/);
  assert.match(calls[0].prompt, /rayon : Hommes/);
  assert.match(calls[0].prompt, /petite tache/);
  assert.equal(r.brand, 'Gant');
  assert.equal(r.passes, 1);
  assert.equal(r.model, 'gemini-flash-latest');
});

test('chatWithFallback : 400 → second essai sans response_format ni paramètres optionnels (tous les fournisseurs)', async () => {
  for (const config of [GEMINI, { preset: 'custom', key: 'k', baseUrl: 'https://exemple.test/v1', model: 'mon-modele' }]) {
    const { fetchImpl, calls } = fakeFetch([{ status: 400, error: "Invalid JSON payload: unknown field 'response_format'" }, '{"ok":true}']);
    const res = await chatWithFallback(config, [{ role: 'user', content: 'test JSON' }], { fetchImpl });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].json, true);
    assert.equal(calls[1].json, false);
    assert.equal(calls[1].body.reasoning_effort, undefined);
    assert.equal(calls[1].model, calls[0].model);
    assert.equal(res.plain, true);
  }
});

test('chatWithFallback : modèle inconnu, surcharge et quota → modèle suivant ; clé refusée → arrêt', async () => {
  let f = fakeFetch([{ status: 404, error: 'models/gemini-flash-latest is not found' }, { status: 503, error: 'The model is overloaded' }, '{"ok":true}']);
  let res = await chatWithFallback(GEMINI, [{ role: 'user', content: 'x' }], { fetchImpl: f.fetchImpl });
  assert.deepEqual(f.calls.map((c) => c.model), ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-3.8-flash']);
  assert.equal(res.model, 'gemini-3.8-flash');

  f = fakeFetch([{ status: 429, error: 'Resource has been exhausted (e.g. check quota).' }, '{"ok":true}']);
  res = await chatWithFallback(GEMINI, [{ role: 'user', content: 'x' }], { fetchImpl: f.fetchImpl });
  assert.equal(res.quotaHit, true);
  assert.equal(res.model, 'gemini-flash-lite-latest');

  f = fakeFetch([{ status: 429, error: 'quota' }]);
  await assert.rejects(chatWithFallback(GEMINI, [{ role: 'user', content: 'x' }], { fetchImpl: f.fetchImpl }), (e) => e.code === 'quota' && /^Quota IA atteint/.test(e.message));
  assert.equal(f.calls.length, 6);

  f = fakeFetch([{ status: 400, error: [{ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } }] }]);
  await assert.rejects(chatWithFallback(GEMINI, [{ role: 'user', content: 'x' }], { fetchImpl: f.fetchImpl }), (e) => e.code === 'auth' && /^Clé IA refusée/.test(e.message));
  assert.equal(f.calls.length, 1);

  await assert.rejects(chatWithFallback({ preset: 'gemini', key: '' }, [], {}), (e) => e.code === 'no-key');
});

test('chatWithFallback : délai dépassé → message clair', async () => {
  const fetchImpl = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  await assert.rejects(chatWithFallback(GEMINI, [{ role: 'user', content: 'x' }], { fetchImpl, timeoutMs: 30 }), (e) => e.code === 'timeout' && e.message === "L'IA n'a pas répondu à temps");
});

test('recognizeItem : réponse illisible', async () => {
  const { fetchImpl } = fakeFetch(['Désolé, je ne peux pas.']);
  await assert.rejects(recognizeItem({ images: [img(0)], config: GEMINI, fetchImpl }), (e) => e.code === 'parse' && e.message === "Réponse de l'IA illisible");
});

test('recognizeItem : seconde passe « étiquette » (photos HD), fusion sans écraser', async () => {
  const { fetchImpl, calls } = fakeFetch([
    { label_text: 'MADE IN CHINA', label_photos: [1], brand: '', size: 'S', category: 'Pulls', colors: ['marine'], title: 'Pull à pois' },
    { label_text: 'TOMMY HILFIGER | M', brand: 'TOMMY HILFIGER', size: 'M', materials: ['coton'] },
  ]);
  const asked = [];
  const images = [0, 1, 2].map((i) => ({ url: img(i), index: i, label: false }));
  const r = await recognizeItem({
    images,
    hints: {},
    config: GEMINI,
    fetchImpl,
    labelImages: async (idx) => {
      asked.push(...idx);
      return idx.map((i) => `data:image/jpeg;base64,HD${i}`);
    },
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(asked, [1]);
  assert.deepEqual(calls[1].images, ['data:image/jpeg;base64,HD1']);
  assert.equal(calls[1].json, true);
  assert.match(calls[1].prompt, /ÉTIQUETTES/);
  assert.equal(r.passes, 2);
  assert.equal(r.brand, 'Tommy Hilfiger');
  assert.equal(r.brandEvidence, 'étiquette');
  assert.equal(r.size, 'S'); // valeur de la passe principale conservée
  assert.deepEqual(r.materials, ['Coton']);
  assert.deepEqual(r.labelPhotos, [1]);
  assert.match(r.labelText, /TOMMY HILFIGER/);
});

test('recognizeItem : photos marquées par le vendeur → seconde passe, indices d’origine', async () => {
  const { fetchImpl, calls } = fakeFetch([{ brand: '', size: '', label_photos: [] }, { brand: 'Gant', size: 'XL' }]);
  const images = [{ url: img(0), index: 0 }, { url: img(4), index: 4, label: true }];
  const r = await recognizeItem({ images, config: GEMINI, fetchImpl });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].images, [img(4)]);
  assert.equal(r.passes, 2);
  assert.equal(r.brand, 'Gant');
  assert.equal(r.size, 'XL');
});

test('recognizeItem : pas de seconde passe si marque et taille connues, ou après un quota', async () => {
  let f = fakeFetch([{ brand: 'Nike', size: '42', label_photos: [0] }]);
  let r = await recognizeItem({ images: [img(0)], config: GEMINI, fetchImpl: f.fetchImpl });
  assert.equal(f.calls.length, 1);
  assert.equal(r.passes, 1);

  // Le vendeur a saisi marque et taille : inutile de relire.
  f = fakeFetch([{ brand: '', size: '', label_photos: [0] }]);
  r = await recognizeItem({ images: [img(0)], hints: { brand: 'Zara', size: 'S' }, config: GEMINI, fetchImpl: f.fetchImpl });
  assert.equal(f.calls.length, 1);

  // 429 sur le premier modèle, le suivant répond : pas de seconde passe.
  f = fakeFetch([{ status: 429, error: 'quota' }, { brand: '', size: '', label_photos: [0] }, { brand: 'Gant' }]);
  r = await recognizeItem({ images: [img(0)], config: GEMINI, fetchImpl: f.fetchImpl });
  assert.equal(f.calls.length, 2);
  assert.equal(r.passes, 1);
  assert.equal(r.quotaHit, true);
  assert.equal(r.brand, '');

  // 429 pendant la seconde passe : on garde le résultat principal, sans changer de modèle.
  f = fakeFetch([{ brand: '', size: 'M', label_photos: [0], category: 'Pulls' }, { status: 429, error: 'quota' }, { brand: 'Gant' }]);
  r = await recognizeItem({ images: [img(0)], config: GEMINI, fetchImpl: f.fetchImpl });
  assert.equal(f.calls.length, 2);
  assert.equal(r.passes, 1);
  assert.equal(r.category, 'Pulls');
  assert.match(r.labelError, /^Quota IA atteint/);
});

test('buildPrompt : liste fermée des catégories et règles de désambiguïsation', () => {
  const p = buildPrompt({ brand: 'Gant', size: 'M' }, { count: 3, labelImages: [0, 2] });
  assert.match(p, /liste fermée/);
  assert.match(p, /"Pulls"/);
  assert.match(p, /"Gilets"/);
  assert.match(p, /marque : Gant ; taille : M/);
  assert.match(p, /images 0 et 2 comme photos d'étiquette/);
  assert.match(p, /numérotées de 0 à 2/);
});

// ---------------------------------------------------------------------------
// Divers
// ---------------------------------------------------------------------------

test('couleur : bleu marine photographié ≠ noir', () => {
  assert.equal(nearestVintedColor([42, 46, 56]), 'Marine');
  assert.equal(nearestVintedColor([30, 32, 38]), 'Noir');
  assert.equal(nearestVintedColor([12, 12, 14]), 'Noir');
  // Dominante bleue de toute la photo (fond neutre bleuté) : on ne conclut pas au marine.
  assert.equal(nearestVintedColor([42, 46, 56], { castB: -6 }), 'Noir');
  // Ombre d'un pull marine : une seule couleur, mais noir + gris restent deux couleurs.
  assert.deepEqual(pickListingColors([{ name: 'Marine', share: 0.6 }, { name: 'Noir', share: 0.35 }]), ['Marine']);
  assert.deepEqual(pickListingColors([{ name: 'Noir', share: 0.6 }, { name: 'Gris', share: 0.35 }]), ['Noir', 'Gris']);
});

test('jpegDims : dimensions lues dans l’en-tête JPEG', () => {
  const bytes = [
    0xff, 0xd8, // SOI
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, // APP0
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x06, 0x40, 0x04, 0xb0, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, // SOF0 1600×1200
  ];
  assert.deepEqual(jpegDims(Buffer.from(bytes).toString('base64')), { width: 1200, height: 1600 });
  assert.equal(jpegDims(Buffer.from('pas une image').toString('base64')), null);
  assert.equal(jpegDims(''), null);
});

test('ocrImages : un OCR figé (packs de langue injoignables) abandonne au lieu de bloquer le robot', async () => {
  const prev = globalThis.chrome;
  globalThis.chrome = {
    runtime: {
      getURL: (p) => `chrome-extension://test/${p}`,
      getContexts: async () => [{ contextType: 'OFFSCREEN_DOCUMENT' }],
      sendMessage: () => new Promise(() => {}), // le document offscreen ne répond jamais
    },
  };
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let settled = false;
    const outcome = ocrImages(['data:image/jpeg;base64,AAAA'])
      .then(() => 'résolu', (e) => e.message)
      .finally(() => (settled = true));
    const flush = async () => {
      for (let i = 0; i < 10; i += 1) await Promise.resolve(); // laisse ensureOffscreen() se terminer
    };
    await flush();
    mock.timers.tick(69999); // 60 s + 10 s par image
    await flush();
    assert.equal(settled, false);
    mock.timers.tick(1);
    assert.match(await outcome, /^OCR trop long/);
  } finally {
    mock.timers.reset();
    globalThis.chrome = prev;
  }
});
