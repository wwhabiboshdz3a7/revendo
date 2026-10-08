/**
 * Revendo — couleur dominante d'un article (mode gratuit, sans IA).
 * On estime la couleur du fond à partir des bords de la photo, on l'écarte,
 * puis on regroupe les pixels restants (k-moyennes dans l'espace Lab) et on
 * associe chaque groupe à la pastille Vinted la plus proche.
 */
import { COLORS } from './vinted-data.js';

function srgbToLinear(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

export function rgbToLab([r, g, b]) {
  const R = srgbToLinear(r);
  const G = srgbToLinear(g);
  const B = srgbToLinear(b);
  const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const Y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(X);
  const fy = f(Y);
  const fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function deltaE(a, b) {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

const PALETTE = COLORS.filter((c) => c.rgb).map((c) => ({ name: c.name, lab: rgbToLab(c.rgb) }));

/**
 * Pastille Vinted la plus proche. `castB` = composante bleue (b*) d'un fond
 * neutre, pour ne pas prendre une dominante bleue de la photo pour du marine.
 */
export function nearestVintedColor(rgb, { castB = 0 } = {}) {
  const lab = rgbToLab(rgb);
  let best = null;
  let bestD = Infinity;
  for (const p of PALETTE) {
    // Les neutres (noir/gris/blanc) ne doivent pas attirer les couleurs saturées.
    const chroma = Math.hypot(lab[1], lab[2]);
    let d = deltaE(lab, p.lab);
    if (['Noir', 'Gris', 'Blanc'].includes(p.name) && chroma > 22) d += 25;
    if (d < bestD) {
      bestD = d;
      best = p.name;
    }
  }
  // Bleu marine photographé au téléphone (ex. [42, 46, 56]) : plus proche du noir que de la
  // pastille « Marine », mais nettement bleuté (b* négatif), contrairement à un vrai noir.
  if (best === 'Noir' && lab[0] >= 6 && lab[2] - castB <= -6 && lab[2] < lab[1] - 4) return 'Marine';
  return best;
}

/**
 * pixels : Uint8ClampedArray RGBA (ex. getImageData sur une image réduite à ~160 px).
 * Renvoie [{ name, share }] trié, share = part des pixels de l'article.
 */
export function dominantColors(pixels, width, height, { k = 4 } = {}) {
  const px = (x, y) => {
    const i = (y * width + x) * 4;
    return [pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]];
  };
  // 1) Fond : médiane des pixels de bordure.
  const border = [];
  const step = Math.max(1, Math.floor(Math.min(width, height) / 40));
  for (let x = 0; x < width; x += step) {
    border.push(px(x, 0), px(x, height - 1));
  }
  for (let y = 0; y < height; y += step) {
    border.push(px(0, y), px(width - 1, y));
  }
  const med = (arr, i) => arr.map((p) => p[i]).sort((a, b) => a - b)[Math.floor(arr.length / 2)];
  const bg = [med(border, 0), med(border, 1), med(border, 2)];
  const bgLab = rgbToLab(bg);
  // Le fond est-il homogène ? (sinon on ne l'écarte pas).
  const bgSpread = border.filter((p) => deltaE(rgbToLab(p), bgLab) < 12).length / border.length;

  // 2) Pixels de l'article : zone centrale pondérée, hors fond.
  const samples = [];
  const sstep = Math.max(1, Math.floor(Math.min(width, height) / 80));
  for (let y = 0; y < height; y += sstep) {
    for (let x = 0; x < width; x += sstep) {
      const p = px(x, y);
      if (p[3] < 128) continue;
      const lab = rgbToLab(p);
      if (bgSpread > 0.6 && deltaE(lab, bgLab) < 14) continue;
      const dx = (x - width / 2) / (width / 2);
      const dy = (y - height / 2) / (height / 2);
      const w = 1.5 - Math.min(1, Math.hypot(dx, dy)); // centre favorisé
      samples.push({ lab, rgb: p, w });
    }
  }
  if (samples.length < 20) return [];

  // 3) k-moyennes (initialisation déterministe par quantiles de luminance).
  const sorted = [...samples].sort((a, b) => a.lab[0] - b.lab[0]);
  let centers = Array.from({ length: k }, (_, i) => sorted[Math.floor(((i + 0.5) / k) * sorted.length)].lab.slice());
  const assign = new Array(samples.length).fill(0);
  for (let iter = 0; iter < 12; iter += 1) {
    for (let s = 0; s < samples.length; s += 1) {
      let bi = 0;
      let bd = Infinity;
      for (let c = 0; c < centers.length; c += 1) {
        const d = deltaE(samples[s].lab, centers[c]);
        if (d < bd) {
          bd = d;
          bi = c;
        }
      }
      assign[s] = bi;
    }
    centers = centers.map((old, c) => {
      let W = 0;
      const acc = [0, 0, 0];
      samples.forEach((s, i) => {
        if (assign[i] !== c) return;
        W += s.w;
        acc[0] += s.rgb[0] * s.w;
        acc[1] += s.rgb[1] * s.w;
        acc[2] += s.rgb[2] * s.w;
      });
      return W ? rgbToLab(acc.map((v) => v / W)) : old;
    });
  }
  // 4) Couleur moyenne de chaque groupe → pastille Vinted.
  const groups = new Map();
  let total = 0;
  samples.forEach((s, i) => {
    const c = assign[i];
    if (!groups.has(c)) groups.set(c, { W: 0, acc: [0, 0, 0] });
    const g = groups.get(c);
    g.W += s.w;
    g.acc[0] += s.rgb[0] * s.w;
    g.acc[1] += s.rgb[1] * s.w;
    g.acc[2] += s.rgb[2] * s.w;
    total += s.w;
  });
  // Dominante bleue de la photo, estimée sur un fond homogène et presque neutre (mur blanc, drap gris).
  const castB = bgSpread > 0.6 && Math.hypot(bgLab[1], bgLab[2]) < 12 ? Math.min(0, bgLab[2]) : 0;
  const byName = new Map();
  for (const g of groups.values()) {
    const name = nearestVintedColor(g.acc.map((v) => v / g.W), { castB });
    byName.set(name, (byName.get(name) || 0) + g.W / total);
  }
  return [...byName.entries()].map(([name, share]) => ({ name, share })).sort((a, b) => b.share - a.share);
}

/** Teintes voisines que l'ombre ou l'éclairage séparent sur une photo : une seule couleur réelle. */
const SHADE_PAIRS = new Set(['Marine|Noir', 'Bleu|Marine', 'Blanc|Crème', 'Beige|Crème']);
const sameShade = (a, b) => SHADE_PAIRS.has([a, b].sort().join('|'));

/** 1 ou 2 couleurs Vinted pour l'annonce. */
export function pickListingColors(dominant) {
  if (!dominant?.length) return [];
  const out = [dominant[0].name];
  const second = dominant[1];
  if (second && second.share >= 0.28 && second.name !== dominant[0].name && !sameShade(second.name, dominant[0].name)) out.push(second.name);
  return out;
}
