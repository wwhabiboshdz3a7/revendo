/**
 * Revendo — « Boost référencement » : optimisation LÉGITIME du contenu d'une
 * annonce pour la recherche Vinted, calculée localement (aucune API).
 *
 * Ce que Vinted documente lui-même (page « Contenu recommandé sur Vinted ») :
 * la recherche filtre puis classe les annonces selon la pertinence par rapport
 * à la requête (la DESCRIPTION sert à évaluer cette pertinence), l'« ontologie »
 * de l'article (catégorie, marque, taille, couleur, photos, attributs), l'état,
 * le prix, l'ancienneté, les interactions… et montre « de façon proportionnée »
 * les articles publiés en grand nombre d'un coup.
 *
 * On optimise donc ce qui dépend du vendeur et reste honnête : champs
 * complets, mots que les acheteurs tapent réellement, titre lisible, photos
 * suffisantes. Pas de republication en boucle, pas de faux engagement, pas
 * de mots-clés trompeurs : les suggestions ne valent que si elles sont VRAIES
 * pour l'article.
 */
import { BRANDS, CATEGORY_DEFS, GENERIC_HASHTAGS } from './vinted-data.js';
import { findCategoryDef, normalize, slug } from './listing.js';

/** Mots réellement tapés par les acheteurs, par catégorie (à n'utiliser que s'ils décrivent l'article). */
export const CATEGORY_KEYWORDS = {
  Pulls: ['col rond', 'col V', 'col roulé', 'maille', 'grosse maille', 'laine', 'oversize', 'cachemire', 'jacquard'],
  Sweats: ['sweat à capuche', 'hoodie', 'zippé', 'col rond', 'oversize', 'molleton', 'logo brodé', 'vintage'],
  Gilets: ['cardigan', 'boutonné', 'maille', 'long', 'court', 'laine'],
  'T-shirts': ['manches courtes', 'manches longues', 'col rond', 'imprimé', 'logo', 'basique', 'oversize', 'coton'],
  Polos: ['manches courtes', 'manches longues', 'logo brodé', 'piqué', 'coton'],
  Débardeurs: ['bretelles', 'côtelé', 'basique', 'coton'],
  Tops: ['crop top', 'dos nu', 'bretelles', 'manches longues', 'satin', 'dentelle'],
  Chemises: ['manches longues', 'manches courtes', 'à carreaux', 'rayée', 'oversize', 'lin', 'coton', 'col mao'],
  Robes: ['longue', 'midi', 'courte', 'fleurie', 'soirée', 'été', 'portefeuille', 'satin', 'bohème'],
  Jupes: ['longue', 'midi', 'courte', 'plissée', 'taille haute', 'portefeuille', 'en jean'],
  Combinaisons: ['combishort', 'salopette', 'longue', 'en jean', 'dos nu'],
  Jeans: ['slim', 'droit', 'mom', 'flare', 'large', 'taille haute', 'brut', 'délavé', 'W/L'],
  Pantalons: ['cargo', 'chino', 'large', 'tailleur', 'taille haute', 'droit', 'palazzo'],
  Joggings: ['bas de survêtement', 'molleton', 'resserré aux chevilles', 'logo', 'cargo'],
  Shorts: ['en jean', 'cycliste', 'taille haute', 'bermuda', 'sport'],
  Leggings: ['taille haute', 'sport', 'yoga', 'gainant', 'push up'],
  Manteaux: ['long', 'laine', 'trench', 'caban', 'doublé', 'hiver', 'à capuche'],
  Doudounes: ['légère', 'à capuche', 'sans manches', 'longue', 'duvet', 'hiver'],
  Vestes: ['en jean', 'en cuir', 'bomber', 'coupe-vent', 'teddy', 'perfecto', 'imperméable'],
  Blazers: ['oversize', 'croisé', 'cintré', 'tailleur', 'laine'],
  Baskets: ['pointure', 'basses', 'montantes', 'running', 'cuir', 'blanches', 'semelle'],
  Bottes: ['pointure', 'à talon', 'plates', 'cuir', 'cavalières', 'chelsea', 'santiags'],
  Sandales: ['pointure', 'à talon', 'plates', 'compensées', 'cuir', 'nu-pieds'],
  Escarpins: ['pointure', 'talon aiguille', 'talon carré', 'bout pointu', 'vernis'],
  Mocassins: ['pointure', 'cuir', 'daim', 'à glands', 'plateforme'],
  Ballerines: ['pointure', 'cuir', 'vernies', 'à bride'],
  'Sacs à main': ['bandoulière', 'cuir', 'cabas', 'porté épaule', 'porté main', 'zippé'],
  'Sacs à dos': ['ordinateur', 'école', 'imperméable', 'grande contenance'],
  'Sacs bandoulière': ['pochette', 'banane', 'chaîne', 'cuir', 'besace'],
  Montres: ['automatique', 'quartz', 'bracelet cuir', 'acier', 'chronographe'],
  Bijoux: ['argent 925', 'plaqué or', 'acier inoxydable', 'pendentif', 'créoles'],
};

/** Variantes que les acheteurs tapent pour le même article. */
const SYNONYMS = [
  ['pull', ['sweater', 'tricot']],
  ['sweat', ['hoodie', 'sweatshirt']],
  ['baskets', ['sneakers']],
  ['jean', ['denim']],
  ['veste', ['blouson']],
  ['doudoune', ['puffer']],
  ['t-shirt', ['tee-shirt', 'tee']],
  ['jogging', ['bas de survêtement']],
  ['sac à main', ['sac']],
];

const FILLER = ['magnifique', 'superbe', 'sublime', 'trop beau', 'trop belle', 'canon', 'urgent', 'promo', 'à saisir', 'bon plan', 'mega', 'méga', 'super prix', 'wow'];
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Le titre nomme-t-il déjà le type d'article (« Sac » suffit pour « Sac bandoulière ») ? */
const namesType = (text, def) => !def || [def.title, def.kw, def.title.split(' ')[0]].some((w) => has(text, w));

const wordCount = (s) => (String(s || '').match(/[\p{L}\p{N}]+/gu) || []).length;
const has = (text, term) => {
  const t = ` ${normalize(text).replace(/[^a-z0-9]+/g, ' ')} `;
  const w = normalize(term).replace(/[^a-z0-9]+/g, ' ').trim();
  return !!w && (t.includes(` ${w} `) || t.includes(` ${w}s `) || t.includes(` ${w.replace(/s$/, '')} `));
};

function bodyOf(description) {
  // Le texte « utile » de la description, sans la ligne de hashtags.
  return String(description || '')
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
}

export function hashtagStats(description, fields = {}) {
  const tags = (String(description || '').match(/#[\p{L}\p{N}_]+/gu) || []).map((t) => slug(t.slice(1)));
  const generic = new Set(GENERIC_HASHTAGS.map(slug));
  const own = new Set(
    [fields.brand, fields.category, fields.size && `taille${fields.size}`, ...(fields.colors || []), ...(fields.materials || []), ...(findCategoryDef(fields.category || fields.title || '')?.tags || [])]
      .filter(Boolean)
      .map(slug),
  );
  const relevant = tags.filter((t) => own.has(t) || (fields.brand && t.startsWith(slug(fields.brand))));
  return { total: tags.length, relevant: relevant.length, generic: tags.filter((t) => generic.has(t)).length };
}

/**
 * Analyse une fiche. fields = { title, description, category, brand, size,
 * condition, colors, materials, price, package }, photoCount = nombre de photos.
 * Renvoie { score, grade, checks, keywords, synonyms, optimizedTitle, tips }.
 */
export function analyzeListing(fields = {}, { photoCount = 0, needsSize = true } = {}) {
  const f = { colors: [], materials: [], ...fields };
  const def = findCategoryDef(f.category || f.title || '');
  const title = String(f.title || '').trim();
  const body = bodyOf(f.description);
  const words = wordCount(body);
  const tStats = hashtagStats(f.description, f);
  const checks = [];
  const add = (id, label, weight, ratio, tip) => checks.push({ id, label, weight, earned: Math.round(weight * Math.max(0, Math.min(1, ratio))), ok: ratio >= 1, tip: ratio >= 1 ? '' : tip });

  // --- Champs structurés (« ontologie » Vinted : filtres et pertinence) ---
  add('category', 'Catégorie précise', 12, f.category ? 1 : 0, "Choisis la catégorie la plus précise : c'est elle qui place l'annonce dans les filtres.");
  add('brand', 'Marque renseignée', 10, f.brand ? 1 : 0, 'Renseigne la marque (ou « Sans marque ») : beaucoup d’acheteurs filtrent par marque.');
  add('size', 'Taille renseignée', 8, !needsSize || f.size ? 1 : 0, 'Indique la taille exacte de l’étiquette : sans elle, l’annonce sort des recherches filtrées par taille.');
  add('condition', 'État indiqué', 5, f.condition ? 1 : 0, 'Choisis l’état : Vinted s’en sert pour montrer les articles aux acheteurs qui filtrent par état.');
  add('colors', 'Couleur', 5, f.colors.length ? 1 : 0, 'Ajoute la couleur principale (filtre très utilisé).');
  add('materials', 'Matière', 3, f.materials.length ? 1 : 0, 'Ajoute la matière si elle est lisible sur l’étiquette (coton, laine…).');

  // --- Photos ---
  add('photos', 'Au moins 5 photos', 12, photoCount >= 5 ? 1 : photoCount / 5, `Ajoute ${Math.max(0, 5 - photoCount)} photo(s) : face, dos, étiquette, détails, défauts éventuels.`);

  // --- Titre : les mots que l'acheteur tape ---
  const typeWord = def ? def.title : '';
  add('titleType', 'Type d’article dans le titre', 8, namesType(title, def) ? (title ? 1 : 0) : 0, `Commence le titre par le type d'article (« ${typeWord || 'Pull, Robe, Baskets…'} »).`);
  add('titleBrand', 'Marque dans le titre', 7, !f.brand || has(title, f.brand) ? (title ? 1 : 0) : 0, `Mets « ${f.brand} » dans le titre : c'est souvent le premier mot recherché.`);
  add('titleSize', 'Taille dans le titre', 3, !f.size || has(title, f.size) ? (title ? 1 : 0) : 0, `Ajoute « taille ${f.size} » au titre${def?.shoes ? ' (indispensable pour des chaussures)' : ''}.`);
  const len = title.length;
  add('titleLength', 'Titre clair (25 à 70 caractères)', 4, len >= 25 && len <= 70 ? 1 : len ? 0.5 : 0, len < 25 ? 'Titre trop court : ajoute un détail (couleur, coupe, modèle).' : 'Titre trop long : garde l’essentiel, le reste va dans la description.');
  const filler = FILLER.filter((w) => has(title, w));
  const shouty = /!{2,}|[A-ZÀ-Ü]{6,}/.test(f.brand ? title.replace(new RegExp(esc(f.brand), 'ig'), '') : title);
  add('titleClean', 'Titre sans mots creux ni majuscules', 3, !filler.length && !shouty ? 1 : 0, `Retire ${filler.length ? `« ${filler.join(', ')} »` : 'les majuscules et « !!! »'} : personne ne les recherche.`);

  // --- Description : Vinted l'utilise pour juger la pertinence ---
  add('descLength', 'Description détaillée (≥ 60 mots)', 10, words >= 60 ? 1 : words / 60, 'Décris coupe, matière, mesures, état et défauts : plus de détails vrais = plus de recherches qui te trouvent.');
  const mentions = [f.brand, f.size, typeWord].filter(Boolean);
  const mentioned = mentions.filter((m) => has(body, m)).length;
  add('descTerms', 'Marque, type et taille repris dans le texte', 5, mentions.length ? mentioned / mentions.length : 1, 'Reprends marque, type d’article et taille dans la description.');
  const flaws = /d[ée]faut|tache|trou|bouloch|usure|aucun d[ée]faut|parfait [ée]tat|jamais port/i.test(body);
  add('descCondition', 'État / défauts décrits', 3, flaws ? 1 : 0, 'Précise l’état réel (« aucun défaut », « petite bouloche »…) : ça rassure et évite les litiges.');

  // --- Bourrage de hashtags : du bruit sans rapport avec l'article ---
  const stuffing = tStats.total > 25 && tStats.relevant / Math.max(1, tStats.total) < 0.3;
  add('hashtags', 'Hashtags pertinents', 2, stuffing ? 0 : 1, `${tStats.total} hashtags dont ${tStats.relevant} liés à l'article : garde surtout ceux qui décrivent vraiment l'article.`);

  const max = checks.reduce((s, c) => s + c.weight, 0);
  const score = Math.round((checks.reduce((s, c) => s + c.earned, 0) / max) * 100);
  const grade = score >= 85 ? 'Excellent' : score >= 70 ? 'Bon' : score >= 50 ? 'Moyen' : 'À améliorer';

  // --- Suggestions de mots-clés (absents du titre ET du texte) ---
  const text = `${title}\n${body}`;
  const pool = (def && CATEGORY_KEYWORDS[def.kw]) || [];
  const keywords = pool.filter((k) => !has(text, k) && k !== 'W/L' && k !== 'pointure').slice(0, 8);
  if (def?.shoes && f.size && !/pointure/i.test(text)) keywords.unshift(`pointure ${f.size}`);
  if (def?.kw === 'Jeans' && !/\bW\d{2}/i.test(text)) keywords.unshift('taille W/L');
  const synonyms = [];
  for (const [base, alts] of SYNONYMS) {
    if (has(text, base)) for (const a of alts) if (!has(text, a)) synonyms.push(a);
  }

  return {
    score,
    grade,
    checks: checks.filter((c) => c.weight > 0),
    todo: checks.filter((c) => c.weight > 0 && !c.ok).sort((a, b) => b.weight - b.earned - (a.weight - a.earned)),
    keywords,
    synonyms: synonyms.slice(0, 5),
    optimizedTitle: optimizeTitle(title, f),
    hashtags: tStats,
  };
}

/**
 * Titre réorganisé façon recherche Vinted : Type + Marque + détail + couleur
 * + taille, en ne réutilisant QUE des informations déjà présentes dans la fiche.
 */
export function optimizeTitle(title, f = {}) {
  const def = findCategoryDef(f.category || title || '');
  let t = String(title || '').replace(/\s+/g, ' ').trim();
  for (const w of FILLER) t = t.replace(new RegExp(`(^|\\s)${esc(w)}(?=\\s|$)`, 'gi'), ' ');
  t = t.replace(/!+/g, '').replace(/\s+/g, ' ').trim();
  if (!t && def) t = def.title;
  if (def && !namesType(t, def)) t = `${def.title} ${t}`.trim();
  if (f.brand && !has(t, f.brand)) {
    const parts = t.split(' ');
    t = [parts[0], f.brand, ...parts.slice(1)].join(' ');
  }
  if (f.colors?.[0] && !has(t, f.colors[0]) && t.length < 52) t = `${t} ${f.colors[0].toLowerCase()}`;
  if (f.size && !has(t, f.size) && t.length < 60) t = `${t} ${def?.shoes ? 'pointure' : 'taille'} ${f.size}`;
  // Majuscules criardes → casse normale (sauf sigles courts et marque).
  t = t.replace(/\b([A-ZÀ-Ü]{4,})\b/g, (m) => (f.brand && normalize(m) === normalize(f.brand) ? m : m.charAt(0) + m.slice(1).toLowerCase()));
  return t.charAt(0).toUpperCase() + t.slice(1, 80);
}

/** Conseils généraux, honnêtes et conformes aux règles Vinted. */
export const SEO_TIPS = [
  'Publie au fil de l’eau plutôt que 30 annonces d’un coup : Vinted indique montrer « de façon proportionnée » les articles publiés en grand nombre en peu de temps.',
  'Une annonce neuve profite naturellement de sa fraîcheur : soigne-la AVANT de publier. Supprimer/republier en boucle pour remonter est mal vu et peut être sanctionné.',
  'Un prix cohérent avec les annonces similaires compte : Vinted utilise le prix pour mettre en avant les bonnes affaires.',
  'Réponds vite aux messages et aux offres : l’intérêt réel (clics, favoris, messages) fait partie des critères de classement.',
  'N’ajoute que des mots-clés vrais pour l’article : un mot trompeur attire des clics sans achat et des litiges.',
];

export { BRANDS, CATEGORY_DEFS };
