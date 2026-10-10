/**
 * Revendo — tests du lecteur d'étiquettes (extension/offscreen/label-ocr.js) :
 * repérage des zones de texte sur des images synthétiques (étiquette posée
 * sur une maille texturée, texte à l'envers, en blanc sur marine, tourné de
 * 90°), plan de recadrage, lecture rapprochée avec un Tesseract simulé.
 * Sans navigateur. Lancement : node --test tools/test/*.test.mjs
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { belowBox, findTextRegions, mergeRegions, planCrop, prepareForOcr, readPhoto, seedRegions, smallZoneText, usefulText } from '../../extension/offscreen/label-ocr.js';

// ---------------------------------------------------------------------------
// Images synthétiques
// ---------------------------------------------------------------------------

/** Générateur pseudo-aléatoire reproductible. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Image grise RGBA ; fond = texture (maille) aléatoire entre 90 et 170. */
function canvas(w, h, seed = 1) {
  const r = rng(seed);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    const v = 90 + Math.floor(r() * 80);
    data.set([v, v, v, 255], i * 4);
  }
  return { width: w, height: h, data };
}

function fill(img, x0, y0, x1, y1, v) {
  for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) img.data.set([v, v, v, 255], (y * img.width + x) * 4);
}

/**
 * « Lettres » (formes creuses de largeurs variées, comme T, O, M, Y) alignées
 * sur une étiquette unie. vertical : ligne verticale (étiquette tournée de 90°).
 */
function label(img, { x, y, n = 6, ink = 25, paper = 235, h = 28, vertical = false }) {
  const widths = [18, 22, 26, 20, 24, 16, 22, 26];
  const span = widths.slice(0, n).reduce((a, b) => a + b + 10, 0) + 30;
  const [W, H] = vertical ? [h + 30, span] : [span, h + 30];
  fill(img, x, y, x + W, y + H, paper);
  let at = 15;
  for (let k = 0; k < n; k += 1) {
    const cw = widths[k % widths.length];
    const [lx, ly, lw, lh] = vertical ? [x + 15, y + at, h, cw] : [x + at, y + 15, cw, h];
    // Lettre creuse : contour de 4 px (taux de remplissage ~0,5).
    fill(img, lx, ly, lx + lw, ly + lh, ink);
    fill(img, lx + 4, ly + 4, lx + lw - 4, ly + lh - 4, paper);
    at += cw + 10;
  }
  return { x0: x, y0: y, x1: x + W, y1: y + H };
}

const inside = (r, box) => r.x0 >= box.x0 - 2 && r.y0 >= box.y0 - 2 && r.x1 <= box.x1 + 2 && r.y1 <= box.y1 + 2;

// ---------------------------------------------------------------------------
// Repérage
// ---------------------------------------------------------------------------

test('findTextRegions : étiquette sombre sur clair, au milieu d’une maille texturée', () => {
  const img = canvas(400, 300, 7);
  const box = label(img, { x: 80, y: 120 });
  const regions = findTextRegions(img);
  assert.ok(regions.length >= 1, 'une zone au moins');
  const best = regions[0];
  assert.equal(best.dir, 'h');
  assert.equal(best.polarity, 1);
  assert.ok(inside(best, box), JSON.stringify(best));
  assert.ok(best.n >= 5, `lettres : ${best.n}`);
  assert.ok(Math.abs(best.angle) < 3, `angle ${best.angle}`);
  assert.ok(best.charH >= 24 && best.charH <= 30, `hauteur ${best.charH}`);
});

test('findTextRegions : texte clair sur étiquette marine (polarité inverse) et texte vertical', () => {
  const img = canvas(400, 400, 3);
  label(img, { x: 40, y: 40, ink: 230, paper: 30 });
  const vbox = label(img, { x: 300, y: 120, vertical: true, n: 5 });
  const regions = findTextRegions(img);
  assert.ok(regions.some((r) => r.dir === 'h' && r.polarity === -1), 'blanc sur marine');
  const v = regions.find((r) => r.dir === 'v');
  assert.ok(v && inside(v, vbox), 'ligne verticale');
  assert.ok(Math.abs(v.angle - 90) < 3, `angle ${v.angle}`);
});

test('findTextRegions : une texture seule ne donne (presque) rien', () => {
  const regions = findTextRegions(canvas(300, 300, 11));
  assert.ok(regions.length <= 1, `zones : ${regions.length}`);
  assert.deepEqual(findTextRegions({ width: 0, height: 0, data: new Uint8ClampedArray(0) }), []);
});

test('mergeRegions : une ligne coupée par le drapeau = une zone ; parties d’une étiquette courbée gardées à part', () => {
  const tommy = { x0: 100, y0: 50, x1: 200, y1: 80, dir: 'h', polarity: -1, charH: 30, angle: -2, n: 5, score: 300 };
  const hilfiger = { x0: 230, y0: 52, x1: 380, y1: 82, dir: 'h', polarity: -1, charH: 30, angle: 1, n: 8, score: 400 };
  const merged = mergeRegions([tommy, hilfiger]);
  assert.equal(merged.length, 1);
  assert.deepEqual([merged[0].x0, merged[0].x1, merged[0].n], [100, 380, 13]);
  const curved = mergeRegions([tommy, { ...hilfiger, angle: 12 }]);
  assert.equal(curved.length, 2);
  // Graine (mot bien lu sur la photo entière) : prend la polarité de la zone voisine.
  const seeded = mergeRegions([{ ...seedRegions([{ text: 'TOMMY', confidence: 95, bbox: { x0: 105, y0: 52, x1: 190, y1: 78 } }])[0] }, tommy]);
  assert.equal(seeded.length, 1);
  assert.equal(seeded[0].polarity, -1);
  assert.equal(seeded[0].seed, true);
});

test('seedRegions : seulement les mots bien lus', () => {
  const words = [
    { text: 'TOMMY', confidence: 94, bbox: { x0: 0, y0: 0, x1: 90, y1: 19 } },
    { text: 'Huron', confidence: 0, bbox: { x0: 0, y0: 0, x1: 90, y1: 19 } },
    { text: 'M', confidence: 90, bbox: { x0: 0, y0: 0, x1: 9, y1: 16 } },
    { text: 'CHINA', confidence: 72, bbox: { x0: 0, y0: 0, x1: 40, y1: 12 } },
  ];
  assert.deepEqual(seedRegions(words).map((r) => r.charH), [19, 12]);
});

test('planCrop : marges, agrandissement visé ~32 px par lettre, rotations pour redresser', () => {
  const plan = planCrop({ x0: 500, y0: 870, x1: 730, y1: 925, dir: 'h', polarity: 1, charH: 16, angle: 0 }, 1200, 1600);
  assert.deepEqual(plan.box, { x0: 452, y0: 838, x1: 778, y1: 957 });
  assert.equal(plan.scale, 2);
  assert.equal(plan.invert, false);
  assert.deepEqual(plan.rotations, [0, 180]);
  // Ligne penchée de -5° (à l'envers sur la photo) : redressée dans les deux sens.
  assert.deepEqual(planCrop({ x0: 695, y0: 710, x1: 852, y1: 758, dir: 'h', polarity: -1, charH: 34, angle: -5 }, 1200, 1600).rotations, [5, -175]);
  assert.equal(planCrop({ x0: 695, y0: 710, x1: 852, y1: 758, dir: 'h', polarity: -1, charH: 34, angle: -5 }, 1200, 1600).invert, true);
  // Ligne verticale qui descend : tournée de -90° (lecture vers le bas) ou de 90°.
  assert.deepEqual(planCrop({ x0: 10, y0: 10, x1: 40, y1: 200, dir: 'v', polarity: 1, charH: 24, angle: 90 }, 300, 300).rotations, [-90, 90]);
  // Graine : déjà lisible dans ce sens.
  assert.deepEqual(planCrop({ x0: 0, y0: 0, x1: 90, y1: 19, dir: 'h', polarity: 0, charH: 19, angle: 0, seed: true }, 1200, 1600).rotations, [0]);
  // Zone immense : pas d'agrandissement au-delà de 1400 px.
  assert.equal(planCrop({ x0: 0, y0: 0, x1: 1190, y1: 300, dir: 'h', polarity: 1, charH: 10, angle: 0 }, 1200, 1600).scale, 1400 / 1200);
});

// ---------------------------------------------------------------------------
// Retouche et lecture
// ---------------------------------------------------------------------------

test('prepareForOcr : gris étiré, inversion, coins transparents blancs', () => {
  const img = { width: 3, height: 1, data: new Uint8ClampedArray([40, 40, 40, 255, 200, 200, 200, 255, 0, 0, 0, 0]) };
  prepareForOcr(img, { invert: true });
  // Sombre → blanc, clair → noir, transparent → blanc (fond).
  assert.deepEqual([...img.data], [255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255]);
  const plain = { width: 2, height: 1, data: new Uint8ClampedArray([60, 60, 60, 255, 120, 120, 120, 255]) };
  prepareForOcr(plain);
  assert.deepEqual([plain.data[0], plain.data[4]], [0, 255]);
});

/** Données Tesseract minimales : lignes de mots { text, confidence, h }. */
function tess(lines) {
  return {
    blocks: [
      {
        paragraphs: [
          {
            lines: lines.map((ws) => ({ words: ws.map(([text, confidence, h = 20]) => ({ text, confidence, bbox: { x0: 0, y0: 0, x1: 10 * text.length, y1: h } })) })),
          },
        ],
      },
    ],
  };
}

test('usefulText : mots peu sûrs écartés, hauteur ramenée à la photo, score des mots nets', () => {
  const r = usefulText(tess([[['TOMMY', 96, 36], ['=', 42, 36]], [['Huron', 20]], [['MADE', 91, 24], ['IN', 93, 24]], [['xx', 40]]]), { scale: 2 });
  assert.equal(r.text, 'TOMMY\nMADE IN');
  assert.equal(r.score, 5 + 4);
  assert.deepEqual(r.lines.map((l) => [l.text, l.h]), [['TOMMY', 18], ['MADE IN', 12]]);
  assert.deepEqual(usefulText({ text: 'brut' }), { text: 'brut', score: 0, lines: [], words: [] });
});

test('readPhoto : lecture complète, puis zones relues de près dans le bon sens', async () => {
  const img = canvas(400, 300, 7);
  label(img, { x: 80, y: 120 });
  const calls = [];
  const recognize = async (op) => {
    calls.push(op);
    if (!op.box) return tess([[['bruit', 30]]]);
    // La zone ne se lit qu'à l'envers (étiquette photographiée tête en bas).
    return Math.abs(op.rotate) === 180 ? tess([[['TOMMY', 95, 56]], [['HILFIGER', 90, 56]]]) : tess([[['YWWOL', 30]]]);
  };
  const r = await readPhoto({ img, recognize });
  assert.equal(calls[0].box, null);
  const zone = calls.filter((c) => c.box);
  assert.deepEqual(zone.map((c) => c.rotate), [0, 180]); // bien lu au 2e sens : on s'arrête
  assert.ok(zone[0].scale >= 1);
  assert.equal(zone[0].psm, '11');
  assert.match(r.text, /TOMMY\nHILFIGER/);
  assert.ok(r.score >= 13);
  assert.equal(r.lines[0].text, 'TOMMY');
});

test('readPhoto : zone qui ressemble à des mots → agrandie et accentuée ; texture → abandonnée vite ; délai respecté', async () => {
  const img = canvas(400, 300, 7);
  label(img, { x: 80, y: 120 });
  // 1) Lettres devinées mais rien de net : on insiste (agrandie + accentuée, puis mode « bloc »).
  const calls = [];
  await readPhoto({
    img,
    recognize: async (op) => {
      calls.push(op);
      return op.box && op.sharpen ? tess([[['TOMMY', 92, 60]]]) : op.box ? tess([[['SANNOA', 60]]]) : tess([]);
    },
  });
  const zone = calls.filter((c) => c.box);
  assert.ok(zone.some((c) => c.sharpen > 0 && c.scale > zone[0].scale), 'lecture agrandie et accentuée');
  // 2) Rien qui ressemble à un mot : 2 lectures (les deux sens) puis on passe.
  const calls2 = [];
  await readPhoto({ img, recognize: async (op) => (calls2.push(op), tess([[['%', 80]]])) });
  assert.equal(calls2.filter((c) => c.box).length, 2);
  // 3) Délai dépassé : la lecture complète seulement.
  const calls3 = [];
  const r3 = await readPhoto({ img, deadline: Date.now() - 1, recognize: async (op) => (calls3.push(op), tess([[['GANT', 90]]])) });
  assert.equal(calls3.length, 1);
  assert.equal(r3.text, 'GANT');
});

test('readPhoto : photo marquée « étiquette » sans rien de lisible → relue à 180°', async () => {
  const img = canvas(200, 200, 5);
  const calls = [];
  const r = await readPhoto({
    img,
    label: true,
    recognize: async (op) => {
      calls.push(op);
      return op.rotate === 180 ? tess([[['LEVIS', 88]]]) : tess([]);
    },
  });
  assert.deepEqual(calls.map((c) => [c.box, c.rotate]), [
    [null, 0],
    [null, 180],
  ]);
  assert.equal(r.text, 'LEVIS');
});

test('étiquette de marque lue → la petite étiquette de taille cousue dessous est relue', async () => {
  const img = canvas(400, 300, 7);
  label(img, { x: 80, y: 60 });
  const calls = [];
  const r = await readPhoto({
    img,
    isBrand: (t) => /TOMMY/.test(t),
    recognize: async (op) => {
      calls.push(op);
      if (!op.box) return tess([]);
      if (op.box.y0 > 100) return tess([[['L/G', 45]], [['MADE', 60], ['IN', 60]]]); // zone du dessous : mots peu sûrs gardés
      return op.rotate === 0 ? tess([[['TOMMY', 95, 56]], [['HILFIGER', 90, 56]]]) : tess([]);
    },
  });
  const below = calls.filter((c) => c.box && c.box.y0 > 100);
  assert.ok(below.length >= 1, 'zone du dessous relue');
  assert.equal(below[0].rotate, 0);
  assert.ok(below[0].box.y0 >= 100 && below[0].box.x0 <= 90);
  assert.match(r.text, /L\/G\nMADE IN/);
  // Sans marque reconnue : pas de lecture du dessous.
  const calls2 = [];
  await readPhoto({ img, isBrand: () => false, recognize: async (op) => (calls2.push(op), op.box ? tess([[['TOMMY', 95, 56]]]) : tess([])) });
  assert.equal(calls2.filter((c) => c.box && c.box.y0 > 100).length, 0);
});

test('belowBox : sous l’étiquette dans le sens de lecture (au-dessus si lue retournée) ; smallZoneText garde « L/G »', () => {
  const region = { x0: 100, y0: 100, x1: 200, y1: 114, charH: 12, dir: 'h', angle: 0 };
  const down = belowBox(region, 0, 400, 400);
  assert.ok(down.y0 > 114 && down.y1 > 200 && down.x0 < 100 && down.x1 > 200);
  const up = belowBox(region, 180, 400, 400);
  assert.ok(up.y1 < 100);
  assert.equal(belowBox({ ...region, dir: 'v' }, 0, 400, 400), null);
  assert.equal(smallZoneText(tess([[['L/G', 45]], [['~', 20]]])), 'L/G');
});
