/**
 * Revendo — composition d'annonce (titre, description, hashtags) et détections
 * textuelles SANS IA (taille, marque, matières, indices de catégorie lus sur
 * les étiquettes). Fonctions pures, testables en Node.
 */
import {
  BRAND_ALIASES,
  BRAND_AMBIGUOUS,
  BRAND_HINTS,
  BRANDS,
  CATEGORY_DEFS,
  COLOR_NAMES,
  COLOR_SYNONYMS,
  CONDITIONS,
  GENERIC_HASHTAGS,
  MATERIAL_SYNONYMS,
  MATERIALS,
  RAYONS,
  RAYON_TAGS,
} from './vinted-data.js';

// ---------------------------------------------------------------------------
// Texte
// ---------------------------------------------------------------------------

export function normalize(str) {
  return (str || '')
    .toString()
    .toLowerCase()
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’‘ʼ´`]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function slug(str) {
  return normalize(str).replace(/[^a-z0-9]/g, '');
}

export function pick(arr, rand = Math.random) {
  return arr[Math.floor(rand() * arr.length)];
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** « bleu marine » → « Marine », « navy » → « Marine », « Bleu » → « Bleu ». */
export function normalizeColor(value) {
  const v = normalize(value).replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!v) return null;
  const direct = COLOR_NAMES.find((c) => normalize(c) === v);
  if (direct) return direct;
  for (const [words, name] of COLOR_SYNONYMS) if (words.includes(v)) return name;
  // Couleur composée (« pull gris chiné ») : on cherche le synonyme le plus long contenu.
  let best = null;
  let bestLen = 0;
  for (const [words, name] of COLOR_SYNONYMS) {
    for (const w of words) {
      if (w.length > bestLen && new RegExp(`(^| )${w}( |$)`).test(v)) {
        best = name;
        bestLen = w.length;
      }
    }
  }
  return best;
}

/** Valeur la plus proche dans une liste fermée (insensible casse/accents). */
export function matchVocab(value, vocab) {
  const v = normalize(value);
  if (!v) return null;
  const exact = vocab.find((x) => normalize(x) === v);
  if (exact) return exact;
  const starts = vocab.find((x) => normalize(x).startsWith(v) || v.startsWith(normalize(x)));
  return starts || null;
}

// ---------------------------------------------------------------------------
// Prix
// ---------------------------------------------------------------------------

export function parsePrice(raw) {
  const cleaned = String(raw ?? '')
    .replace(/\s|€|eur/gi, '')
    .replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const n = Math.round(parseFloat(cleaned) * 100) / 100;
  return n > 0 && n < 100000 ? n : null;
}

export function formatPriceFR(n) {
  return `${n.toFixed(2).replace('.', ',')} €`;
}

// ---------------------------------------------------------------------------
// Catégorie
// ---------------------------------------------------------------------------

export function findCategoryDef(text) {
  const t = ` ${normalize(text)} `;
  if (!t.trim()) return null;
  const exact = CATEGORY_DEFS.find((d) => normalize(d.kw) === t.trim() || normalize(d.title) === t.trim());
  if (exact) return exact;
  let best = null;
  let bestLen = 0;
  for (const def of CATEGORY_DEFS) {
    for (const m of def.match) {
      const nm = normalize(m);
      const rx = new RegExp(`(^|[^a-z0-9])${nm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
      if (rx.test(t) && nm.length > bestLen) {
        best = def;
        bestLen = nm.length;
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Détections (OCR d'étiquette / texte libre)
// ---------------------------------------------------------------------------

export function detectSize(text) {
  if (!text) return null;
  const t = ` ${text.replace(/\s+/g, ' ')} `;
  let m = t.match(/\bW\s?(\d{2})\s*[\/x]?\s*L\s?(\d{2})\b/i);
  if (m) return `W${m[1]}`;
  m = t.match(/(?:^|[^A-Za-z0-9])(XXS|XS|S|M|L|XL|XXL|XXXL|[2-6]XL)(?:$|[^A-Za-z0-9])/);
  if (m) return m[1].toUpperCase();
  m = t.match(/\b(?:taille|size|tg|t\.)\s*:?\s*(\d{2}(?:[.,]5)?)\b/i);
  if (m) return m[1].replace('.', ',');
  m = t.match(/\b(?:pointure|eu|fr)\s*:?\s*(\d{2}(?:[.,]5)?)\b/i);
  if (m) return m[1].replace('.', ',');
  m = t.match(/\b(\d{1,2})\s*(ans|years|yrs|an)\b/i);
  if (m) return `${m[1]} ans`;
  m = t.match(/\b(\d{1,2})\s*mois\b/i);
  if (m) return `${m[1]} mois`;
  return null;
}

const LETTER_SIZE = '(?:XXXS|XXS|XS|S|M|L|XL|XXL|XXXL|[2-6]XL)';
const LETTER_TOKEN = /^(?:XXXS|XXS|XS|S|M|L|XL|XXL|XXXL|[2-6]XL)$/; // majuscules seulement (bruit OCR « l », « s »)
const SIZE_WORDS = '(?:taille|size|sz|talla|taglia|tamanho|maat|rozmiar|gr(?:ö|o|oe)(?:ß|ss)e|tg|pointure)';
const WORD_SIZES = { xsmall: 'XS', extrasmall: 'XS', small: 'S', medium: 'M', large: 'L', xlarge: 'XL', extralarge: 'XL', xxlarge: 'XXL' };
const QUALIFIERS = /^(?:eu|eur|fr|it|es|de|uk|us|mx|cn|int|taille|size|t)$/i;

/**
 * Variante PRUDENTE de detectSize pour un texte d'étiquette (OCR ou
 * transcription) : une lettre seule (« M », « S », « L ») n'est retenue que si
 * elle suit un mot « taille / size / talla / größe / taglia… » ou si elle
 * occupe une ligne courte (« M », « M / 40 »), jamais au milieu d'un texte
 * (« MADE IN U.S.A. », « L'ÉTIQUETTE »…). Un nombre seul (« 40 », souvent une
 * température de lavage) exige un qualificatif (« FR 40 », « EU 42 », « taille 38 »).
 * opts.anchored (texte d'OCR bruité) : la ligne courte doit en plus être à
 * moins de 3 lignes d'une ligne d'étiquette (marque, « MADE IN », « 100 % »…),
 * pour ignorer les lettres isolées lues dans la texture du tissu.
 */
export function detectSizeStrict(text, { anchored = false } = {}) {
  if (!text) return null;
  const raw = String(text);
  const flat = ` ${raw.replace(/\s+/g, ' ')} `;
  // 1) Jean W/L, taille unique.
  let m = flat.match(/\bW\s?(\d{2})\s*[\/x]?\s*L\s?(\d{2})\b/i);
  if (m) return `W${m[1]}`;
  if (/\b(?:taille unique|one ?size|talla [úu]nica|taglia unica)\b/i.test(flat)) return 'Taille unique';
  // 2) Juste après un mot « taille » (toutes langues).
  // (un espace ou « : » obligatoire : « SIZES » n'est pas « size S »)
  m = flat.match(new RegExp(`(?:^|[^a-z])${SIZE_WORDS}(?:\\s*[:.\\-]\\s*|\\s+)(${LETTER_SIZE})(?![A-Za-z0-9'’])`, 'i'));
  if (m) return m[1].toUpperCase();
  m = flat.match(new RegExp(`(?:^|[^a-z])${SIZE_WORDS}(?:\\s*[:.\\-]\\s*|\\s+)(x-?small|extra small|small|medium|large|x-?large|extra large|xx-?large)\\b`, 'i'));
  if (m) return WORD_SIZES[slug(m[1])];
  m = flat.match(new RegExp(`(?:^|[^a-z])${SIZE_WORDS}\\s*[:.\\-]?\\s*(?:eu|fr)?\\s*(\\d{2}(?:[.,]5)?)(?![\\d°])`, 'i'));
  if (m) return m[1].replace('.', ',');
  // 3) Âge (enfant).
  m = flat.match(/\b(\d{1,2})\s*(?:ans|years?|yrs|jahre|años|anos|anni)\b/i);
  if (m && +m[1] >= 1 && +m[1] <= 16) return `${+m[1]} ans`;
  m = flat.match(/\b(\d{1,2})\s*(?:mois|months?|monate|meses|mesi)\b/i);
  if (m && +m[1] >= 1 && +m[1] <= 36) return `${+m[1]} mois`;
  // 4) Ligne courte qui ne contient QUE des tailles (« M », « M / 40 », « XL - 44 », « EU 42 », « 10A »).
  const lines = raw
    .split(/[\n\r|]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  const anchors = anchored ? lines.map((l, i) => (isLabelLine(l) ? i : -1)).filter((i) => i >= 0) : [];
  let best = null;
  for (const [li, l] of lines.entries()) {
    const size = shortLineSize(l);
    if (!size) continue;
    if (!anchored) return size;
    // Texte d'OCR : la taille la plus proche d'une ligne d'étiquette (3 lignes au plus).
    const dist = Math.min(...anchors.filter((a) => a !== li).map((a) => Math.abs(a - li)));
    if (dist <= 3 && (!best || dist < best.dist)) best = { size, dist };
  }
  if (best) return best.size;
  // 5) Pointure / taille FR-EU explicite ailleurs (« EU 42 », « FR 38 »).
  m = flat.match(/\b(?:eu|eur|fr)\s*:?\s*(\d{2}(?:[.,]5)?)(?![\d°])/i);
  if (m) {
    const n = parseFloat(m[1].replace(',', '.'));
    if (n >= 16 && n <= 60) return m[1].replace('.', ',');
  }
  return null;
}

/** Taille d'une ligne courte qui ne contient QUE des tailles (« M », « M / 40 », « EU 42 », « 10A »), sinon null. */
function shortLineSize(line) {
  if (line.length > 24) return null;
  const toks = line
    .split(/[\s/\-–,;:()]+/)
    .map((x) => x.replace(/^[.'"·]+|[.'"·]+$/g, ''))
    .filter(Boolean);
  if (!toks.length || toks.length > 6) return null;
  const ok = toks.every((x) => LETTER_TOKEN.test(x) || /^\d{2}(?:[.,]5)?$/.test(x) || /^\d{1,2}[AY]$/.test(x) || QUALIFIERS.test(x) || WORD_SIZES[slug(x)]);
  if (!ok) return null;
  const letter = toks.find((x) => LETTER_TOKEN.test(x));
  if (letter) return letter;
  const word = toks.find((x) => WORD_SIZES[slug(x)]);
  if (word) return WORD_SIZES[slug(word)];
  const age = toks.find((x) => /^\d{1,2}[AY]$/.test(x));
  if (age && +age.slice(0, -1) <= 16) return `${+age.slice(0, -1)} ans`;
  const qi = toks.findIndex((x) => QUALIFIERS.test(x));
  if (qi >= 0 && /^\d{2}(?:[.,]5)?$/.test(toks[qi + 1] || '')) return toks[qi + 1].replace('.', ',');
  return null;
}

const LABEL_LINE = /made|fabriqu|hecho|prodott|hergest|china|taille|size|talla|taglia|gr(?:ö|o)(?:ß|ss)e|\d\s*%|\b(?:rn|ca)\s*\d|cott?on|polyester|wool|laine|wash|lavage|\b(?:eu|fr|uk|us|it)\s*\d{2}/i;

/** Ligne typique d'une étiquette (marque, composition, origine, entretien). */
function isLabelLine(line) {
  return LABEL_LINE.test(line) || !!detectBrand(line) || !!detectBrandFuzzy(line);
}

/** Taille lue ou saisie → format Vinted (« 10Y » → « 10 ans », « m » → « M », « W32 L34 » → « W32 »). */
export function normalizeSize(value) {
  let s = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!s || /^(unknown|inconnue?|n\/a|na|none|aucune?|non visible|illisible|-+|\?+)$/i.test(s)) return '';
  s = s.replace(/^(?:taille|size|pointure|talla|taglia|gr(?:ö|o)(?:ß|ss)e)\s*:?\s*/i, '');
  if (/^(taille unique|one ?size|tu|os|unique)$/i.test(s)) return 'Taille unique';
  let m = /^w\s?(\d{2})(?:\s*[/x]?\s*l\s?\d{2})?$/i.exec(s);
  if (m) return `W${m[1]}`;
  m = /^(\d{1,2})\s*(?:a|ans?|y|yrs?|years?)$/i.exec(s);
  if (m) return `${+m[1]} ans`;
  m = /^(\d{1,2})\s*(?:m|mois|months?)$/i.exec(s);
  if (m) return `${+m[1]} mois`;
  m = /^(?:eu|eur|fr)\s*(\d{2}(?:[.,]5)?)$/i.exec(s);
  if (m) return m[1].replace('.', ',');
  if (/^\d{2}[.,]5$/.test(s)) return s.replace('.', ',');
  if (/^(xxxs|xxs|xs|s|m|l|xl|xxl|xxxl|[2-6]xl)$/i.test(s)) return s.toUpperCase();
  if (WORD_SIZES[slug(s)]) return WORD_SIZES[slug(s)];
  return s.slice(0, 16);
}

// ---------------------------------------------------------------------------
// Marques
// ---------------------------------------------------------------------------

const AMBIGUOUS_BRANDS = new Set(BRAND_AMBIGUOUS.map((b) => slug(b)));
const escRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** « Made in Jordan », « fabriqué en Colombie »… : le pays n'est jamais la marque. */
function stripOrigin(t) {
  return t.replace(/\b(?:made|fabrique|fabriques|hecho|fabricado|prodotto|hergestellt|produit|origine?)\s+(?:in|en|au|aux)?\s*[a-z]+/g, ' ');
}

/** Écritures cherchées : « levi's » et « levis », « dr. martens » et « dr martens ». */
function brandSpellings(b) {
  const nb = normalize(b);
  const bare = nb.replace(/['.]/g, '').replace(/\s+/g, ' ').trim();
  return bare !== nb && bare.length >= 4 ? [nb, bare] : [nb];
}

/**
 * Lignes d'un texte d'étiquette (retours à la ligne ou « | »), réduites à leur
 * slug, avec et sans les mots décoratifs de fin (« GUESS JEANS » → guess,
 * « GAP KIDS » → gap ; « dry clean only » reste drycleanonly).
 */
function lineSlugs(text) {
  const out = new Set();
  for (const line of String(text || '').split(/[\n\r|]+/)) {
    const words = line.trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    out.add(slug(line));
    while (words.length > 1 && isBrandNoise(words[words.length - 1])) words.pop();
    out.add(slug(words.join(' ')));
  }
  out.delete('');
  return out;
}

/**
 * Marque citée en toutes lettres dans un texte (la plus longue l'emporte).
 * Les marques qui sont aussi des mots courants (BRAND_AMBIGUOUS : « Only »,
 * « Tex »…) ne comptent que si elles occupent seules une ligne (mots
 * décoratifs de fin tolérés : « GUESS JEANS », « GAP KIDS »).
 */
export function detectBrand(text, brands = BRANDS) {
  const t = ` ${stripOrigin(normalize(text))} `;
  if (!t.trim()) return null;
  let lines = null;
  let best = null;
  let bestLen = 0;
  for (const b of brands) {
    const nb = normalize(b);
    if (nb.length < 3 && !/[&]/.test(nb)) continue;
    let hit;
    if (AMBIGUOUS_BRANDS.has(slug(b))) {
      lines = lines || lineSlugs(text);
      hit = lines.has(slug(b));
    } else {
      hit = brandSpellings(b).some((v) => new RegExp(`(^|[^a-z0-9])${escRx(v)}($|[^a-z0-9])`).test(t));
    }
    if (hit && nb.length > bestLen) {
      best = b;
      bestLen = nb.length;
    }
  }
  return best;
}

/** Distance d'édition (Levenshtein), arrêtée dès qu'elle dépasse `max` (renvoie alors max + 1). */
export function editDistance(a, b, max = Infinity) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

let fuzzyCache = null;

/** Terminaisons ordinaires (pluriels, accords, conjugaisons) : jamais du bruit d'OCR collé à une marque. */
const WORD_ENDINGS = new Set(['s', 'e', 'x', 'd', 'r', 'es', 'ed', 'er', 'ly', 'al', 'ia', 'ie', 'en', 'ne', 'le', 'te', 'se', 'ss']);

/** Repli des confusions typiques de l'OCR : 0→o, 1/i→l, 5→s, 8→b… */
const OCR_FOLD = { 0: 'o', 1: 'l', i: 'l', 5: 's', 8: 'b', 6: 'g', 9: 'g', 4: 'a', 7: 't', 3: 'e', 2: 'z' };
const ocrFold = (s) => s.replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/[0-9i]/g, (c) => OCR_FOLD[c] || c);

/** Lettres que l'OCR confond souvent (une seule substitution de ce type est tolérée sur les marques courtes). */
const OCR_PAIRS = new Set(['cg', 'ce', 'co', 'od', 'uv', 'nh', 'mn', 'hb', 'ft', 'tl', 'yv', 'ao', 'ec'].flatMap((p) => [p, p[1] + p[0]]));

/** Candidats de la détection approximative : marques (et alias) d'au moins 6 lettres, hors mots courants. */
function fuzzyCandidates(brands) {
  if (fuzzyCache?.brands === brands) return fuzzyCache.list;
  const list = [];
  const seen = new Set();
  const add = (s, name, min = 6) => {
    if (s.length < min || seen.has(s) || AMBIGUOUS_BRANDS.has(s) || AMBIGUOUS_BRANDS.has(slug(name))) return;
    seen.add(s);
    list.push({ s, f: ocrFold(s), name, exact: s.length < 6 });
  };
  for (const b of brands) add(slug(b), b);
  // Alias distinctifs (« hilfiger », « northface »), et de 5 lettres en égalité stricte (« tommy »).
  if (brands === BRANDS) for (const [alias, name] of Object.entries(BRAND_ALIASES)) add(alias, name, 5);
  fuzzyCache = { brands, list };
  return list;
}

/**
 * Coût d'une fenêtre de texte (repliée) face à une marque (repliée), ou -1 si
 * trop éloignée. Marque de 6 à 9 lettres : égalité, ou UNE substitution entre
 * lettres que l'OCR confond (« hilficer » ↔ « hilfiger »). À partir de 10
 * lettres : distance d'édition ≤ 2, même première lettre, et pas une simple
 * variante de fin de mot (pluriel, conjugaison).
 */
function fuzzyCost(win, brand) {
  if (win === brand) return 0;
  if (brand.length < 10) {
    if (win.length !== brand.length) return -1;
    let diff = -1;
    for (let k = 0; k < win.length; k += 1) {
      if (win[k] === brand[k]) continue;
      if (diff >= 0) return -1;
      diff = k;
    }
    return OCR_PAIRS.has(win[diff] + brand[diff]) ? 1 : -1;
  }
  if (win[0] !== brand[0] || win.startsWith(brand) || brand.startsWith(win)) return -1;
  const d = editDistance(win, brand, 2);
  return d <= 2 ? d : -1;
}

/**
 * Détection TOLÉRANTE aux erreurs d'OCR (« TOMMY HILFICER », « LAC0STE »,
 * « TOMMY = HILFIGER ») : on compare des fenêtres de 1 à 4 mots consécutifs
 * (collés) aux marques connues d'au moins 6 lettres, après repli des
 * confusions de l'OCR (voir fuzzyCost). Les marques courtes ou qui sont des
 * mots courants sont exclues (trop de faux positifs). Les alias de BRAND_ALIASES
 * comptent aussi (« TOMMY » seul → Tommy Hilfiger). Complète detectBrand.
 */
export function detectBrandFuzzy(text, brands = BRANDS) {
  const tokens = stripOrigin(normalize(text))
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (!tokens.length) return null;
  const cands = fuzzyCandidates(brands);
  let best = null;
  for (let i = 0; i < tokens.length; i += 1) {
    let win = '';
    for (let w = 0; w < 4 && i + w < tokens.length; w += 1) {
      win += tokens[i + w];
      if (win.length > 24) break;
      if (win.length < 5) continue;
      const fw = ocrFold(win);
      for (const c of cands) {
        if (Math.abs(fw.length - c.f.length) > 2) continue;
        // « TOMMYn », « LACOSTEa » : 1 ou 2 caractères parasites collés au mot par l'OCR (mot seul
        // uniquement), sauf une terminaison de mot ordinaire (« converses », « diesels », « fossile »).
        const glued = w === 0 && fw.length > c.f.length && fw.startsWith(c.f) && c.f.length >= 5 && !WORD_ENDINGS.has(fw.slice(c.f.length));
        const d = glued ? 1 : c.exact ? (fw === c.f ? 0 : -1) : fuzzyCost(fw, c.f);
        if (d < 0) continue;
        if (!best || d < best.d || (d === best.d && c.s.length > best.len)) best = { name: c.name, d, len: c.s.length };
      }
    }
  }
  return best ? best.name : null;
}

let brandIndex = null;

/** slug → nom exact de la marque (BRANDS puis BRAND_ALIASES). */
function brandBySlug() {
  if (brandIndex) return brandIndex;
  brandIndex = new Map();
  for (const b of BRANDS) if (!brandIndex.has(slug(b))) brandIndex.set(slug(b), b);
  for (const [alias, name] of Object.entries(BRAND_ALIASES)) if (!brandIndex.has(alias)) brandIndex.set(alias, name);
  return brandIndex;
}

/** Mots « décoratifs » autour d'une marque : « GANT USA », « Sandro Paris », « TOMMY HILFIGER DENIM ». */
const BRAND_NOISE = new Set([
  'paris', 'london', 'londres', 'milano', 'milan', 'italia', 'italy', 'france', 'usa', 'nyc', 'newyork', 'denim',
  'jeans', 'sport', 'sports', 'sportswear', 'originals', 'kids', 'kid', 'enfant', 'enfants', 'junior', 'baby',
  'bebe', 'homme', 'femme', 'men', 'women', 'woman', 'girl', 'girls', 'boy', 'boys', 'collection', 'clothing',
  'apparel', 'official', 'by', 'the', 'co', 'inc', 'ltd', 'est', 'since',
]);
const isBrandNoise = (w) => BRAND_NOISE.has(slug(w)) || /^\d{2,4}$/.test(w);
const SMALL_WORDS = new Set(['le', 'la', 'les', 'de', 'des', 'du', 'et', 'the', 'of', 'and', 'by', 'a', 'au', 'en', 'di', 'da', 'del', 'el', 'il', 'un', 'une', 'y']);

/** « TOMMY JEANS » → « Tommy Jeans », sigles courts gardés (« NKD ») ; casse déjà travaillée conservée. */
function properCase(s) {
  const letters = s.replace(/[^\p{L}]/gu, '');
  if (!letters) return s;
  const upper = letters === letters.toUpperCase();
  if (!upper && letters !== letters.toLowerCase()) return s; // « adidas Originals », « McQueen »
  return s
    .split(' ')
    .map((w, i) => {
      const lw = w.toLowerCase();
      if (i > 0 && SMALL_WORDS.has(lw)) return lw;
      if (upper && w.replace(/[^\p{L}]/gu, '').length <= 3 && !SMALL_WORDS.has(lw)) return w;
      return lw.replace(/(^|[-'’.&/])(\p{L})/gu, (_m, p, c) => p + c.toUpperCase());
    })
    .join(' ');
}

/**
 * Orthographe officielle d'une marque déjà lue (étiquette, saisie) : égalité de slug
 * avec BRANDS ou BRAND_ALIASES (« TOMMY HILFIGER » → « Tommy Hilfiger »,
 * « levis » → « Levi's », « the northface » → « The North Face »), en ignorant
 * les mots décoratifs (« GANT USA » → « Gant »). Marque inconnue : gardée telle
 * quelle, en casse propre. Ne devine jamais une marque.
 */
export function canonicalBrand(brand) {
  const raw = String(brand ?? '')
    .replace(/[®™©]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!slug(raw)) return '';
  const index = brandBySlug();
  const direct = index.get(slug(raw));
  if (direct) return direct;
  const words = raw.split(' ');
  for (let lo = 0; lo < words.length; lo += 1) {
    if (lo > 0 && !isBrandNoise(words[lo - 1])) break;
    for (let hi = words.length; hi > lo; hi -= 1) {
      if (hi < words.length && !isBrandNoise(words[hi])) break;
      if (lo === 0 && hi === words.length) continue;
      const hit = index.get(slug(words.slice(lo, hi).join(' ')));
      if (hit) return hit;
    }
  }
  return properCase(raw);
}

/** Composition « 80% coton 20% polyester » → ['Coton', 'Polyester'] (≤ 3). */
export function detectMaterials(text, max = 3) {
  const t = normalize(text);
  if (!t) return [];
  const found = new Map();
  for (const [words, vinted] of MATERIAL_SYNONYMS) {
    for (const w of words) {
      const esc = normalize(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const withPct = new RegExp(`(\\d{1,3})\\s*%\\s*(?:de\\s+|d')?${esc}\\b|\\b${esc}\\s*:?\\s*(\\d{1,3})\\s*%`);
      const m = withPct.exec(t);
      if (m) {
        const pct = parseInt(m[1] || m[2], 10);
        if (pct > 0 && pct <= 100) found.set(vinted, Math.max(found.get(vinted) || 0, pct));
      }
    }
  }
  // Sans pourcentage : n'accepte que les mots longs et sans ambiguïté.
  if (found.size === 0) {
    for (const [words, vinted] of MATERIAL_SYNONYMS) {
      for (const w of words) {
        const nw = normalize(w);
        if (nw.length < 5) continue;
        if (new RegExp(`\\b${nw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(t)) found.set(vinted, 1);
      }
    }
  }
  return [...found.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name)
    .filter((n) => MATERIALS.includes(n))
    .slice(0, max);
}

// ---------------------------------------------------------------------------
// Hashtags
// ---------------------------------------------------------------------------

export function buildHashtags(f, count = 80) {
  const tags = [];
  const seen = new Set();
  const push = (raw) => {
    const s = slug(raw);
    if (s && s.length > 1 && s.length < 40 && !seen.has(s)) {
      seen.add(s);
      tags.push('#' + s);
    }
  };
  const def = findCategoryDef(f.category || f.title || '');
  const rayonTags = RAYON_TAGS[f.rayon] || [];
  if (f.brand) {
    push(f.brand);
    if (def) push(f.brand + def.title);
    if (rayonTags[0]) push(f.brand + rayonTags[0]);
  }
  if (def) def.tags.forEach(push);
  else if (f.category) push(f.category);
  rayonTags.forEach(push);
  if (f.size) push('taille' + f.size);
  (f.colors || []).forEach(push);
  (f.materials || []).forEach(push);
  const byCondition = {
    'Neuf avec étiquette': ['neuf', 'neufavecetiquette', 'jamaisporte'],
    'Neuf sans étiquette': ['neuf', 'jamaisporte', 'commeneuf'],
    'Très bon état': ['tresbonetat', 'commeneuf'],
    'Bon état': ['bonetat'],
    Satisfaisant: ['petitprix'],
  }[f.condition];
  (byCondition || []).forEach(push);
  const p = parsePrice(f.price);
  if (p && p <= 10) push('petitprix');
  else if (p && p <= 25) push('prixdoux');
  GENERIC_HASHTAGS.forEach(push);
  return tags.slice(0, Math.max(0, Math.min(100, count | 0)));
}

// ---------------------------------------------------------------------------
// Titre
// ---------------------------------------------------------------------------

/** Titre façon Vinted : « Pull Nike gris taille M » (≤ 80 caractères). */
export function buildTitle(f) {
  const def = findCategoryDef(f.category || '');
  const what = f.categoryName ? singularize(f.categoryName) : def ? def.title : capitalize(f.category || '') || 'Article';
  const parts = [what];
  if (f.brand && !normalize(what).includes(normalize(f.brand))) parts.push(f.brand);
  if (f.colors?.[0]) parts.push(f.colors[0].toLowerCase());
  if (f.size) parts.push(`taille ${f.size}`);
  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

/** « Pulls ras de cou » → « Pull ras de cou » (premier mot au singulier). */
export function singularize(name) {
  const words = String(name || '').trim().split(/\s+/);
  if (!words[0]) return '';
  const w = words[0];
  const keepPlural = /^(baskets|bottes|sandales|escarpins|mocassins|ballerines|lunettes|chaussures|tongs|claquettes|jeans)$/i;
  if (!keepPlural.test(w) && w.length > 3) {
    if (/aux$/i.test(w)) words[0] = w.replace(/aux$/i, 'au');
    else if (/[sx]$/i.test(w)) words[0] = w.slice(0, -1);
  }
  return words.join(' ');
}

// ---------------------------------------------------------------------------
// Description
// ---------------------------------------------------------------------------

const FEMININE = new Set([
  'robe', 'jupe', 'chemise', 'veste', 'doudoune', 'basket', 'botte', 'bottine', 'sandale', 'ceinture',
  'casquette', 'echarpe', 'montre', 'parka', 'paire', 'blouse', 'salopette', 'combinaison', 'chaussure',
  'sacoche', 'pochette', 'polaire', 'mariniere', 'tunique', 'brassiere', 'culotte', 'nuisette', 'bague',
  'boucle', 'lunette', 'serviette', 'housse', 'lampe', 'tasse', 'console', 'manette', 'chemisette',
  'besace', 'banane', 'ballerine', 'mule', 'tong', 'claquette', 'doudoune', 'casquette', 'poupee',
]);

export function withDeterminer(title, brand) {
  if (!title) return 'cet article';
  const firstRaw = title.split(/\s+/)[0];
  const first = normalize(firstRaw);
  if (brand && first === normalize(brand.split(/\s+/)[0])) return `cet article ${title}`;
  const rest = title.charAt(0).toLowerCase() + title.slice(1);
  const plural = first.length > 3 && /s$/.test(first) && !['jeans', 'bas', 'sweats', 'pantalons'].includes(first);
  if (plural) return `ces ${rest}`;
  if (FEMININE.has(first.replace(/s$/, ''))) return `cette ${rest}`;
  if (/^[aeiouyh]/.test(first)) return `cet ${rest}`;
  return `ce ${rest}`;
}

const OPENERS = ['Bonjour 👋', 'Coucou 👋', 'Hello 👋'];
const CONDITION_TEXT = {
  'Neuf avec étiquette': 'Neuf, jamais porté, avec son étiquette.',
  'Neuf sans étiquette': 'Neuf, jamais porté (étiquette retirée).',
  'Très bon état': 'Très bon état : porté quelques fois, aucun défaut à signaler.',
  'Bon état': "Bon état : porté, avec de légers signes d'usure (voir photos).",
  Satisfaisant: "État satisfaisant : signes d'usure visibles, détaillés en photos — prix en conséquence.",
};
const SHIPPING = ['📦 Envoi soigné sous 24/48h', '📦 Expédié rapidement et bien protégé', '📦 Envoi rapide et soigné'];
const BUNDLE = ['🛍️ Lots possibles : jette un œil à mon dressing !', '🛍️ Pense à regarder mon dressing, réduction sur les lots !'];
const CLOSERS = [
  "N'hésite pas si tu as une question ou si tu veux d'autres photos 😊",
  'Une question, une photo en plus ? Écris-moi, je réponds vite 🙂',
  'Dispo pour toute question, je réponds rapidement 😊',
];

/** Autres noms que les acheteurs tapent pour la MÊME catégorie (jamais une info inventée sur l'article). */
const CATEGORY_SYNONYMS = {
  Pulls: ['sweater', 'tricot'],
  Sweats: ['hoodie', 'sweat-shirt'],
  Gilets: ['cardigan'],
  'T-shirts': ['tee-shirt', 'tee'],
  Jeans: ['denim'],
  Joggings: ['bas de survêtement', 'jogger'],
  Vestes: ['blouson'],
  Doudounes: ['puffer', 'anorak'],
  Manteaux: ['manteau long'],
  Baskets: ['sneakers', 'tennis'],
  Bottes: ['boots'],
  'Sacs à main': ['sac', 'cabas'],
  'Sacs à dos': ['backpack'],
  'Sacs bandoulière': ['sac porté épaule', 'besace'],
  Casquettes: ['cap'],
  Combinaisons: ['combi'],
  Leggings: ['legging de sport'],
};

/** Taille écrite comme les acheteurs la recherchent (pointure, tour de taille, âge…). */
export function sizeForSearch(size, def) {
  const s = String(size || '').trim();
  if (!s) return '';
  if (def?.shoes) return `pointure ${s}`;
  if (/^W\d{2}/i.test(s)) return `taille ${s.toUpperCase()}`;
  if (/ans|mois/i.test(s)) return s;
  return `taille ${s}`;
}

/** Phrase de synthèse construite UNIQUEMENT avec les champs renseignés (marque, couleur, matière, taille). */
export function summarySentence(f) {
  const def = findCategoryDef(f.category || f.title || '');
  const what = def ? def.title.toLowerCase() : f.categoryName ? singularize(f.categoryName).toLowerCase() : '';
  const parts = [];
  if (f.brand) parts.push(`de la marque ${f.brand}`);
  if (f.colors?.length) parts.push(`coloris ${f.colors.map((c) => c.toLowerCase()).join(' et ')}`);
  if (f.materials?.length) parts.push(`en ${f.materials.map((m) => m.toLowerCase()).join(' et ')}`);
  const size = sizeForSearch(f.size, def);
  if (size) parts.push(size);
  if (parts.length < 2) return '';
  return `${capitalize(what || 'article')} ${parts.join(', ')}.`;
}

/**
 * Description optimisée pour la recherche Vinted, construite AUTOMATIQUEMENT
 * à partir des seules infos saisies : phrase d'accroche, synthèse
 * (type + marque + couleur + matière + taille au format recherché), état,
 * caractéristiques une par ligne, autres noms de la catégorie, puis hashtags.
 * Les lignes « Taille : … » servent aussi à Vinted, qui en déduit ses
 * suggestions de taille.
 */
export function buildDescription(f, { hashtags = 80, signature = '', rand = Math.random } = {}) {
  const def = findCategoryDef(f.category || f.title || '');
  const out = [];
  out.push(pick(OPENERS, rand), '');
  let line = `Je vends ${withDeterminer(f.title || '', f.brand)}`;
  if (f.brand && !normalize(f.title || '').includes(normalize(f.brand))) line += ` de la marque ${f.brand}`;
  out.push(line + '.');
  // Synthèse : seulement si elle apporte une info absente du titre (matière, couleur, taille…).
  const summary = summarySentence(f);
  const t = normalize(f.title || '');
  const adds = [f.brand, ...(f.colors || []), ...(f.materials || []), f.size].filter(Boolean).some((v) => !t.includes(normalize(v)));
  if (summary && adds) out.push(summary);
  if (CONDITION_TEXT[f.condition]) out.push(CONDITION_TEXT[f.condition]);
  out.push("Photos réelles de l'article. Je peux t'envoyer des mesures précises ou d'autres photos sur demande.");

  const details = [];
  if (f.brand) details.push(`🏷️ Marque : ${f.brand}`);
  if (f.size) details.push(def?.shoes ? `👟 Pointure : ${f.size}` : `📏 Taille : ${f.size}`);
  if (f.colors?.length) details.push(`🎨 Couleur : ${f.colors.join(' / ')}`);
  if (f.materials?.length) details.push(`🧵 Matière : ${f.materials.join(', ')}`);
  if (f.condition) details.push(`✨ État : ${f.condition}`);
  if (f.keywords?.length) details.push(`✔️ Détails : ${f.keywords.join(', ')}`);
  if (details.length) out.push('', ...details);

  const aka = (def && CATEGORY_SYNONYMS[def.kw]) || [];
  const typeName = def ? def.title.toLowerCase() : '';
  if (aka.length && typeName) out.push('', `🔎 Aussi recherché comme : ${aka.join(', ')}${f.brand ? ` ${f.brand}` : ''}.`);

  out.push('', pick(SHIPPING, rand), pick(BUNDLE, rand), pick(CLOSERS, rand));
  if (signature) out.push('', signature);
  const tags = buildHashtags(f, hashtags);
  if (tags.length) out.push('', tags.join(' '));
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Indices lus sur les étiquettes (sans IA)
// ---------------------------------------------------------------------------

const KIDS_TEXT = /\b(?:\d{1,2}\s?(?:ans|years?|yrs|mois|months?|jahre|años|anni)|kids?|enfants?|junior|baby|b[ée]b[ée]|toddler|newborn|naissance|girls?|boys?|fille|gar[çc]on)\b/i;
const WOMEN_TEXT = /\b(?:women'?s?|woman|ladies|lady|femmes?|damen|donna|mujer)\b/i;
const MEN_TEXT = /\b(?:men'?s|men|homme|hommes|herren|uomo|hombre)\b/i;

/**
 * Indices d'une étiquette ou d'un ticket : rayon (« WOMEN », « 10 ans »…),
 * jean (taille W/L), ticket de prix ou code-barres (article neuf avec étiquette).
 */
export function labelClues(text) {
  const t = String(text || '');
  const clues = { rayon: '', words: [], search: '', newWithTag: false };
  if (KIDS_TEXT.test(t)) clues.rayon = 'Enfants';
  else if (WOMEN_TEXT.test(t) && !MEN_TEXT.test(t.replace(/women/gi, ''))) clues.rayon = 'Femmes';
  else if (MEN_TEXT.test(t.replace(/women/gi, '')) && !WOMEN_TEXT.test(t)) clues.rayon = 'Hommes';
  if (/\bW\s?\d{2}\s*[/x]?\s*L\s?\d{2}\b/i.test(t)) {
    clues.words.push('jeans', 'jean');
    clues.search = 'Jeans';
  }
  // Ticket : prix (« 29,99 € », « EUR 35.00 ») ou code-barres EAN (12–13 chiffres).
  const flat = t.replace(/\s+/g, ' ');
  if (/(?:\d{1,4}[,.]\d{2}\s?(?:€|eur\b)|(?:€|\beur)\s?\d{1,4}[,.]\d{2})/i.test(flat) || /(?:^|\D)\d{12,13}(?:\D|$)/.test(flat)) clues.newWithTag = true;
  return clues;
}

let hintIndex = null;

/** Indices de catégorie d'une marque spécialisée (BRAND_HINTS), ou null. */
export function brandHints(brand) {
  if (!brand) return null;
  if (!hintIndex) {
    hintIndex = new Map();
    for (const group of BRAND_HINTS) for (const b of group.brands) hintIndex.set(slug(b), group);
  }
  return hintIndex.get(slug(brand)) || null;
}

/**
 * Indices pour choisir la catégorie sur Vinted, sans IA :
 * { rayon, words, search } — rayon saisi > étiquette > marque ; words = mots
 * attendus dans la catégorie (nom ou fil d'Ariane) ; search = terme à taper
 * si Vinted ne recommande rien.
 */
export function categoryHints({ rayon = '', text = '', brand = '' } = {}) {
  const fromLabel = labelClues(text);
  const fromBrand = brandHints(brand);
  const words = [...new Set([...fromLabel.words, ...(fromBrand?.words || [])].map(normalize))];
  return {
    rayon: (RAYONS.includes(rayon) && rayon) || fromLabel.rayon || fromBrand?.rayon || '',
    words,
    search: fromLabel.search || fromBrand?.search || '',
  };
}

/** Mots d'étiquette qui ne sont jamais une marque (composition, entretien, origine, tailles). */
const LABEL_WORDS = new Set(
  (
    'made in fabrique fabriqué en hecho prodotto hergestellt china chine bangladesh turkey turquie india inde vietnam cambodia cambodge ' +
    'pakistan portugal italy italie france morocco maroc tunisia tunisie indonesia indonesie sri lanka myanmar romania roumanie ' +
    'madagascar egypt egypte mauritius maurice usa uk spain espagne size taille talla taglia größe groesse tg sz ' +
    'cotton coton algodon cotone baumwolle polyester poliester elastane elasthanne spandex lycra viscose rayon wool laine lana wolle ' +
    'nylon polyamide polyamid acrylic acrylique acryl linen lin leinen silk soie seta seda cashmere cachemire leather cuir ' +
    'wash lavage laver lavar dry clean iron repasser bleach tumble do not ne pas only with similar colours colors inside out ' +
    'rn ca style ref art lot model modele modèle col color colour couleur front back body lining doublure shell main ' +
    'women woman men man homme femme kids enfant girl boy unisex fit slim regular loose original authentic quality premium ' +
    'the and et de des du la le les of for by'
  ).split(/\s+/),
);

/**
 * Candidats « marque » pris dans le texte le plus gros et le plus net des
 * étiquettes (lignes des zones relues de près), quand aucune marque connue
 * n'a été trouvée : ils seront VÉRIFIÉS dans la recherche de marques de
 * Vinted (égalité exacte uniquement), jamais pris tels quels.
 * lines = [{ text, h (hauteur des lettres, px), conf (0–100) }].
 */
export function brandCandidates(lines, max = 3) {
  const out = new Map();
  for (const line of lines || []) {
    if (!line || (line.conf ?? 0) < 75) continue;
    const words = String(line.text || '')
      .replace(/[^\p{L}\p{N}&'’.\- ]+/gu, ' ')
      .split(/\s+/)
      .map((w) => w.replace(/^[.'’\-]+|[.'’\-]+$/g, ''))
      .filter(Boolean);
    // Mots d'étiquette en tête ou en fin de ligne retirés (« MADE IN … », « … COTTON »).
    while (words.length && LABEL_WORDS.has(normalize(words[0]))) words.shift();
    while (words.length && LABEL_WORDS.has(normalize(words[words.length - 1]))) words.pop();
    if (!words.length || words.length > 4) continue;
    if (words.some((w) => LABEL_WORDS.has(normalize(w)) && w.length > 3)) continue;
    const name = words.join(' ');
    const letters = (name.match(/\p{L}/gu) || []).length;
    if (letters < 4 || name.length > 30 || /\d{2,}/.test(name)) continue;
    if (/^(?:[A-Z]{1,3}|[a-z]+)$/.test(name) && letters < 5) continue; // « XL », « ok » : bruit ou taille
    const upper = name === name.toUpperCase();
    const score = (line.h || 10) * ((line.conf || 0) / 100) * (upper ? 1.2 : 1);
    const key = slug(name);
    if (!out.has(key) || out.get(key).score < score) out.set(key, { name: properCase(name), score });
  }
  return [...out.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((c) => c.name);
}

// ---------------------------------------------------------------------------
// Fusion des sources : indices saisis > étiquette > défauts
// ---------------------------------------------------------------------------

/** La marque retenue est ramenée à l'orthographe officielle (canonicalBrand). */
export function mergeFields({ hints = {}, local = null, defaults = {} }) {
  const first = (...vals) => vals.find((v) => v !== undefined && v !== null && String(v).trim() !== '');
  const firstArr = (...vals) => vals.find((v) => Array.isArray(v) && v.length) || [];
  const merged = {
    rayon: first(hints.rayon, local?.rayon, defaults.rayon) || '',
    category: first(hints.category) || '',
    categoryPath: '',
    brand: canonicalBrand(first(hints.brand, local?.brand) || ''),
    size: normalizeSize(first(hints.size, local?.size) || ''),
    colors: firstArr(hints.colors, local?.colors).slice(0, 2),
    materials: firstArr(hints.materials, local?.materials).slice(0, 3),
    condition: first(hints.condition, local?.condition, defaults.condition) || 'Très bon état',
    package: first(hints.package) || '',
    title: first(hints.title) || '',
    notes: first(hints.notes) || '',
    keywords: Array.isArray(hints.keywords) ? hints.keywords.slice(0, 12) : [],
    price: hints.price ?? '',
  };
  if (!RAYONS.includes(merged.rayon)) merged.rayon = '';
  if (!CONDITIONS.some((c) => c.name === merged.condition)) merged.condition = 'Très bon état';
  merged.colors = merged.colors.filter((c) => COLOR_NAMES.includes(c));
  merged.materials = merged.materials.filter((m) => MATERIALS.includes(m));
  // Sans catégorie, le titre est composé APRÈS le choix de catégorie sur
  // Vinted (voir composeListing / RV_COMPOSE).
  if (!merged.title && merged.category) merged.title = buildTitle(merged);
  return merged;
}
