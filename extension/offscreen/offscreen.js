/**
 * Revendo — document « offscreen » : lecture des étiquettes avec Tesseract
 * (moteur OCR embarqué, gratuit). Le pack de langue (fra+eng) est téléchargé
 * une seule fois puis mis en cache par le navigateur.
 * Le worker est chargé depuis son fichier (workerBlobURL: false) : la
 * politique de sécurité des extensions MV3 interdit les workers « blob: »,
 * ce qui faisait échouer tout l'OCR (mode gratuit sans marque ni taille).
 */
/* global Tesseract */
let workerPromise = null;

function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const worker = await Tesseract.createWorker('fra+eng', 1, {
        workerPath: chrome.runtime.getURL('lib/tesseract/worker.min.js'),
        corePath: chrome.runtime.getURL('lib/tesseract/'),
        workerBlobURL: false,
      });
      // Texte épars (petites étiquettes n'importe où sur la photo) plutôt qu'une page de livre.
      await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM?.SPARSE_TEXT || '11' });
      return worker;
    })().catch((err) => {
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

/**
 * La même image retournée de 180° (étiquette photographiée à l'envers), en
 * Blob JPEG. createImageBitmap plutôt que Image.decode(), qui ne se termine
 * pas toujours dans un document offscreen (jamais affiché).
 */
async function rotate180(src) {
  const blob = await (await fetch(src)).blob();
  const bmp = await createImageBitmap(blob);
  try {
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext('2d');
    ctx.translate(bmp.width, bmp.height);
    ctx.rotate(Math.PI);
    ctx.drawImage(bmp, 0, 0);
    return await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
  } finally {
    bmp.close();
  }
}

const alnum = (t) => (String(t || '').match(/[\p{L}\p{N}]/gu) || []).length;

/**
 * Texte utile d'une lecture Tesseract : une ligne par ligne lue, sans les
 * « mots » peu sûrs que produit la texture du tissu (confiance < 55, sauf mots
 * d'au moins 4 caractères, gardés dès 35 pour la détection tolérante de la
 * marque). score = nombre de caractères lus avec une bonne confiance.
 */
function usefulText(data) {
  if (!Array.isArray(data?.blocks)) return { text: data?.text || '', score: 0 };
  const lines = [];
  let score = 0;
  for (const block of data.blocks) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        const words = (line.words || []).filter((w) => w.confidence >= 55 || (alnum(w.text) >= 4 && w.confidence >= 35));
        if (words.length) lines.push(words.map((w) => w.text).join(' '));
        for (const w of words) if (w.confidence >= 70 && alnum(w.text) >= 3) score += alnum(w.text);
      }
    }
  }
  return { text: lines.join('\n'), score };
}

async function readImage(worker, img) {
  const { data } = await worker.recognize(img, {}, { text: true, blocks: true });
  return usefulText(data);
}

/**
 * Message { target: 'offscreen', type: 'RV_OCR', images: [dataURL], retryUpsideDown }
 * → { ok, texts } (un texte par image, même ordre).
 */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen' || msg.type !== 'RV_OCR') return false;
  (async () => {
    try {
      const worker = await getWorker();
      const texts = [];
      for (const img of msg.images || []) {
        let read = await readImage(worker, img);
        // Presque rien de lisible : l'étiquette est peut-être à l'envers, on garde la meilleure lecture.
        if (msg.retryUpsideDown && read.score < 8) {
          try {
            const flipped = await readImage(worker, await rotate180(img));
            if (flipped.score > read.score) read = flipped;
          } catch (err) {
            console.warn('[Revendo] OCR à 180°', err);
          }
        }
        texts.push(read.text);
      }
      sendResponse({ ok: true, texts });
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message || err) });
    }
  })();
  return true;
});
