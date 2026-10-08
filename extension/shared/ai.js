/**
 * Revendo — reconnaissance de l'article à partir des photos via une IA
 * « compatible OpenAI » (Gemini gratuit, OpenAI, OpenRouter…), avec TA clé.
 * La réponse est ramenée aux valeurs EXACTES de Vinted (couleurs, matériaux,
 * états, rayons) avant d'être utilisée.
 */
import { CATEGORY_DEFS, COLOR_NAMES, CONDITIONS, MATERIALS, RAYONS } from './vinted-data.js';
import { matchVocab, normalize, normalizeColor } from './listing.js';

export const AI_PRESETS = {
  gemini: {
    label: 'Google Gemini (offre gratuite)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-flash-latest',
    fallbackModels: ['gemini-3.8-flash', 'gemini-3.5-flash-lite'],
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
    fallbackModels: [],
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

const PACKAGE_NAMES = ['Petit', 'Moyen', 'Grand'];

export function buildPrompt(hints = {}) {
  const cats = CATEGORY_DEFS.map((d) => d.kw).join(', ');
  const lines = [
    "Tu es un vendeur Vinted expérimenté. Analyse les photos d'UN SEUL article d'occasion à vendre et remplis la fiche.",
    'Règles :',
    '- Réponds UNIQUEMENT avec un objet JSON valide, sans texte autour.',
    `- "rayon" : un parmi ${RAYONS.join(' | ')}. Déduis-le de la coupe et du style ; pour un vêtement d'enfant, "Enfants".`,
    `- "category" : le nom de catégorie tel que Vinted l'écrit (au pluriel), de préférence parmi : ${cats}. Sinon un nom court au pluriel (ex. "Pulls ras de cou", "Vestes en jean").`,
    '- "category_path" : le chemin probable sans le rayon, ex. "Vêtements > Sweats et pulls".',
    "- \"brand\" : la marque UNIQUEMENT si elle est lisible (logo, étiquette, semelle). Sinon \"\". N'invente jamais.",
    '- "size" : la taille lue sur l\'étiquette, au format Vinted : lettres (XS, S, M, L, XL…), nombre (38, 42), jean "W30", enfant "10 ans", chaussure "42". Sinon "".',
    `- "colors" : 1 ou 2 couleurs parmi : ${COLOR_NAMES.join(', ')}.`,
    `- "materials" : 0 à 3 matières parmi : ${MATERIALS.join(', ')} — seulement si l'étiquette de composition est lisible ou si c'est évident (cuir, denim).`,
    `- "condition" : un parmi ${CONDITIONS.map((c) => c.name).join(' | ')}. "Neuf avec étiquette" seulement si une étiquette de magasin est attachée. Dans le doute : "Très bon état".`,
    `- "package" : ${PACKAGE_NAMES.join(' | ')} (Petit = tient dans une grande enveloppe, Moyen = boîte à chaussures, Grand = carton).`,
    '- "title" : titre Vinted court et précis (max 60 caractères) : type + marque + détail clé + couleur, ex. "Pull Nike col rond gris". Pas de taille, pas d\'emoji.',
    '- "description" : 2 à 4 phrases naturelles, à la première personne, en français, comme un particulier (coupe, matière, détails, défauts visibles). Pas de formule de politesse, pas de hashtags, pas de prix.',
    '- "defects" : défauts visibles (tache, trou, bouloches…) ou "".',
    '- "confidence" : 0 à 1, ta confiance globale.',
    'Format exact : {"rayon":"","category":"","category_path":"","brand":"","size":"","colors":[],"materials":[],"condition":"","package":"","title":"","description":"","defects":"","confidence":0}',
  ];
  const known = [];
  if (hints.rayon) known.push(`rayon imposé : ${hints.rayon}`);
  if (hints.brand) known.push(`marque connue : ${hints.brand}`);
  if (hints.size) known.push(`taille connue : ${hints.size}`);
  if (hints.condition) known.push(`état imposé : ${hints.condition}`);
  if (hints.notes) known.push(`note du vendeur : ${hints.notes}`);
  if (known.length) lines.push(`Informations déjà connues (à respecter) : ${known.join(' ; ')}.`);
  return lines.join('\n');
}

/** Extrait le premier objet JSON d'une réponse (gère ```json … ``` et le texte parasite). */
export function parseJsonLoose(text) {
  if (!text) return null;
  const s = String(text).replace(/```(?:json)?/gi, '').trim();
  try {
    return JSON.parse(s);
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

/** Ramène une réponse d'IA (parfois approximative) aux valeurs autorisées. */
export function normalizeAiResult(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const list = (v) => (Array.isArray(v) ? v : typeof v === 'string' && v ? v.split(/[,/]/) : []);
  const colors = [];
  for (const c of list(raw.colors ?? raw.color)) {
    const m = normalizeColor(c) || matchVocab(c, COLOR_NAMES);
    if (m && !colors.includes(m)) colors.push(m);
  }
  const materials = [];
  for (const c of list(raw.materials ?? raw.material)) {
    const m = matchVocab(c, MATERIALS);
    if (m && !materials.includes(m)) materials.push(m);
  }
  let size = str(raw.size, 16);
  if (/^(unknown|inconnu|n\/a|none|aucune?)$/i.test(size)) size = '';
  if (/^[a-z]{1,4}$/i.test(size) && /^(xxs|xs|s|m|l|xl|xxl|xxxl|[2-6]xl)$/i.test(size)) size = size.toUpperCase();
  let brand = str(raw.brand, 40);
  if (/^(unknown|inconnue?|n\/a|none|aucune?|sans marque|no brand|generic|générique)$/i.test(brand)) brand = '';
  const conf = Number(raw.confidence);
  return {
    rayon: matchVocab(raw.rayon, RAYONS) || '',
    category: str(raw.category, 50),
    categoryPath: str(raw.category_path ?? raw.categoryPath, 120),
    brand,
    size,
    colors: colors.slice(0, 2),
    materials: materials.slice(0, 3),
    condition: matchVocab(raw.condition, CONDITIONS.map((c) => c.name)) || '',
    package: matchVocab(raw.package, PACKAGE_NAMES) || '',
    title: str(raw.title, 80).replace(/\s+/g, ' '),
    description: str(raw.description, 1200),
    notes: str(raw.defects ?? raw.notes, 300),
    confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : null,
  };
}

async function callChat(cfg, model, messages, { fetchImpl, withExtras, json, timeoutMs }) {
  const body = { model, messages, ...(withExtras ? cfg.extra : {}) };
  if (json && cfg.preset === 'openai') body.response_format = { type: 'json_object' };
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  let res;
  try {
    res = await fetchImpl(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify(body),
      signal: ctrl?.signal,
    });
  } catch (err) {
    throw new Error(err?.name === 'AbortError' ? "L'IA n'a pas répondu à temps." : `IA injoignable (${err?.message || err}).`);
  } finally {
    if (timer) clearTimeout(timer);
  }
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (_e) {
    data = null;
  }
  if (!res.ok) {
    const msg = data?.error?.message || data?.[0]?.error?.message || text.slice(0, 200) || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  const content = data?.choices?.[0]?.message?.content;
  if (Array.isArray(content)) return content.map((p) => p.text || '').join('');
  return content || '';
}

/**
 * Appelle l'IA avec repli automatique : modèle de secours si le modèle est
 * inconnu (404/400 « model »), puis requête sans paramètres optionnels si le
 * fournisseur les refuse.
 */
export async function chatWithFallback(cfgIn, messages, { fetchImpl = (...a) => fetch(...a), json = true, timeoutMs = 60000 } = {}) {
  const cfg = resolveAiConfig(cfgIn);
  if (!cfg.key) throw new Error('Clé API IA manquante.');
  if (!cfg.baseUrl || !cfg.model) throw new Error('Adresse ou modèle IA manquant.');
  const models = [cfg.model, ...cfg.fallbackModels.filter((m) => m !== cfg.model)];
  let lastErr = null;
  for (const model of models) {
    for (const withExtras of [true, false]) {
      if (!withExtras && !Object.keys(cfg.extra).length && cfg.preset !== 'openai') continue;
      try {
        const out = await callChat(cfg, model, messages, { fetchImpl, withExtras, json: json && withExtras, timeoutMs });
        return { text: out, model };
      } catch (err) {
        lastErr = err;
        const msg = err.message || '';
        if (err.status === 401 || err.status === 403) throw new Error(`Clé IA refusée (${msg}).`);
        if (err.status === 429) {
          // Quota du modèle épuisé (offre gratuite) : un autre modèle a souvent son propre quota.
          lastErr = new Error("Quota IA atteint pour l'instant (offre gratuite : réessaie dans une minute).");
          break;
        }
        const modelProblem =
          err.status === 404 ||
          /no such model|model[^.]{0,40}(not found|does not exist|unknown|invalid|not supported|unavailable)|(unknown|invalid|unsupported) model/i.test(msg);
        if (modelProblem) break; // modèle suivant
        if (err.status === 400 && withExtras) continue; // réessaie sans paramètres optionnels
        throw err;
      }
    }
  }
  throw lastErr || new Error('IA indisponible.');
}

/**
 * Reconnaît l'article. images = dataURL JPEG (déjà réduites, ~1024 px).
 * Renvoie un résultat normalisé + le modèle utilisé.
 */
export async function recognizeItem({ images, hints = {}, config, fetchImpl, timeoutMs } = {}) {
  if (!images?.length) throw new Error('Aucune photo à analyser.');
  const content = [{ type: 'text', text: buildPrompt(hints) }];
  for (const url of images.slice(0, 6)) content.push({ type: 'image_url', image_url: { url } });
  const { text, model } = await chatWithFallback(config, [{ role: 'user', content }], { fetchImpl, timeoutMs });
  const parsed = parseJsonLoose(text);
  const result = normalizeAiResult(parsed);
  if (!result) throw new Error("Réponse de l'IA illisible.");
  return { ...result, model };
}

/** Petit appel texte pour vérifier la clé. */
export async function testAi(config, { fetchImpl } = {}) {
  const { text, model } = await chatWithFallback(
    config,
    [{ role: 'user', content: 'Réponds exactement {"ok":true} et rien d\'autre.' }],
    { fetchImpl, timeoutMs: 30000 },
  );
  const parsed = parseJsonLoose(text);
  if (!parsed?.ok) throw new Error(`Réponse inattendue : ${normalize(text).slice(0, 80)}`);
  return model;
}
