/**
 * Revendo — lecture des étiquettes SANS IA : repérage des zones de texte dans
 * la photo, puis lecture (Tesseract) de chaque zone recadrée, agrandie,
 * passée en noir sur blanc et remise à l'endroit.
 *
 * Pourquoi : lue en entier, une photo d'étiquette donne surtout du bruit (la
 * maille, la moquette et les pois ressemblent à des lettres) et le texte d'une
 * étiquette fait souvent moins de 20 px de haut, parfois à l'envers ou en
 * blanc sur fond marine. Recadrée et agrandie, la même étiquette se lit.
 *
 * Repérage (fonctions pures, testables en Node) : seuil local (Sauvola) dans
 * les deux polarités, composantes connexes de la taille d'une lettre, au
 * contraste net et posées sur un fond UNI (l'étiquette, pas la maille), puis
 * alignées en lignes horizontales ou verticales (texte tourné de 90°).
 * S'y ajoutent les mots déjà bien lus sur la photo entière (« graines »).
 */

// ---------------------------------------------------------------------------
// Repérage des zones de texte
// ---------------------------------------------------------------------------

const MIN_CONTRAST = 50; // écart encre / fond (0–255)
const MAX_RING_SD = 30; // fond autour de la lettre : uni (étiquette), pas une texture

/** Luminance (0–255) d'une image RGBA { data, width, height }. */
export function toGray(img) {
  const n = img.width * img.height;
  const g = new Float32Array(n);
  const d = img.data;
  for (let i = 0; i < n; i += 1) g[i] = (d[i * 4] * 299 + d[i * 4 + 1] * 587 + d[i * 4 + 2] * 114) / 1000;
  return g;
}

function integral(g, w, h) {
  const W = w + 1;
  const s = new Float64Array(W * (h + 1));
  const s2 = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y += 1) {
    let row = 0;
    let row2 = 0;
    for (let x = 0; x < w; x += 1) {
      const v = g[y * w + x];
      row += v;
      row2 += v * v;
      s[(y + 1) * W + x + 1] = s[y * W + x + 1] + row;
      s2[(y + 1) * W + x + 1] = s2[y * W + x + 1] + row2;
    }
  }
  return { s, s2 };
}

/** Masque « encre » : polarity 1 = sombre sur clair, -1 = clair sur sombre (seuil local, rayon r). */
function binarize(g, w, h, I, polarity, r) {
  const m = new Uint8Array(w * h);
  const W = w + 1;
  for (let y = 0; y < h; y += 1) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x += 1) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const cnt = (x1 - x0) * (y1 - y0);
      const sum = I.s[y1 * W + x1] - I.s[y0 * W + x1] - I.s[y1 * W + x0] + I.s[y0 * W + x0];
      const sum2 = I.s2[y1 * W + x1] - I.s2[y0 * W + x1] - I.s2[y1 * W + x0] + I.s2[y0 * W + x0];
      const mean = sum / cnt;
      const sd = Math.sqrt(Math.max(0, sum2 / cnt - mean * mean));
      if (sd < 9) continue; // zone uniforme : pas de texte
      const v = g[y * w + x];
      const gap = Math.max(18, 0.5 * sd);
      if (polarity > 0 ? v < mean - gap : v > mean + gap) m[y * w + x] = 1;
    }
  }
  return m;
}

/** Composantes connexes (8 voisins) : boîte, nombre de pixels, luminance moyenne de l'encre. */
function components(mask, g, w, h) {
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const comps = [];
  for (let start = 0; start < w * h; start += 1) {
    if (!mask[start] || seen[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;
    let x0 = w;
    let y0 = h;
    let x1 = 0;
    let y1 = 0;
    let n = 0;
    let gs = 0;
    while (sp) {
      const p = stack[--sp];
      const x = p % w;
      const y = (p - x) / w;
      n += 1;
      gs += g[p];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy += 1) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const q = yy * w + x + dx;
          if (x + dx < 0 || x + dx >= w || !mask[q] || seen[q]) continue;
          seen[q] = 1;
          stack[sp++] = q;
        }
      }
    }
    comps.push({ x0, y0, x1: x1 + 1, y1: y1 + 1, n, ink: gs / n });
  }
  return comps;
}

/** Fond autour d'une composante (cadre un peu plus grand que sa boîte) : moyenne et écart type. */
function ringStats(g, w, h, c) {
  const pad = Math.max(2, Math.round(Math.min(c.x1 - c.x0, c.y1 - c.y0) * 0.4));
  const X0 = Math.max(0, c.x0 - pad);
  const Y0 = Math.max(0, c.y0 - pad);
  const X1 = Math.min(w, c.x1 + pad);
  const Y1 = Math.min(h, c.y1 + pad);
  let s = 0;
  let s2 = 0;
  let k = 0;
  const add = (v) => {
    s += v;
    s2 += v * v;
    k += 1;
  };
  for (let x = X0; x < X1; x += 1) {
    add(g[Y0 * w + x]);
    add(g[(Y1 - 1) * w + x]);
  }
  for (let y = Y0; y < Y1; y += 1) {
    add(g[y * w + X0]);
    add(g[y * w + X1 - 1]);
  }
  const mean = s / k;
  return { mean, sd: Math.sqrt(Math.max(0, s2 / k - mean * mean)) };
}

/** Taille et forme d'une lettre (ni un point, ni un trait de couture, ni une grande tache). */
function charLike(c, w, h) {
  const cw = c.x1 - c.x0;
  const ch = c.y1 - c.y0;
  const big = Math.max(cw, ch);
  const small = Math.min(cw, ch);
  if (big < 7 || big > Math.min(w, h) / 8) return false;
  if (c.x0 === 0 || c.y0 === 0 || c.x1 === w || c.y1 === h) return false;
  const fill = c.n / (cw * ch);
  if (fill < 0.12 || fill > 0.92) return false;
  if (small / big < 0.08) return big <= 40; // « I », « l », « 1 » : fins mais courts
  return true;
}

/**
 * Lignes : lettres de hauteur proche, alignées et peu espacées. dir 'h' :
 * ligne horizontale ; 'v' : verticale (étiquette tournée de 90°).
 */
function linesOf(cs, dir) {
  const A = dir === 'h' ? (c) => ({ a0: c.x0, a1: c.x1, b0: c.y0, b1: c.y1 }) : (c) => ({ a0: c.y0, a1: c.y1, b0: c.x0, b1: c.x1 });
  const items = cs.map((c, i) => ({ i, ...A(c) })).sort((p, q) => p.a0 - q.a0);
  const parent = items.map((_, k) => k);
  const find = (k) => {
    while (parent[k] !== k) {
      parent[k] = parent[parent[k]];
      k = parent[k];
    }
    return k;
  };
  for (let p = 0; p < items.length; p += 1) {
    const P = items[p];
    const ph = P.b1 - P.b0;
    for (let q = p + 1; q < items.length; q += 1) {
      const Q = items[q];
      const qh = Q.b1 - Q.b0;
      const H = Math.max(ph, qh);
      if (Q.a0 - P.a1 > 1.6 * H) break;
      if (H / Math.max(1, Math.min(ph, qh)) > 1.8) continue;
      const overlap = Math.min(P.b1, Q.b1) - Math.max(P.b0, Q.b0);
      if (overlap < 0.55 * Math.min(ph, qh)) continue;
      if (Q.a0 - P.a1 < -0.3 * H) continue;
      parent[find(q)] = find(p);
    }
  }
  const groups = new Map();
  items.forEach((it, k) => {
    const r = find(k);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(cs[it.i]);
  });
  return [...groups.values()];
}

const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] || 0;
};

/**
 * Direction de lecture d'une ligne (degrés, sens horaire depuis l'axe des x,
 * y vers le bas) : droite des moindres carrés par les centres des lettres.
 * Ligne horizontale penchée de 5° : 5 ; ligne verticale qui descend : ~90.
 */
function lineAngle(line, dir) {
  const pts = line.map((c) => [(c.x0 + c.x1) / 2, (c.y0 + c.y1) / 2]);
  const [a, b] = dir === 'h' ? [0, 1] : [1, 0];
  const ma = pts.reduce((s, p) => s + p[a], 0) / pts.length;
  const mb = pts.reduce((s, p) => s + p[b], 0) / pts.length;
  let cov = 0;
  let va = 0;
  for (const p of pts) {
    cov += (p[a] - ma) * (p[b] - mb);
    va += (p[a] - ma) ** 2;
  }
  const slope = va > 0 ? Math.max(-0.6, Math.min(0.6, cov / va)) : 0; // ±31° au plus
  const deg = (Math.atan(slope) * 180) / Math.PI;
  return dir === 'h' ? deg : 90 - deg;
}

function bounds(list) {
  return {
    x0: Math.min(...list.map((c) => c.x0)),
    y0: Math.min(...list.map((c) => c.y0)),
    x1: Math.max(...list.map((c) => c.x1)),
    y1: Math.max(...list.map((c) => c.y1)),
  };
}

/**
 * Zones de texte probables (étiquettes, tickets, inscriptions), les plus sûres
 * d'abord : [{ x0, y0, x1, y1, dir: 'h'|'v', polarity: 1|-1, charH, n, score }].
 */
export function findTextRegions(img, { maxRegions = 6 } = {}) {
  const { width: w, height: h } = img;
  if (!w || !h) return [];
  const g = toGray(img);
  const I = integral(g, w, h);
  const r = Math.max(8, Math.round(Math.min(w, h) / 60));
  const lines = [];
  for (const polarity of [1, -1]) {
    const comps = components(binarize(g, w, h, I, polarity, r), g, w, h).filter((c) => charLike(c, w, h));
    const strong = [];
    for (const c of comps) {
      const ring = ringStats(g, w, h, c);
      c.contrast = Math.abs(ring.mean - c.ink);
      if (c.contrast >= MIN_CONTRAST && ring.sd <= MAX_RING_SD) strong.push(c);
    }
    for (const dir of ['h', 'v']) {
      for (const line of linesOf(strong, dir)) {
        // 3 lettres au moins ; 2 suffisent si elles sont très nettes (« XL », « 38 »).
        if (line.length < 2 || (line.length === 2 && line.some((c) => c.contrast < 80))) continue;
        const charH = median(line.map((c) => (dir === 'h' ? c.y1 - c.y0 : c.x1 - c.x0)));
        const contrast = median(line.map((c) => c.contrast));
        lines.push({ ...bounds(line), dir, polarity, charH, angle: lineAngle(line, dir), n: line.length, score: line.length * contrast });
      }
    }
  }
  return mergeRegions(lines).slice(0, maxRegions);
}

/**
 * Regroupe les zones d'une même ligne ou qui se touchent (même sens, hauteur
 * de lettre comparable) : « TOMMY » et « HILFIGER » séparés par le drapeau
 * donnent une seule zone. Les graines (polarity 0) prennent la polarité voisine.
 */
export function mergeRegions(regions) {
  const out = [];
  for (const r of [...regions].sort((a, b) => b.score - a.score)) {
    const along = 4 * r.charH;
    const across = 1.2 * r.charH;
    const hit = out.find((o) => {
      if (o.dir !== r.dir || (o.polarity && r.polarity && o.polarity !== r.polarity)) return false;
      if (Math.max(o.charH, r.charH) / Math.max(1, Math.min(o.charH, r.charH)) > 2) return false;
      if (Math.abs((o.angle || 0) - (r.angle || 0)) > 6) return false; // étiquette courbée : chaque partie redressée à part
      const [ax, ay] = r.dir === 'h' ? [along, across] : [across, along];
      return r.x0 < o.x1 + ax && r.x1 > o.x0 - ax && r.y0 < o.y1 + ay && r.y1 > o.y0 - ay;
    });
    if (hit) {
      Object.assign(hit, {
        x0: Math.min(hit.x0, r.x0),
        y0: Math.min(hit.y0, r.y0),
        x1: Math.max(hit.x1, r.x1),
        y1: Math.max(hit.y1, r.y1),
        charH: Math.max(hit.charH, r.charH),
        n: (hit.n || 0) + (r.n || 0),
        score: hit.score + r.score,
        polarity: hit.polarity || r.polarity,
        seed: hit.seed || r.seed,
      });
    } else {
      out.push({ ...r });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

const alnum = (t) => (String(t || '').match(/[\p{L}\p{N}]/gu) || []).length;

/** Mots déjà bien lus sur la photo entière : on relira leur zone de plus près. */
export function seedRegions(words) {
  return (words || [])
    .filter((w) => w?.bbox && ((w.confidence >= 80 && alnum(w.text) >= 2) || (w.confidence >= 70 && alnum(w.text) >= 4)))
    .map((w) => ({
      x0: w.bbox.x0,
      y0: w.bbox.y0,
      x1: w.bbox.x1,
      y1: w.bbox.y1,
      charH: Math.max(6, w.bbox.y1 - w.bbox.y0),
      dir: 'h',
      angle: 0,
      polarity: 0,
      seed: true,
      n: alnum(w.text),
      score: 2000 + w.confidence * alnum(w.text),
    }));
}

/**
 * Recadrage d'une zone : marges (2 à 3 hauteurs de lettre), agrandissement
 * pour viser ~32 px par lettre (×3 au plus, 1400 px au plus), noir sur blanc,
 * rotations à essayer (sens horaire, en degrés) pour remettre la ligne
 * droite : dans son sens de lecture, puis retournée (étiquette à l'envers).
 */
export function planCrop(region, width, height) {
  const along = 3 * region.charH;
  const across = 2 * region.charH;
  const [mx, my] = region.dir === 'h' ? [along, across] : [across, along];
  const box = {
    x0: Math.max(0, Math.floor(region.x0 - mx)),
    y0: Math.max(0, Math.floor(region.y0 - my)),
    x1: Math.min(width, Math.ceil(region.x1 + mx)),
    y1: Math.min(height, Math.ceil(region.y1 + my)),
  };
  const side = Math.max(1, box.x1 - box.x0, box.y1 - box.y0);
  const scale = Math.max(1, Math.min(32 / Math.max(8, region.charH), 3, 1400 / side));
  const turn = (deg) => {
    const d = Math.round((((deg % 360) + 540) % 360) - 180);
    return d === -180 ? 180 : d;
  };
  const angle = region.angle ?? (region.dir === 'h' ? 0 : 90);
  const rotations = region.seed ? [0] : [turn(-angle), turn(180 - angle)];
  return { box, side, scale, invert: region.polarity < 0, rotations };
}

// ---------------------------------------------------------------------------
// Retouche d'un recadrage (pixels RGBA modifiés sur place)
// ---------------------------------------------------------------------------

/**
 * Gris, contraste étiré (1 % des pixels saturés de chaque côté), inversion
 * (texte clair sur fond sombre → noir sur blanc) et accentuation facultative
 * (étiquette tissée floue). Les pixels transparents (coins d'une rotation)
 * deviennent blancs.
 */
export function prepareForOcr(img, { invert = false, sharpen = 0 } = {}) {
  const { width: w, height: h, data } = img;
  const n = w * h;
  let g = new Float32Array(n);
  const hist = new Uint32Array(256);
  let opaque = 0;
  for (let i = 0; i < n; i += 1) {
    if (data[i * 4 + 3] < 128) {
      g[i] = -1;
      continue;
    }
    const v = (data[i * 4] * 299 + data[i * 4 + 1] * 587 + data[i * 4 + 2] * 114) / 1000;
    g[i] = v;
    hist[Math.round(v)] += 1;
    opaque += 1;
  }
  let lo = 0;
  let hi = 255;
  for (let acc = 0; lo < 255 && (acc += hist[lo]) < opaque * 0.01; lo += 1);
  for (let acc = 0; hi > 0 && (acc += hist[hi]) < opaque * 0.01; hi -= 1);
  const k = 255 / Math.max(1, hi - lo);
  for (let i = 0; i < n; i += 1) {
    if (g[i] < 0) {
      g[i] = invert ? 0 : 255; // blanc une fois inversé
      continue;
    }
    g[i] = Math.max(0, Math.min(255, (g[i] - lo) * k));
  }
  if (sharpen > 0) g = unsharp(g, w, h, sharpen);
  for (let i = 0; i < n; i += 1) {
    const v = invert ? 255 - g[i] : g[i];
    data[i * 4] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  return img;
}

/** Masque flou : g + amount × (g − flou), flou = boîte 3×3 appliquée deux fois. */
function unsharp(g, w, h, amount) {
  const box = (src) => {
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        let s = 0;
        let c = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx += 1) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            s += src[yy * w + xx];
            c += 1;
          }
        }
        out[y * w + x] = s / c;
      }
    }
    return out;
  };
  const b = box(box(g));
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i += 1) out[i] = Math.max(0, Math.min(255, g[i] + amount * (g[i] - b[i])));
  return out;
}

// ---------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------

/**
 * Texte utile d'une lecture Tesseract : une ligne par ligne lue, sans les
 * « mots » peu sûrs que produit la texture du tissu (confiance < 55, sauf mots
 * d'au moins 4 caractères, gardés dès 35 pour la détection tolérante de la
 * marque). score = caractères lus avec une bonne confiance. lines = lignes
 * lues avec leur hauteur (px de la photo) et leur confiance, pour repérer le
 * texte le plus gros d'une étiquette (souvent la marque).
 */
export function usefulText(data, { scale = 1 } = {}) {
  if (!Array.isArray(data?.blocks)) return { text: data?.text || '', score: 0, lines: [], words: [] };
  const lines = [];
  const words = [];
  let score = 0;
  for (const block of data.blocks) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        words.push(...(line.words || []));
        const kept = (line.words || []).filter((w) => w.confidence >= 55 || (alnum(w.text) >= 4 && w.confidence >= 35));
        if (!kept.length) continue;
        const text = kept.map((w) => w.text).join(' ');
        const hs = kept.filter((w) => w.bbox).map((w) => w.bbox.y1 - w.bbox.y0);
        lines.push({ text, h: hs.length ? median(hs) / scale : 0, conf: kept.reduce((s, w) => s + w.confidence, 0) / kept.length });
        for (const w of kept) if (w.confidence >= 70 && alnum(w.text) >= 3) score += alnum(w.text);
      }
    }
  }
  return { text: lines.map((l) => l.text).join('\n'), score, lines, words };
}

/**
 * Façons de relire une zone, de la plus rapide à la plus poussée : telle
 * quelle ; agrandie ×2 et accentuée (étiquette tissée floue) ; mode « bloc »
 * de Tesseract (quand le mode « texte épars » ne découpe pas la ligne).
 */
const ZONE_READS = [
  { boost: false, psm: '11' },
  { boost: true, psm: '11' },
  { boost: false, psm: '6' },
];

/**
 * Zone juste sous une étiquette de marque, dans le sens de lecture : la
 * petite étiquette de taille (« L/G », « S/P », « M » + « MADE IN … ») y est
 * souvent cousue (Tommy Hilfiger, Ralph Lauren, Gap…), trop petite pour être
 * repérée seule. rotate : rotation qui a permis de lire la marque (180 =
 * étiquette à l'envers, « dessous » est alors au-dessus sur la photo).
 * Renvoie la boîte (pixels de la photo) ou null.
 */
export function belowBox(region, rotate, width, height) {
  if (region.dir !== 'h' || Math.abs(region.angle || 0) > 20) return null;
  const w = region.x1 - region.x0;
  const ch = Math.max(6, region.charH);
  const up = Math.abs(rotate || 0) > 90;
  const x0 = Math.max(0, Math.floor(region.x0 - 0.15 * w));
  const x1 = Math.min(width, Math.ceil(region.x1 + 0.15 * w));
  const [ya, yb] = up ? [region.y0 - 10 * ch, region.y0 - 0.3 * ch] : [region.y1 + 0.3 * ch, region.y1 + 10 * ch];
  const box = { x0, y0: Math.max(0, Math.floor(ya)), x1, y1: Math.min(height, Math.ceil(yb)) };
  return box.y1 - box.y0 >= 3 * ch && box.x1 - box.x0 >= 4 * ch ? box : null;
}

/** Texte d'une petite zone : mots moins sûrs gardés (« L/G » n'a que 2 lettres), lignes vides écartées. */
export function smallZoneText(data) {
  const out = [];
  for (const block of data?.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        const kept = (line.words || []).filter((w) => w.confidence >= 40 && alnum(w.text) >= 1);
        if (kept.length) out.push(kept.map((w) => w.text).join(' '));
      }
    }
  }
  return out.join('\n');
}

/**
 * Lit une photo : lecture complète, puis lecture rapprochée des zones de
 * texte (graines + zones repérées, `maxRegions` au plus).
 *   img       : pixels RGBA { data, width, height } de la photo telle qu'on la lit ;
 *   recognize : async ({ box|null, scale, invert, rotate, sharpen, psm }) →
 *               données Tesseract (box null = photo entière ; rotate en
 *               degrés, sens horaire ; psm = mode de découpage Tesseract) ;
 *   label     : photo marquée « étiquette » par le vendeur (plus de zones, relue à 180° si rien n'est lisible) ;
 *   deadline  : heure (ms) au-delà de laquelle on ne relit plus de zone ;
 *   isBrand   : (texte) → vrai si c'est une marque : la zone sous cette étiquette est alors relue (taille).
 * Renvoie { text, score, lines, regions } (lines : lignes des zones rapprochées).
 */
export async function readPhoto({ img, recognize, label = false, maxRegions = label ? 5 : 3, deadline = Infinity, isBrand = null }) {
  const full = usefulText(await recognize({ box: null, scale: 1, invert: false, rotate: 0, sharpen: 0, psm: '11' }));
  const texts = [full.text];
  const lines = [];
  let score = full.score;
  let regions = [];
  try {
    // Une « zone » qui couvre une grande partie de la photo est de la texture (maille, moquette), pas une étiquette.
    const area = img.width * img.height;
    regions = mergeRegions([...seedRegions(full.words), ...findTextRegions(img)])
      .filter((r) => r.seed || (r.x1 - r.x0) * (r.y1 - r.y0) <= area * 0.12)
      .slice(0, maxRegions);
  } catch (err) {
    console.warn('[Revendo] repérage des zones de texte', err);
  }
  if (label && full.score < 8 && !regions.length) {
    const flipped = usefulText(await recognize({ box: null, scale: 1, invert: false, rotate: 180, sharpen: 0, psm: '11' }));
    texts.push(flipped.text);
    score = Math.max(score, flipped.score);
  }
  for (const region of regions) {
    if (Date.now() > deadline) break; // temps de lecture épuisé : on garde ce qui est lu
    const plan = planCrop(region, img.width, img.height);
    const pixels = (plan.box.x1 - plan.box.x0) * (plan.box.y1 - plan.box.y0);
    let best = null;
    let bestRotate = 0;
    let promising = false;
    attempts: for (const [k, how] of ZONE_READS.entries()) {
      // Après la 1re façon : seulement si quelque chose ressemble à un mot (sinon c'est de la texture).
      if (k > 0 && (region.seed || !promising)) break;
      const scale = how.boost ? Math.min(plan.scale * 2, 4, Math.sqrt(1e6 / Math.max(1, pixels))) : plan.scale;
      if (how.boost && scale < plan.scale * 1.3) continue; // zone déjà grande : rien à gagner
      for (const rotate of plan.rotations) {
        const data = await recognize({ box: plan.box, scale, invert: plan.invert, rotate, sharpen: how.boost ? 1.5 : 0, psm: how.psm });
        const read = usefulText(data, { scale });
        promising ||= read.words.some((w) => w.confidence >= 50 && /\p{L}{3}/u.test(w.text || ''));
        if (!best || read.score > best.score) {
          best = read;
          bestRotate = rotate;
        }
        if (best.score >= 10) break attempts; // bien lu : inutile d'insister
      }
    }
    if (best?.score > 0) {
      texts.push(best.text);
      lines.push(...best.lines);
      score += best.score;
    }
    // Étiquette de marque lue : la petite étiquette de taille cousue dessous est relue de près.
    if (best?.text && isBrand?.(best.text) && Date.now() <= deadline) {
      const box = belowBox(region, bestRotate, img.width, img.height);
      if (box) {
        const zone = (box.x1 - box.x0) * (box.y1 - box.y0);
        const zoom = Math.max(1, Math.min(40 / Math.max(8, region.charH), 4, Math.sqrt(2e6 / Math.max(1, zone))));
        for (const psm of ['6', '11']) {
          const text = smallZoneText(await recognize({ box, scale: zoom, invert: plan.invert, rotate: bestRotate, sharpen: 1, psm }));
          if (!text) continue;
          texts.push(text);
          if (/\b(?:XXS|XS|S|M|L|XL|XXL|[1-3]X|\d{2})\b/.test(text)) break;
        }
      }
    }
  }
  return { text: texts.filter(Boolean).join('\n'), score, lines, regions: regions.length };
}
