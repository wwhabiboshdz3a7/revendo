/**
 * Revendo — tests de la reconnaissance SANS IA : marques (orthographe,
 * détection tolérante à l'OCR, base élargie), tailles, indices lus sur les
 * étiquettes (rayon, jean, ticket), indices de catégorie par marque,
 * candidats « marque » à vérifier sur Vinted, fusion, couleurs (vote), et la
 * chaîne complète analyzePhotos avec une lecture d'étiquettes simulée.
 * Sans réseau ni navigateur. Lancement : node --test tools/test/*.test.mjs
 */
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { analyzePhotos, jpegDims, ocrPhoto, readLabels } from '../../extension/background/recognize.js';
import { nearestVintedColor, pickListingColors, voteColors } from '../../extension/shared/colors.js';
import { decodeConnection, encodeConnection } from '../../extension/shared/config.js';
import { utf8ToBase64 } from '../../extension/shared/relay.js';
import {
  brandCandidates,
  brandHints,
  buildDescription,
  canonicalBrand,
  categoryHints,
  detectBrand,
  detectBrandFuzzy,
  detectSize,
  detectSizeStrict,
  labelClues,
  mergeFields,
  normalizeSize,
} from '../../extension/shared/listing.js';
import { BRAND_ALIASES, BRAND_AMBIGUOUS, BRAND_HINTS, BRANDS } from '../../extension/shared/vinted-data.js';

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
  assert.ok(BRANDS.length >= 700, `base de marques : ${BRANDS.length}`);
  for (const group of BRAND_HINTS) for (const b of group.brands) assert.ok(BRANDS.includes(b), `indice de catégorie ${b}`);
  // Sous-lignes ramenées à la marque mère, jamais une marque à part.
  for (const sub of ['Nike Air', 'Asics Tiger', 'Longchamp Le Pliage']) assert.ok(!BRANDS.includes(sub), sub);
  assert.equal(canonicalBrand('NIKE AIR'), 'Nike');
  assert.equal(canonicalBrand('herschel supply co'), 'Herschel');
});

test('base élargie : marques fréquentes sur Vinted détectées, mots courants seulement seuls sur une ligne', () => {
  assert.equal(detectBrand('SÉZANE\nMADE IN PORTUGAL'), 'Sézane');
  assert.equal(detectBrand("MARC O'POLO | 100% COTTON"), "Marc O'Polo");
  assert.equal(detectBrand('Massimo Dutti'), 'Massimo Dutti');
  assert.equal(detectBrand('JACQUELINE DE YONG'), 'Jacqueline de Yong');
  assert.equal(detectBrand('next day delivery'), null);
  assert.equal(detectBrand('NEXT\n12'), 'Next');
  assert.equal(detectBrand('Kinder 104'), null); // « enfants » en allemand
  assert.equal(detectBrand('ripstop element'), null);
  assert.equal(detectBrandFuzzy('PARAJUMPERS'), 'Parajumpers');
  assert.equal(detectBrandFuzzy('BIRKENST0CK'), 'Birkenstock');
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
    // Bruit collé au mot par l'OCR (étiquette tissée floue, drapeau lu comme une lettre).
    ['TOMMYn', 'Tommy Hilfiger'],
    ['TOMMYyA - M', 'Tommy Hilfiger'],
  ];
  for (const [text, want] of ok) assert.equal(detectBrandFuzzy(text), want, text);
});

test('vrais textes d’OCR à moitié lus : marque en deux moitiés, barre de taille lue « # »', () => {
  // Annonce 291l : bord de l'étiquette coupé.
  assert.equal(detectBrandFuzzy('ve\nhd\n1e Ser\n=\nNes\nACK\nSEAN\n\'OMMY = HIL'), 'Tommy Hilfiger');
  assert.equal(detectBrandFuzzy('ALVIN KLE'), 'Calvin Klein');
  for (const t of ['OMMY', 'hommy hilton', 'SMMy o', '100% COTON LAVAGE 30']) assert.equal(detectBrandFuzzy(t), null, t);
  // Annonce i9vk : « S/P » lu « S#P » au-dessus de « CHINA ».
  assert.equal(detectSizeStrict('y\nA\nDe\nWh\n7\n-\nS#P\nCHINA', { anchored: true }), 'S');
  assert.equal(detectSizeStrict('TOMMY\nM#G', { anchored: true }), null);
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

test('detectSizeStrict : étiquettes bilingues (L/G, S/P, XL TG/XG, 2X) ; paires incohérentes refusées', () => {
  const ok = [
    ['TOMMY HILFIGER\nL/G\nMADE IN CHINA', 'L'],
    ['S/P\n100% COTON', 'S'],
    ['TOMMY HILFIGER\nXL TG/XG', 'XL'],
    ['TOMMY HILFIGER\nXL\nTG', 'XL'],
    ['RN 77806 CA 34056\nL / G', 'L'],
    ['TOMMY HILFIGER\n2X', 'XXL'],
    ['TOMMY HILFIGER\nTG/XG', 'XL'],
  ];
  for (const [text, want] of ok) assert.equal(detectSizeStrict(text, { anchored: true }), want, text);
  const ko = ['TOMMY HILFIGER\nM/G', 'TOMMY HILFIGER\nG', 'TOMMY HILFIGER\nP', 'MADE IN CHINA\nS/G'];
  for (const text of ko) assert.equal(detectSizeStrict(text, { anchored: true }), null, text);
  assert.equal(normalizeSize('L/G'), 'L');
  assert.equal(normalizeSize('S/P'), 'S');
});

test('tailles bilingues : âge et « taille : » prioritaires, grille ignorée, formes Vinted, pas de faux « P P »', () => {
  const cases = [
    ['TOMMY HILFIGER\n10 ANS\nM/M', '10 ans'],
    ['CARTERS\n3 MOIS\nS/P', '3 mois'],
    ['TOMMY HILFIGER\nTAILLE/SIZE: XL\nM/M', 'XL'],
    ['TOMMY HILFIGER\nXS/TP S/P M/M L/G XL/TG', null],
    ['TOMMY HILFIGER\n2XL/TTG', 'XXL'],
    ['TOMMY HILFIGER\n2XL', 'XXL'],
    ['100% COTON\nP / P', null],
    ['MADE IN CHINA\nG G', null],
    ['MADE IN PORTUGAL\nP/CH', null],
  ];
  for (const [text, want] of cases) assert.equal(detectSizeStrict(text, { anchored: true }), want, text);
  const norm = [['2XL', 'XXL'], ['3XL', 'XXXL'], ['2X', 'XXL'], ['TG', 'XL'], ['TG/XG', 'XL'], ['M/G', 'M/G'], ['S/M', 'S/M'], ['M/L', 'M/L'], ['G', 'G'], ['4XL', '4XL']];
  for (const [v, want] of norm) assert.equal(normalizeSize(v), want, v);
});

test('texte d’OCR réel (photo 2 du job lauraaix) → Tommy Hilfiger, M', () => {
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
// Indices lus sur les étiquettes
// ---------------------------------------------------------------------------

test('labelClues : rayon, jean, ticket de prix / code-barres', () => {
  assert.equal(labelClues('XL TG/XG MADE IN CHINA').rayon, '');
  assert.equal(labelClues('WOMEN | 38').rayon, 'Femmes');
  assert.equal(labelClues("MEN'S | L").rayon, 'Hommes');
  assert.equal(labelClues('10 ANS 140 CM').rayon, 'Enfants');
  assert.equal(labelClues('18 mois').rayon, 'Enfants');
  assert.equal(labelClues('KIDS').rayon, 'Enfants');
  assert.equal(labelClues('women and men').rayon, '');
  assert.deepEqual(labelClues('W32 L34').words, ['jeans', 'jean']);
  assert.equal(labelClues('W32 L34').search, 'Jeans');
  assert.equal(labelClues('PRIX 29,99 €').newWithTag, true);
  assert.equal(labelClues('EUR 35.00').newWithTag, true);
  assert.equal(labelClues('3608077012345').newWithTag, true);
  // Mètre ruban, températures de lavage, RN : pas un ticket.
  assert.equal(labelClues('40 41 42 43 44 45 46 47 48 49 50').newWithTag, false);
  assert.equal(labelClues('30° RN 77806 CA 00474').newWithTag, false);
});

test('categoryHints : rayon saisi > étiquette > marque ; mots et terme de recherche', () => {
  assert.deepEqual(categoryHints({ brand: 'Converse' }), { rayon: '', words: ['chaussures', 'baskets', 'sneakers'], search: 'Baskets' });
  assert.equal(categoryHints({ brand: 'Jacadi' }).rayon, 'Enfants');
  assert.equal(categoryHints({ brand: 'Jacadi', rayon: 'Femmes' }).rayon, 'Femmes');
  assert.equal(categoryHints({ text: 'WOMEN', brand: 'Lego' }).rayon, 'Femmes');
  assert.equal(categoryHints({ brand: 'Longchamp' }).words[0], 'sacs');
  assert.equal(categoryHints({ text: 'W30 L32', brand: "Levi's" }).search, 'Jeans');
  assert.deepEqual(categoryHints({ brand: 'Tommy Hilfiger' }), { rayon: '', words: [], search: '' });
  assert.equal(brandHints('ugg')?.search, 'Bottes');
  assert.equal(brandHints(''), null);
});

test('brandCandidates : texte le plus gros et net, sans mots d’étiquette ni tailles', () => {
  const lines = [
    { text: 'MADE IN', h: 12, conf: 91 },
    { text: 'CHINA', h: 12, conf: 95 },
    { text: 'SÉZANE', h: 30, conf: 90 },
    { text: '100% COTTON', h: 10, conf: 90 },
    { text: 'XL', h: 20, conf: 95 },
    { text: 'MAISON KITSUNÉ', h: 22, conf: 88 },
    { text: 'Wash at 30', h: 9, conf: 92 },
    { text: 'BLURRY', h: 40, conf: 50 },
    { text: 'RN 77806', h: 10, conf: 95 },
  ];
  assert.deepEqual(brandCandidates(lines), ['Sézane', 'Maison Kitsuné']);
  assert.deepEqual(brandCandidates([]), []);
  assert.deepEqual(brandCandidates([{ text: 'MADE IN CHINA', h: 30, conf: 99 }]), []);
});

test('normalizeSize : format Vinted', () => {
  assert.equal(normalizeSize('xl'), 'XL');
  assert.equal(normalizeSize('10Y'), '10 ans');
  assert.equal(normalizeSize('W32 L34'), 'W32');
  assert.equal(normalizeSize('EU 38,5'), '38,5');
  assert.equal(normalizeSize('one size'), 'Taille unique');
  assert.equal(normalizeSize(''), '');
});

// ---------------------------------------------------------------------------
// Fusion et description
// ---------------------------------------------------------------------------

test('mergeFields : saisie > étiquette > défauts, marque à la bonne orthographe', () => {
  const local = { brand: 'TOMMY HILFIGER', size: 'm', colors: ['Marine'], materials: ['Coton'], rayon: 'Femmes', condition: 'Neuf avec étiquette' };
  const f = mergeFields({ hints: { price: '18' }, local, defaults: { condition: 'Bon état' } });
  for (const k of ['rayon', 'category', 'categoryPath', 'brand', 'size', 'colors', 'materials', 'condition', 'package', 'title', 'notes', 'keywords', 'price']) assert.ok(k in f, k);
  assert.equal(f.brand, 'Tommy Hilfiger');
  assert.equal(f.size, 'M');
  assert.deepEqual(f.colors, ['Marine']);
  assert.deepEqual(f.materials, ['Coton']);
  assert.equal(f.rayon, 'Femmes');
  assert.equal(f.condition, 'Neuf avec étiquette');
  assert.equal(f.category, '');
  assert.equal(f.title, ''); // composé sur Vinted, une fois la catégorie choisie
  assert.equal(f.price, '18');
  const typed = mergeFields({ hints: { brand: 'levis', size: '42', condition: 'Satisfaisant', rayon: 'Hommes' }, local });
  assert.equal(typed.brand, "Levi's");
  assert.equal(typed.size, '42');
  assert.equal(typed.condition, 'Satisfaisant');
  assert.equal(typed.rayon, 'Hommes');
  assert.equal(mergeFields({ local: { condition: '' } }).condition, 'Très bon état');
});

test('buildDescription : texte composé uniquement avec les infos connues', () => {
  const d = buildDescription({ title: 'Pull Tommy Hilfiger marine taille M', brand: 'Tommy Hilfiger', size: 'M', colors: ['Marine'], condition: 'Très bon état' }, { hashtags: 5, rand: () => 0 });
  assert.match(d, /Je vends ce pull Tommy Hilfiger marine taille M\./);
  assert.match(d, /📏 Taille : M/);
  assert.doesNotMatch(d, /undefined|null/);
});

// ---------------------------------------------------------------------------
// Couleurs
// ---------------------------------------------------------------------------

test('voteColors : plusieurs photos, la première compte davantage ; marine dans l’ombre ≠ noir', () => {
  // Job lauraaix (pull marine à pois) : photos 1, 3 et 4, mesurées sur les vraies photos.
  const votes = [
    { colors: [{ name: 'Marine', share: 0.43 }, { name: 'Noir', share: 0.32 }, { name: 'Kaki', share: 0.15 }, { name: 'Crème', share: 0.1 }], weight: 1.5 },
    { colors: [{ name: 'Marine', share: 0.48 }, { name: 'Noir', share: 0.41 }, { name: 'Beige', share: 0.08 }], weight: 1 },
    { colors: [{ name: 'Noir', share: 0.49 }, { name: 'Beige', share: 0.29 }, { name: 'Marron', share: 0.12 }], weight: 1 },
  ];
  assert.deepEqual(pickListingColors(voteColors(votes)), ['Marine']);
  // Un vrai noir donne très peu de marine.
  assert.deepEqual(pickListingColors([{ name: 'Noir', share: 0.8 }, { name: 'Marine', share: 0.12 }]), ['Noir']);
  assert.deepEqual(voteColors([]), []);
  assert.deepEqual(voteColors([{ colors: [], weight: 2 }]), []);
});

// ---------------------------------------------------------------------------
// Chaîne complète (lecture d'étiquettes simulée)
// ---------------------------------------------------------------------------

const photos = (n) => Array.from({ length: n }, (_, i) => ({ base64: `PHOTO${i}`, mime: 'image/jpeg' }));

/** Lecture simulée : texts[i] = texte lu sur la photo i ; lines[i] = lignes rapprochées ; fail[i] = erreur. */
function fakeRead(texts, { lines = {}, fail = {} } = {}) {
  const calls = [];
  const read = async (image, opts) => {
    const i = Number(/PHOTO(\d+)/.exec(image)?.[1]);
    calls.push({ i, ...opts });
    if (fail[i]) throw new Error(fail[i]);
    return { text: texts[i] || '', score: texts[i] ? 12 : 0, lines: lines[i] || [], regions: 1 };
  };
  return { read, calls };
}

const deps = (read) => ({ read, colors: async () => ['Marine'], prepare: async (p) => `data:image/jpeg;base64,${p.base64}` });

test('analyzePhotos : étiquettes marquées d’abord, arrêt dès marque + taille', async () => {
  const { read, calls } = fakeRead({ 3: 'TOMMY\nM\nMADE IN CHINA', 4: 'EUR 49,90' });
  const { fields, recognition } = await analyzePhotos(
    { photos: photos(5), hints: { labelIndexes: [3], price: '18', rayon: 'Femmes' }, settings: { worker: { defaultCondition: 'Très bon état' } } },
    deps(read),
  );
  assert.deepEqual(calls.map((c) => c.i), [3]); // étiquette marquée lue d'abord : marque + taille trouvées, on s'arrête
  assert.equal(calls[0].label, true);
  assert.ok(calls[0].deadline > Date.now());
  assert.equal(fields.brand, 'Tommy Hilfiger');
  assert.equal(fields.size, 'M');
  assert.deepEqual(fields.colors, ['Marine']);
  assert.equal(fields.condition, 'Très bon état');
  assert.deepEqual(fields.categoryHints, { rayon: 'Femmes', words: [], search: '' });
  assert.deepEqual(fields.brandCandidates, []);
  assert.deepEqual(recognition.found, { brand: 'étiquette', size: 'étiquette', materials: '', rayon: 'saisie', condition: '', colors: 'photos' });
  assert.equal(recognition.mode, 'auto');
  assert.deepEqual(recognition.ocr, { photos: 1, error: '' });
});

test('analyzePhotos : ticket → neuf avec étiquette ; marque spécialisée → indices ; marque inconnue → candidats', async () => {
  const { read, calls } = fakeRead({ 0: 'PRIX 129,00 €', 1: 'POLÈNE\nMADE IN SPAIN' });
  const r1 = await analyzePhotos({ photos: photos(3), hints: {}, settings: {} }, deps(read));
  assert.deepEqual(calls.map((c) => c.i), [0, 1, 2]); // pas de taille lue : toutes les photos sont lues
  assert.equal(r1.fields.brand, 'Polène'); // marque de la base élargie, lue directement
  assert.equal(r1.fields.condition, 'Neuf avec étiquette');
  assert.equal(r1.recognition.found.condition, 'étiquette');
  assert.deepEqual(r1.fields.categoryHints.words.slice(0, 2), ['sacs', 'sac']);

  const { read: read2 } = fakeRead({ 1: 'MAISON INCONNUE\n38' }, { lines: { 1: [{ text: 'MAISON INCONNUE', h: 26, conf: 90 }] } });
  const r2 = await analyzePhotos({ photos: photos(3), hints: { condition: 'Bon état' }, settings: {} }, deps(read2));
  assert.equal(r2.fields.brand, '');
  assert.deepEqual(r2.fields.brandCandidates, ['Maison Inconnue']);
  assert.equal(r2.fields.condition, 'Bon état');
});

test('analyzePhotos : saisie prioritaire, lecture coupée dans les réglages, moteur en panne', async () => {
  const { read, calls } = fakeRead({ 0: 'NIKE\nL' });
  const typed = await analyzePhotos({ photos: photos(2), hints: { brand: 'adidas', size: '38' }, settings: { worker: { ocr: false } } }, deps(read));
  assert.equal(calls.length, 0);
  assert.equal(typed.fields.brand, 'Adidas');
  assert.equal(typed.fields.size, '38');
  assert.equal(typed.recognition.found.brand, 'saisie');

  const { read: broken, calls: tried } = fakeRead({}, { fail: { 0: 'moteur absent' } });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const r = await analyzePhotos({ photos: photos(2), hints: {}, settings: {} }, deps(broken));
    assert.equal(tried.length, 1); // le moteur ne démarre pas : on n'insiste pas
    assert.equal(r.recognition.ocr.error, 'moteur absent');
    assert.equal(r.fields.brand, '');
  } finally {
    console.warn = warn;
  }
});

test('readLabels : marque, taille, matières et indices d’un texte d’étiquettes', () => {
  const r = readLabels('LACOSTE\nTAILLE 4\n80% COTON 20% POLYESTER\nWOMEN');
  assert.equal(r.brand, 'Lacoste');
  assert.deepEqual(r.materials, ['Coton', 'Polyester']);
  assert.equal(r.clues.rayon, 'Femmes');
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


test('ocrPhoto : un moteur figé abandonne au lieu de bloquer le robot', async () => {
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
    const outcome = ocrPhoto('data:image/jpeg;base64,AAAA')
      .then(() => 'résolu', (e) => e.message)
      .finally(() => (settled = true));
    const flush = async () => {
      for (let i = 0; i < 10; i += 1) await Promise.resolve(); // laisse ensureOffscreen() se terminer
    };
    await flush();
    mock.timers.tick(59999);
    await flush();
    assert.equal(settled, false);
    mock.timers.tick(1);
    assert.match(await outcome, /trop longue/);
  } finally {
    mock.timers.reset();
    globalThis.chrome = prev;
  }
});

test('code de connexion : relais seulement ; un ancien code avec clé IA reste accepté', () => {
  const relay = { owner: 'o', repo: 'r', branch: 'main', token: 'tok' };
  const code = encodeConnection({ relay, name: 'Elias' });
  assert.deepEqual(decodeConnection(code), { relay, name: 'Elias' });
  const b64 = (o) => utf8ToBase64(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.deepEqual(decodeConnection(`REV1.${b64({ v: 1, gh: relay, ai: { preset: 'gemini', key: 'cle' } })}`), { relay, name: '' });
  assert.doesNotMatch(Buffer.from(code.slice(5).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(), /"ai"/);
});
