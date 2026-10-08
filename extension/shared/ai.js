/**
 * Revendo — reconnaissance de l'article à partir des photos via une IA
 * « compatible OpenAI » (Gemini gratuit, OpenAI, OpenRouter…), avec TA clé.
 * Méthode « étiquette d'abord » : l'IA recopie tout le texte lisible
 * (étiquettes, logos) AVANT de déduire marque, taille et catégorie ; si la
 * marque ou la taille manque encore, une seconde passe ne relit que les
 * photos d'étiquette en haute définition. La réponse est ramenée aux valeurs
 * EXACTES de Vinted (couleurs, matériaux, états, rayons, catégories, marques)
 * avant d'être utilisée. Aucun accès au DOM ni à chrome : testable en Node.
 */
import { CATEGORY_DEFS, COLOR_NAMES, CONDITIONS, MATERIALS, RAYONS } from './vinted-data.js';
import {
  canonicalBrand,
  detectBrand,
  detectMaterials,
  detectSizeStrict,
  findCategoryDef,
  matchVocab,
  normalize,
  normalizeColor,
  normalizeSize,
} from './listing.js';

export const AI_PRESETS = {
  gemini: {
    label: 'Google Gemini (offre gratuite)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-flash-latest',
    fallbackModels: ['gemini-flash-lite-latest', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
    extra: { reasoning_effort: 'low' },
    keyUrl: 'https://aistudio.google.com/apikey',
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5-mini',
    fallbackModels: ['gpt-4.1-mini', 'gpt-4o-mini'],
    extra: {},
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'google/gemini-flash-latest',
    fallbackModels: ['google/gemini-2.5-flash'],
    extra: {},
    keyUrl: 'https://openrouter.ai/keys',
  },
  custom: { label: 'Autre (compatible OpenAI)', baseUrl: '', model: '', fallbackModels: [], extra: {} },
};

export function resolveAiConfig(cfg = {}) {
  const preset = AI_PRESETS[cfg.preset] || AI_PRESETS.gemini;
  return {
    preset: cfg.preset || 'gemini',
    key: (cfg.key || '').trim(),
    baseUrl: (cfg.baseUrl || preset.baseUrl).replace(/\/$/, ''),
    model: (cfg.model || preset.model).trim(),
    fallbackModels: preset.fallbackModels || [],
    extra: preset.extra || {},
  };
}

/** Nombre maximal d'images envoyées à la passe principale, et à la passe « étiquette ». */
export const MAX_AI_IMAGES = 8;
export const MAX_LABEL_IMAGES = 4;

const PACKAGE_NAMES = ['Petit', 'Moyen', 'Grand'];
const EVIDENCE = ['étiquette', 'logo', 'motif'];

/** Erreur IA avec un message court en français et un code (auth, quota, timeout…). */
function aiError(message, code, status = 0, detail = '') {
  const err = new Error(message);
  err.code = code;
  if (status) err.status = status;
  if (detail) err.detail = String(detail).slice(0, 300);
  return err;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

/** Règles de désambiguïsation des catégories proches (liste fermée CATEGORY_DEFS). */
const CATEGORY_RULES = [
  'maille tricotée (on voit les mailles, bords côtelés), col rond, col V ou col roulé → "Pulls"',
  'molleton ou jersey épais, sweat à capuche ou zippé → "Sweats" (un pull à capuche en grosse maille reste "Pulls")',
  'maille ouverte devant, boutonnée ou zippée (cardigan) → "Gilets"',
  'chemise ou chemisier boutonné de haut en bas avec col, blouse → "Chemises"',
  'col à 2 ou 3 boutons, souvent en piqué → "Polos"',
  'jersey fin sans col ni boutons → "T-shirts" ; sans manches à bretelles → "Débardeurs" ; haut court ou fantaisie → "Tops"',
  'denim 5 poches → "Jeans" ; chino, cargo, pantalon de tailleur ou en toile → "Pantalons" ; bas de survêtement → "Joggings"',
  'veste courte, blouson, bomber, perfecto, veste en jean ou coupe-vent → "Vestes" ; veste matelassée gonflante → "Doudounes" ; manteau long, parka, trench, caban → "Manteaux" ; veste de costume ou de tailleur → "Blazers"',
  'sneakers et chaussures de sport → "Baskets" ; bottes et bottines → "Bottes" ; derbies et mocassins → "Mocassins"',
];

const SIZE_FORMAT =
  'lettres XXS, XS, S, M, L, XL, XXL, XXXL ; nombre FR/EU (34 à 52) ; jean "W30" (W32 L34 → "W32") ; enfant "10 ans" ou "18 mois" (« 10A », « 10Y », « 140 cm » → "10 ans") ; chaussures pointure EU "42" ou "38,5" ; "Taille unique"';

/** Indices (0 = première image) en texte : « 0, 2 et 5 ». */
const listIdx = (arr) => (arr.length > 1 ? `${arr.slice(0, -1).join(', ')} et ${arr[arr.length - 1]}` : String(arr[0]));
const clip = (v, max) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Informations imposées par le vendeur (prioritaires sur ce que voit l'IA). */
function hintLines(hints = {}, { labelImages = [] } = {}) {
  const lines = [];
  const known = [];
  if (hints.rayon) known.push(`rayon : ${clip(hints.rayon, 30)}`);
  if (hints.category) known.push(`catégorie : ${clip(hints.category, 50)}`);
  if (hints.brand) known.push(`marque : ${clip(hints.brand, 40)}`);
  if (hints.size) known.push(`taille : ${clip(hints.size, 16)}`);
  if (hints.condition) known.push(`état : ${clip(hints.condition, 30)}`);
  if (known.length) lines.push(`Informations IMPOSÉES par le vendeur (prioritaires sur ce que tu vois, recopie-les telles quelles) : ${known.join(' ; ')}.`);
  if (hints.notes) lines.push(`Note du vendeur (à prendre en compte pour la catégorie, les défauts et le texte) : « ${clip(hints.notes, 300)} ».`);
  if (labelImages.length) {
    lines.push(
      labelImages.length > 1
        ? `Le vendeur a marqué les images ${listIdx(labelImages)} comme photos d'étiquette : lis-les en priorité, en détail.`
        : `Le vendeur a marqué l'image ${labelImages[0]} comme photo d'étiquette : lis-la en priorité, en détail.`,
    );
  }
  return lines;
}

/**
 * Prompt de la passe principale. opts.count = nombre d'images envoyées,
 * opts.labelImages = indices (dans l'ordre d'envoi) des photos d'étiquette.
 */
export function buildPrompt(hints = {}, { count = 0, labelImages = [] } = {}) {
  const cats = CATEGORY_DEFS.map((d) => d.kw).join(', ');
  const numbering = count > 1 ? `Les ${count} images sont numérotées de 0 à ${count - 1} dans l'ordre d'envoi.` : count === 1 ? "L'image porte le numéro 0." : '';
  const lines = [
    `Tu es un vendeur Vinted expérimenté, spécialiste de la lecture d'étiquettes. Les photos montrent UN SEUL article d'occasion à vendre. ${numbering}`.trim(),
    'Travaille dans cet ordre :',
    "1. LIS d'abord tout le texte visible sur chaque image : étiquette du col ou de la ceinture, étiquette de taille, étiquette d'entretien et de composition (souvent cousue dans une couture intérieure), logos imprimés ou brodés, boutons, rivets, tirettes de zip, semelles, languettes. Examine les petites étiquettes de près, même floues, tournées ou à l'envers.",
    "2. Déduis ensuite la marque et la taille de ce que tu as LU, puis la catégorie, le rayon et le reste de la fiche.",
    'Réponds UNIQUEMENT avec un objet JSON valide, sans texte autour, avec ces clés :',
    '- "label_text" : transcription LITTÉRALE de tout le texte lu (étiquettes, logos, boutons…), un segment par étiquette séparé par " | ", ex. "TOMMY HILFIGER | M | MADE IN CHINA | 100% COTTON". N\'invente rien ; "" si rien n\'est lisible.',
    '- "label_photos" : indices des images (0 = la première) qui montrent une étiquette ou un logo lisible, ex. [1, 3].',
    "- \"brand\" : la marque EXACTE lue sur une étiquette ou un logo, recopiée lettre à lettre (étiquette « TOMMY HILFIGER » → \"Tommy Hilfiger\"). Si l'étiquette est partiellement cachée ou un peu floue mais sans ambiguïté, utilise-la. Ne devine JAMAIS une marque d'après le style, la coupe, la couleur ou le motif ; ne prends pas pour une marque le pays de fabrication, un numéro RN/CA, une matière, une taille ou un slogan. Rien de lisible → \"\".",
    '- "brand_evidence" : "étiquette" (marque lue sur une étiquette), "logo" (logo imprimé, brodé ou en métal), "motif" (motif déposé reconnaissable sans texte, ex. tartan Burberry, monogramme Louis Vuitton — seulement si tu es certain), "" si pas de marque.',
    `- "size" : la taille LUE sur l'étiquette (jamais estimée à l'œil), au format Vinted : ${SIZE_FORMAT}. Si l'étiquette donne plusieurs systèmes (« M / FR 40 / UK 12 »), prends les lettres pour un haut, le nombre FR/EU pour un bas ou des chaussures. Illisible → "".`,
    `- "rayon" : un parmi ${RAYONS.join(' | ')}. Déduis-le de la coupe ET des étiquettes : taille enfant (« 10 ans », « 18 mois », « 104 cm ») → "Enfants" ; mention « Homme / Men / Uomo » ou « Femme / Women / Donna » → ce rayon ; coupe cintrée, boutonnage à gauche, décolleté → "Femmes". Un vêtement de sport va dans le rayon de la personne qui le porte.`,
    `- "category" : EXACTEMENT un nom de cette liste fermée : ${cats}. Règles : ${CATEGORY_RULES.join(' ; ')}. Seulement si aucun ne convient (objet ou accessoire absent de la liste) : un nom court au pluriel comme sur Vinted.`,
    '- "category_path" : le chemin Vinted probable sans le rayon, ex. "Vêtements > Sweats et pulls > Pulls" ou "Chaussures > Baskets".',
    `- "colors" : 1 ou 2 couleurs parmi : ${COLOR_NAMES.join(', ')} — la couleur dominante d'abord ; pour un motif (pois, rayures), la couleur du fond puis celle du motif (marine à pois blancs → ["Marine", "Blanc"]). Un bleu très foncé est "Marine", pas "Noir".`,
    `- "materials" : 0 à 3 matières parmi : ${MATERIALS.join(', ')} — d'après l'étiquette de composition (pourcentage décroissant) ; sans étiquette lisible, seulement si c'est évident (cuir, denim).`,
    `- "condition" : un parmi ${CONDITIONS.map((c) => c.name).join(' | ')}. "Neuf avec étiquette" seulement si une étiquette de magasin est attachée. Dans le doute : "Très bon état".`,
    `- "package" : ${PACKAGE_NAMES.join(' | ')} (Petit = tient dans une grande enveloppe, Moyen = boîte à chaussures, Grand = carton).`,
    '- "title" : titre Vinted court et précis (max 60 caractères) : type + marque lue + détail clé + couleur, ex. "Pull Tommy Hilfiger à pois marine". Pas de taille, pas d\'emoji, pas de marque inventée.',
    '- "description" : 2 à 4 phrases naturelles, à la première personne, en français, comme un particulier (coupe, matière, détails, défauts visibles). Pas de formule de politesse, pas de hashtags, pas de prix.',
    '- "defects" : défauts visibles (tache, trou, bouloches…) ou "".',
    '- "confidence" : 0 à 1, ta confiance globale.',
    'Format exact : {"label_text":"","label_photos":[],"brand":"","brand_evidence":"","size":"","rayon":"","category":"","category_path":"","colors":[],"materials":[],"condition":"","package":"","title":"","description":"","defects":"","confidence":0}',
  ];
  return [...lines, ...hintLines(hints, { labelImages })].join('\n');
}

/** Prompt de la seconde passe : uniquement les photos d'étiquette, en haute définition. */
export function buildLabelPrompt(hints = {}, count = 1) {
  const lines = [
    `${count > 1 ? `Ces ${count} images montrent` : 'Cette image montre'} en gros plan les ÉTIQUETTES d'un article d'occasion (étiquette du col, de taille, de composition, logo). Lis-les très attentivement, même petites, floues, tournées ou à l'envers.`,
    'Réponds UNIQUEMENT avec un objet JSON valide, sans texte autour : {"label_text":"","brand":"","size":"","materials":[]}',
    '- "label_text" : transcription littérale de tout le texte lu, un segment par étiquette séparé par " | ".',
    '- "brand" : la marque exacte écrite sur l\'étiquette ou le logo, lettre à lettre (pas le pays de fabrication, pas un numéro RN/CA, pas une matière) ; si elle est partiellement visible mais sans ambiguïté, donne-la ; sinon "". Ne devine jamais.',
    `- "size" : la taille lue, au format Vinted : ${SIZE_FORMAT} ; "" si illisible.`,
    `- "materials" : 0 à 3 matières parmi : ${MATERIALS.join(', ')}, d'après la composition.`,
  ];
  const known = [];
  if (hints.brand) known.push(`marque : ${clip(hints.brand, 40)}`);
  if (hints.size) known.push(`taille : ${clip(hints.size, 16)}`);
  if (known.length) lines.push(`Déjà connu (à recopier tel quel) : ${known.join(' ; ')}.`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Lecture et normalisation de la réponse
// ---------------------------------------------------------------------------

/** Extrait le premier objet JSON d'une réponse (gère ```json … ```, un tableau et le texte parasite). */
export function parseJsonLoose(text) {
  if (!text) return null;
  const s = String(text).replace(/```(?:json)?/gi, '').trim();
  try {
    const v = JSON.parse(s);
    if (Array.isArray(v)) return v.find((o) => o && typeof o === 'object' && !Array.isArray(o)) || null;
    return v && typeof v === 'object' ? v : null;
  } catch (_e) {
    /* on cherche un bloc {...} */
  }
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(start, i + 1));
        } catch (_e) {
          return null;
        }
      }
    }
  }
  return null;
}

/** « Pull » → « Pulls », « hoodie » → « Sweats » ; un nom plus précis (« Pulls à col roulé ») est gardé. */
export function normalizeCategory(value) {
  const v = clip(value, 50);
  if (!v) return '';
  const n = normalize(v);
  const bare = (x) => normalize(x).replace(/s$/, '');
  const exact = CATEGORY_DEFS.find((d) => bare(d.kw) === n.replace(/s$/, '') || bare(d.title) === n.replace(/s$/, ''));
  if (exact) return exact.kw;
  const def = findCategoryDef(v);
  if (!def) return v;
  const words = n.split(' ');
  const head = words[0].replace(/s$/, '');
  if (words.length > 1 && [def.kw, def.title].some((x) => bare(x.split(' ')[0]) === head)) return v;
  return def.kw;
}

/** Texte d'étiquette : segments séparés par « | » (les retours à la ligne aussi). */
function cleanLabelText(v) {
  if (Array.isArray(v)) v = v.join(' | ');
  if (typeof v !== 'string') return '';
  return v
    .split(/\s*(?:\r?\n|\|)\s*/)
    .map((x) => x.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' | ')
    .slice(0, 1500);
}

/**
 * Ramène une réponse d'IA (parfois approximative) aux valeurs autorisées, en
 * complétant marque, taille et matières depuis la transcription des étiquettes.
 */
export function normalizeAiResult(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const list = (v) => (Array.isArray(v) ? v : typeof v === 'string' && v ? v.split(/[,/]/) : []);
  const labelText = cleanLabelText(raw.label_text ?? raw.labelText);
  const colors = [];
  for (const c of list(raw.colors ?? raw.color)) {
    const m = normalizeColor(c) || matchVocab(c, COLOR_NAMES);
    if (m && !colors.includes(m)) colors.push(m);
  }
  let materials = [];
  for (const c of list(raw.materials ?? raw.material)) {
    const m = matchVocab(c, MATERIALS);
    if (m && !materials.includes(m)) materials.push(m);
  }
  if (!materials.length && labelText) materials = detectMaterials(labelText);
  let size = normalizeSize(typeof raw.size === 'number' ? String(raw.size) : str(raw.size, 24));
  if (!size && labelText) size = detectSizeStrict(labelText) || '';
  let brand = str(raw.brand, 40);
  if (/^(unknown|inconnue?|n\/a|none|aucune?|sans marque|no brand|generic|générique|illisible|non visible)$/i.test(brand)) brand = '';
  brand = canonicalBrand(brand);
  let brandEvidence = matchVocab(raw.brand_evidence ?? raw.brandEvidence, EVIDENCE) || '';
  if (!brandEvidence && /^(label|tag|etiquette)/i.test(normalize(raw.brand_evidence ?? ''))) brandEvidence = 'étiquette';
  if (!brandEvidence && /^(pattern|print)/i.test(normalize(raw.brand_evidence ?? ''))) brandEvidence = 'motif';
  if (!brand && labelText) {
    brand = detectBrand(labelText) || '';
    if (brand) brandEvidence = 'étiquette';
  }
  if (!brand) brandEvidence = '';
  const labelPhotos = [];
  for (const v of list(raw.label_photos ?? raw.labelPhotos)) {
    const i = Number(v);
    if (Number.isInteger(i) && i >= 0 && i < 50 && !labelPhotos.includes(i)) labelPhotos.push(i);
  }
  const conf = Number(raw.confidence);
  return {
    rayon: matchVocab(raw.rayon, RAYONS) || '',
    category: normalizeCategory(raw.category),
    categoryPath: str(raw.category_path ?? raw.categoryPath, 120),
    brand,
    brandEvidence,
    size,
    colors: colors.slice(0, 2),
    materials: materials.slice(0, 3),
    condition: matchVocab(raw.condition, CONDITIONS.map((c) => c.name)) || '',
    package: matchVocab(raw.package, PACKAGE_NAMES) || '',
    title: str(raw.title, 80).replace(/\s+/g, ' '),
    description: str(raw.description, 1200),
    notes: str(raw.defects ?? raw.notes, 300),
    labelText,
    labelPhotos: labelPhotos.slice(0, 12),
    confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : null,
  };
}

/**
 * Fusionne la seconde passe « étiquette » dans le résultat principal SANS
 * écraser une valeur déjà trouvée (marque, taille, matières).
 */
export function mergeLabelPass(main, label) {
  const out = { ...main };
  if (!label) return out;
  if (label.labelText && !normalize(out.labelText || '').includes(normalize(label.labelText))) {
    out.labelText = [out.labelText, label.labelText].filter(Boolean).join(' | ').slice(0, 2000);
  }
  if (!out.brand && label.brand) {
    out.brand = label.brand;
    out.brandEvidence = label.brandEvidence || 'étiquette';
  }
  if (!out.size && label.size) out.size = label.size;
  if (!out.materials?.length && label.materials?.length) out.materials = label.materials.slice(0, 3);
  return out;
}

// ---------------------------------------------------------------------------
// Appels HTTP
// ---------------------------------------------------------------------------

async function callChat(cfg, model, messages, { fetchImpl, withExtras, json, timeoutMs }) {
  const body = { model, messages, ...(withExtras ? cfg.extra : {}) };
  if (json) body.response_format = { type: 'json_object' };
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  let res;
  let text;
  try {
    res = await fetchImpl(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify(body),
      signal: ctrl?.signal,
    });
    text = await res.text();
  } catch (err) {
    if (err?.name === 'AbortError') throw aiError("L'IA n'a pas répondu à temps", 'timeout');
    throw aiError('IA injoignable (connexion)', 'network', 0, err?.message || err);
  } finally {
    if (timer) clearTimeout(timer);
  }
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (_e) {
    data = null;
  }
  if (!res.ok) {
    const msg = data?.error?.message || data?.[0]?.error?.message || String(text || '').slice(0, 200) || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  const content = data?.choices?.[0]?.message?.content;
  if (Array.isArray(content)) return content.map((p) => p.text || '').join('');
  return content || '';
}

/** Nature d'une erreur HTTP de l'IA. */
function errorKind(err) {
  const msg = String(err?.message || '');
  const st = err?.status || 0;
  if (err?.code === 'timeout' || err?.code === 'network') return err.code;
  if (/location is not supported|not available in your (country|region)/i.test(msg)) return 'region';
  if (st === 401 || st === 403 || /api[ _-]?key (not valid|invalid|expired)|invalid api[ _-]?key|incorrect api key|api_key_invalid|permission denied|unauthenticated/i.test(msg)) return 'auth';
  if (st === 429 || /quota|rate limit|resource[ _]?exhausted|too many requests/i.test(msg)) return 'quota';
  if (st === 404 || /no such model|model[^.]{0,40}(not found|does not exist|unknown|invalid|not supported|unavailable)|(unknown|invalid|unsupported) model/i.test(msg)) return 'model';
  if (st === 413 || /payload (size|too large)|request (entity )?too large|exceeds the (maximum|limit)/i.test(msg)) return 'too-large';
  if (st >= 500) return 'server';
  if (st === 400 || st === 422) return 'bad';
  return 'other';
}

const QUOTA_MSG = 'Quota IA atteint (offre gratuite) — réessaie dans une minute';
const short = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 90);

/**
 * Appelle l'IA avec replis automatiques :
 *  - 1er essai avec les paramètres optionnels du fournisseur + mode JSON
 *    (response_format) ; s'il est refusé (400), 2e essai SANS paramètres
 *    optionnels ni response_format (vaut pour tous les fournisseurs) ;
 *  - modèle inconnu (404), surcharge (5xx) ou quota (429) : modèle suivant
 *    (chaque modèle a souvent son propre quota gratuit) ;
 *  - clé refusée, délai dépassé, réseau : arrêt immédiat.
 * opts.startModel = modèle à essayer d'abord, opts.plain = sauter le 1er essai,
 * opts.stopOnQuota = abandonner dès le premier 429.
 * Renvoie { text, model, quotaHit, plain }.
 */
export async function chatWithFallback(cfgIn, messages, opts = {}) {
  const { fetchImpl = (...a) => fetch(...a), json = true, timeoutMs = 60000, startModel = '', plain = false, stopOnQuota = false } = opts;
  const cfg = resolveAiConfig(cfgIn);
  if (!cfg.key) throw aiError('Aucune clé IA configurée', 'no-key');
  if (!cfg.baseUrl || !cfg.model) throw aiError('Adresse ou modèle IA manquant', 'config');
  let models = [cfg.model, ...cfg.fallbackModels.filter((m) => m !== cfg.model)];
  if (startModel) models = [startModel, ...models.filter((m) => m !== startModel)];
  let lastErr = null;
  let quotaHit = false;
  for (const model of models) {
    for (const full of plain ? [false] : [true, false]) {
      try {
        const text = await callChat(cfg, model, messages, { fetchImpl, withExtras: full, json: json && full, timeoutMs });
        return { text, model, quotaHit, plain: !full };
      } catch (err) {
        const kind = errorKind(err);
        if (kind === 'timeout' || kind === 'network') throw err;
        if (kind === 'auth') throw aiError('Clé IA refusée — vérifie-la dans les réglages', 'auth', err.status, err.message);
        if (kind === 'region') throw aiError('IA non disponible depuis ce pays', 'region', err.status, err.message);
        if (kind === 'too-large') throw aiError("Photos trop lourdes pour l'IA", 'too-large', err.status, err.message);
        if (kind === 'quota') {
          quotaHit = true;
          lastErr = aiError(QUOTA_MSG, 'quota', 429, err.message);
          if (stopOnQuota) throw lastErr;
          break; // modèle suivant
        }
        if (kind === 'model') {
          lastErr = aiError(`Modèle IA introuvable (${model})`, 'model', err.status, err.message);
          break;
        }
        if (kind === 'server') {
          lastErr = aiError(`Service IA indisponible (HTTP ${err.status})`, 'server', err.status, err.message);
          break;
        }
        if (kind === 'bad' && full) {
          lastErr = aiError(`Requête refusée par l'IA (${short(err.message)})`, 'bad', err.status, err.message);
          continue; // 2e essai : requête minimale, sans response_format
        }
        throw aiError(`Requête refusée par l'IA (${short(err.message) || `HTTP ${err.status}`})`, kind, err.status, err.message);
      }
    }
  }
  if (lastErr?.code === 'quota' || quotaHit) throw aiError(QUOTA_MSG, 'quota', 429, lastErr?.detail);
  throw lastErr || aiError('IA indisponible', 'other');
}

// ---------------------------------------------------------------------------
// Reconnaissance
// ---------------------------------------------------------------------------

/**
 * Choisit les photos envoyées à l'IA (indices d'origine, triés) : TOUTES les
 * photos marquées « étiquette » (même au-delà de la 8e), complétées par les
 * autres dans l'ordre, jusqu'à `max`.
 */
export function pickPhotosForAi(count, labelIndexes = [], max = MAX_AI_IMAGES) {
  const labels = [...new Set(labelIndexes)].filter((i) => Number.isInteger(i) && i >= 0 && i < count).slice(0, max);
  const picked = new Set(labels);
  for (let i = 0; i < count && picked.size < max; i += 1) picked.add(i);
  return [...picked].sort((a, b) => a - b);
}

/** images : dataURL, ou { url, index, label } → liste uniforme. */
function toImageList(images, labelIndexes = []) {
  const labels = new Set(labelIndexes);
  return (images || [])
    .map((img, i) => {
      if (typeof img === 'string') return { url: img, index: i, label: labels.has(i) };
      const index = Number.isInteger(img?.index) ? img.index : i;
      return { url: img?.url || img?.dataUrl || '', index, label: img?.label ?? labels.has(index) };
    })
    .filter((x) => x.url);
}

/**
 * Seconde passe : relit seulement les étiquettes (images en haute définition)
 * et renvoie { labelText, brand, brandEvidence, size, materials }.
 */
export async function readLabels({ images, hints = {}, config, fetchImpl, timeoutMs = 45000, startModel = '', plain = false } = {}) {
  const urls = (images || []).filter(Boolean).slice(0, MAX_LABEL_IMAGES);
  if (!urls.length) throw aiError("Aucune photo d'étiquette", 'input');
  const content = [{ type: 'text', text: buildLabelPrompt(hints, urls.length) }];
  for (const url of urls) content.push({ type: 'image_url', image_url: { url } });
  const res = await chatWithFallback(config, [{ role: 'user', content }], { fetchImpl, timeoutMs, startModel, plain, stopOnQuota: true });
  const r = normalizeAiResult(parseJsonLoose(res.text));
  if (!r) throw aiError("Réponse de l'IA illisible", 'parse');
  return { labelText: r.labelText, brand: r.brand, brandEvidence: r.brand ? r.brandEvidence || 'étiquette' : '', size: r.size, materials: r.materials, model: res.model };
}

/**
 * Reconnaît l'article.
 *  - images : dataURL JPEG, ou { url, index, label } (index = n° de la photo
 *    d'origine, label = marquée « étiquette » par le vendeur). Au plus 8.
 *  - labelImages(indices) : facultatif, renvoie les dataURL en haute
 *    définition des photos d'origine demandées (seconde passe) ; sinon on
 *    réutilise les images déjà envoyées.
 * Renvoie le résultat normalisé + { model, passes (1 ou 2), quotaHit,
 * labelError } ; labelPhotos est exprimé en indices de photos d'origine.
 */
export async function recognizeItem({ images, hints = {}, config, fetchImpl, timeoutMs, labelImages, labelTimeoutMs } = {}) {
  const list = toImageList(images, hints.labelIndexes || []);
  if (!list.length) throw aiError('Aucune photo à analyser', 'input');
  const sent = list.slice(0, MAX_AI_IMAGES);
  const labelSent = sent.map((x, i) => (x.label ? i : -1)).filter((i) => i >= 0);
  const content = [{ type: 'text', text: buildPrompt(hints, { count: sent.length, labelImages: labelSent }) }];
  for (const x of sent) content.push({ type: 'image_url', image_url: { url: x.url } });
  const main = await chatWithFallback(config, [{ role: 'user', content }], { fetchImpl, timeoutMs });
  const parsed = normalizeAiResult(parseJsonLoose(main.text));
  if (!parsed) throw aiError("Réponse de l'IA illisible", 'parse');
  // Indices renvoyés par l'IA (ordre d'envoi) → indices des photos d'origine.
  parsed.labelPhotos = parsed.labelPhotos.filter((i) => i < sent.length).map((i) => sent[i].index);
  let out = { ...parsed, model: main.model, passes: 1, quotaHit: main.quotaHit, labelError: '' };

  // Seconde passe « étiquette » : marque ou taille encore inconnue, et au moins une photo d'étiquette.
  const missing = (!out.brand && !hints.brand) || (!out.size && !hints.size);
  const sellerLabels = list.filter((x) => x.label).map((x) => x.index);
  const labelIdx = [...new Set([...sellerLabels, ...out.labelPhotos])].slice(0, MAX_LABEL_IMAGES);
  if (missing && labelIdx.length && !main.quotaHit) {
    try {
      const urls = labelImages ? await labelImages(labelIdx) : labelIdx.map((i) => list.find((x) => x.index === i)?.url);
      const lp = await readLabels({ images: (urls || []).filter(Boolean), hints, config, fetchImpl, timeoutMs: labelTimeoutMs ?? timeoutMs, startModel: main.model, plain: main.plain });
      out = { ...mergeLabelPass(out, lp), passes: 2 };
    } catch (err) {
      out.labelError = err.message;
      if (err.code === 'quota') out.quotaHit = true;
    }
  }
  return out;
}

/** Petit appel texte pour vérifier la clé. */
export async function testAi(config, { fetchImpl } = {}) {
  const { text, model } = await chatWithFallback(
    config,
    [{ role: 'user', content: 'Réponds en JSON, exactement {"ok":true} et rien d\'autre.' }],
    { fetchImpl, timeoutMs: 30000 },
  );
  const parsed = parseJsonLoose(text);
  if (!parsed?.ok) throw new Error(`Réponse inattendue : ${normalize(text).slice(0, 80)}`);
  return model;
}
