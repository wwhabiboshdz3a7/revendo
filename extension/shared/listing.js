/**
 * Revendo — composition d'annonce (titre, description, hashtags) et détections
 * textuelles (taille, marque, matières). Fonctions pures, testables en Node.
 */
import {
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

export function detectBrand(text, brands = BRANDS) {
  const t = ` ${normalize(text)} `;
  if (!t.trim()) return null;
  let best = null;
  for (const b of brands) {
    const nb = normalize(b);
    if (nb.length < 3 && !/[&]/.test(nb)) continue;
    const esc = nb.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rx = new RegExp(`(^|[^a-z0-9])${esc}($|[^a-z0-9])`);
    if (rx.test(t) && (!best || nb.length > normalize(best).length)) best = b;
  }
  return best;
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

/**
 * Description complète. Si `f.aiBody` est fourni (texte rédigé par l'IA), il
 * remplace la phrase d'intro générique. Les lignes « Taille : … » servent
 * aussi à Vinted, qui en déduit ses suggestions de taille/marque.
 */
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
 * Si `f.aiBody` est fourni (texte rédigé par l'IA), il remplace la phrase d'intro.
 */
export function buildDescription(f, { hashtags = 80, signature = '', rand = Math.random } = {}) {
  const def = findCategoryDef(f.category || f.title || '');
  const out = [];
  out.push(pick(OPENERS, rand), '');
  if (f.aiBody) {
    out.push(f.aiBody.trim());
  } else {
    let line = `Je vends ${withDeterminer(f.title || '', f.brand)}`;
    if (f.brand && !normalize(f.title || '').includes(normalize(f.brand))) line += ` de la marque ${f.brand}`;
    out.push(line + '.');
  }
  // Synthèse : seulement si elle apporte une info absente du titre (matière, couleur, taille…).
  const summary = summarySentence(f);
  const t = normalize(f.title || '');
  const adds = [f.brand, ...(f.colors || []), ...(f.materials || []), f.size].filter(Boolean).some((v) => !t.includes(normalize(v)));
  if (summary && adds) out.push(summary);
  if (!f.aiBody && CONDITION_TEXT[f.condition]) out.push(CONDITION_TEXT[f.condition]);
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
// Fusion des sources : indices saisis > IA > détection locale > défauts
// ---------------------------------------------------------------------------

export function mergeFields({ hints = {}, ai = null, local = null, defaults = {} }) {
  const first = (...vals) => vals.find((v) => v !== undefined && v !== null && String(v).trim() !== '');
  const firstArr = (...vals) => vals.find((v) => Array.isArray(v) && v.length) || [];
  const merged = {
    rayon: first(hints.rayon, ai?.rayon, local?.rayon, defaults.rayon) || '',
    category: first(hints.category, ai?.category, local?.category) || '',
    categoryPath: first(ai?.categoryPath) || '',
    brand: first(hints.brand, ai?.brand, local?.brand) || '',
    size: first(hints.size, ai?.size, local?.size) || '',
    colors: firstArr(hints.colors, ai?.colors, local?.colors).slice(0, 2),
    materials: firstArr(hints.materials, ai?.materials, local?.materials).slice(0, 3),
    condition: first(hints.condition, ai?.condition, defaults.condition) || 'Très bon état',
    package: first(hints.package, ai?.package) || '',
    title: first(hints.title, ai?.title) || '',
    aiBody: first(ai?.description) || '',
    notes: first(hints.notes, ai?.notes) || '',
    keywords: Array.isArray(hints.keywords) ? hints.keywords.slice(0, 12) : [],
    price: hints.price ?? '',
  };
  if (!RAYONS.includes(merged.rayon)) merged.rayon = '';
  if (!CONDITIONS.some((c) => c.name === merged.condition)) merged.condition = 'Très bon état';
  merged.colors = merged.colors.filter((c) => COLOR_NAMES.includes(c));
  merged.materials = merged.materials.filter((m) => MATERIALS.includes(m));
  // Sans catégorie (mode gratuit), le titre est composé APRÈS le choix de
  // catégorie sur Vinted (voir composeListing / RV_COMPOSE).
  if (!merged.title && merged.category) merged.title = buildTitle(merged);
  return merged;
}
