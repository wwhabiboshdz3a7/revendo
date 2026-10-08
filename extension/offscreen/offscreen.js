/**
 * Revendo — document « offscreen » : lecture des étiquettes avec Tesseract
 * (moteur OCR embarqué, gratuit). Le pack de langue (fra+eng) est téléchargé
 * une seule fois puis mis en cache par le navigateur.
 */
/* global Tesseract */
let workerPromise = null;

function getWorker() {
  if (!workerPromise) {
    workerPromise = Tesseract.createWorker('fra+eng', 1, {
      workerPath: chrome.runtime.getURL('lib/tesseract/worker.min.js'),
      corePath: chrome.runtime.getURL('lib/tesseract/'),
    }).catch((err) => {
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen' || msg.type !== 'RV_OCR') return false;
  (async () => {
    try {
      const worker = await getWorker();
      const texts = [];
      for (const img of msg.images || []) {
        const { data } = await worker.recognize(img);
        texts.push(data?.text || '');
      }
      sendResponse({ ok: true, texts });
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message || err) });
    }
  })();
  return true;
});
