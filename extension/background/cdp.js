/**
 * Revendo — « vrais » clics et frappes via chrome.debugger (protocole CDP).
 *
 * Certains éléments du formulaire Vinted (cases de taille, couleurs, touche
 * Échap, masque du prix) ignorent les événements simulés par un script.
 * Le débogueur Chrome permet d'envoyer des clics/frappes identiques à ceux
 * de la souris et du clavier. Il n'est attaché qu'aux onglets Vinted que
 * l'extension a ouverts elle-même pour un remplissage, puis détaché.
 * (Chrome affiche alors un bandeau « Revendo a commencé à déboguer ce navigateur ».)
 *
 * Contient aussi le moniteur réseau des envois de photos (injecté dans la
 * page, monde MAIN) : il permet au content script de savoir si Vinted a
 * vraiment reçu les photos, même quand les vignettes sont introuvables.
 */

const attached = new Set();

function call(fn, ...args) {
  return new Promise((resolve, reject) => {
    try {
      fn(...args, (res) => {
        const e = chrome.runtime.lastError;
        if (e) reject(new Error(e.message));
        else resolve(res);
      });
    } catch (err) {
      reject(err);
    }
  });
}

export async function attach(tabId) {
  if (attached.has(tabId)) return;
  try {
    await call(chrome.debugger.attach.bind(chrome.debugger), { tabId }, '1.3');
  } catch (err) {
    const msg = String(err?.message || err);
    if (!/already attached|another debugger/i.test(msg)) throw err;
    // Après un redémarrage du service worker, notre propre session est encore
    // attachée : on la détache puis on recommence. Si ça échoue, ce sont les
    // outils de développement (F12) qui occupent l'onglet.
    try {
      await call(chrome.debugger.detach.bind(chrome.debugger), { tabId });
      await call(chrome.debugger.attach.bind(chrome.debugger), { tabId }, '1.3');
    } catch (_e) {
      throw new Error("Les outils de développement (F12) sont ouverts sur l'onglet Vinted : ferme-les.");
    }
  }
  attached.add(tabId);
}

export async function detach(tabId) {
  // Tentative même si on ne se « souvient » pas de l'avoir attaché (redémarrage du service worker).
  attached.delete(tabId);
  try {
    await call(chrome.debugger.detach.bind(chrome.debugger), { tabId });
  } catch (_e) {
    /* déjà détaché */
  }
}

export function isAttached(tabId) {
  return attached.has(tabId);
}

chrome.debugger?.onDetach?.addListener((source) => {
  if (source?.tabId) attached.delete(source.tabId);
});

const send = (tabId, method, params) => call(chrome.debugger.sendCommand.bind(chrome.debugger), { tabId }, method, params);

export async function click(tabId, x, y) {
  await attach(tabId);
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}

const KEYS = {
  Escape: { code: 'Escape', windowsVirtualKeyCode: 27 },
  Enter: { code: 'Enter', windowsVirtualKeyCode: 13 },
  Tab: { code: 'Tab', windowsVirtualKeyCode: 9 },
  Backspace: { code: 'Backspace', windowsVirtualKeyCode: 8 },
};

export async function key(tabId, name) {
  await attach(tabId);
  const k = KEYS[name] || { code: name, windowsVirtualKeyCode: 0 };
  await send(tabId, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', key: name, ...k });
  await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: name, ...k });
}

/** Insère du texte dans l'élément qui a le focus (remplace la sélection). */
export async function insertText(tabId, text, { perKey = false } = {}) {
  await attach(tabId);
  if (!perKey) {
    await send(tabId, 'Input.insertText', { text });
    return;
  }
  for (const ch of text) {
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch });
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
  }
}

// ---------------------------------------------------------------------------
// Moniteur réseau des envois de photos
// ---------------------------------------------------------------------------

/**
 * Exécutée DANS la page Vinted (monde MAIN, via chrome.scripting) : enveloppe
 * fetch et XMLHttpRequest pour compter les envois POST/PUT vers une URL qui
 * contient « /photo » (ex. /api/v2/photos). Les compteurs sont écrits en
 * attributs data-* sur <html>, lisibles depuis le monde isolé du content script :
 *   data-rv-ph-started / data-rv-ph-done / data-rv-ph-failed / data-rv-ph-at.
 * Idempotente (une seconde injection ne double rien) et autonome : aucune
 * variable extérieure, car la fonction est sérialisée par Chrome.
 */
export function photoNetMonitor() {
  const root = document.documentElement;
  if (window.__rvPhotoMonitor) {
    window.__rvPhotoMonitor.flush();
    return { ok: true, already: true };
  }
  const counts = { started: 0, done: 0, failed: 0 };
  const flush = () => {
    root.dataset.rvPhMonitor = '1';
    root.dataset.rvPhStarted = String(counts.started);
    root.dataset.rvPhDone = String(counts.done);
    root.dataset.rvPhFailed = String(counts.failed);
    root.dataset.rvPhAt = String(Date.now());
  };
  const isPhoto = (method, url) => /^(post|put)$/i.test(String(method || 'GET')) && /\/photo/i.test(String(url || ''));
  /** Une requête photo commence : renvoie la fonction qui la clôt (une seule fois). */
  const track = () => {
    counts.started += 1;
    flush();
    let ended = false;
    return (ok) => {
      if (ended) return;
      ended = true;
      if (ok) counts.done += 1;
      else counts.failed += 1;
      flush();
    };
  };
  window.__rvPhotoMonitor = { counts, flush };

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function (input, init) {
      let end = null;
      try {
        const method = init?.method || (input && typeof input === 'object' && input.method) || 'GET';
        const url = typeof input === 'string' ? input : input?.url || String(input);
        if (isPhoto(method, url)) end = track();
      } catch (_e) {
        end = null;
      }
      const p = nativeFetch.apply(this, arguments);
      if (end) p.then((r) => end(!!r?.ok), () => end(false));
      return p;
    };
  }

  const proto = XMLHttpRequest.prototype;
  const nativeOpen = proto.open;
  const nativeSend = proto.send;
  proto.open = function (method, url) {
    try {
      this.__rvPhoto = isPhoto(method, url);
    } catch (_e) {
      this.__rvPhoto = false;
    }
    return nativeOpen.apply(this, arguments);
  };
  proto.send = function () {
    if (!this.__rvPhoto) return nativeSend.apply(this, arguments);
    this.__rvPhoto = false; // une requête = un envoi compté
    const end = track();
    this.addEventListener('loadend', () => end(this.status >= 200 && this.status < 400));
    try {
      return nativeSend.apply(this, arguments);
    } catch (err) {
      end(false);
      throw err;
    }
  };
  flush();
  return { ok: true, already: false };
}

/** Installe le moniteur dans l'onglet (cadre principal). */
export async function watchPhotoUploads(tabId) {
  const [{ result } = {}] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: photoNetMonitor });
  return result || { ok: false };
}
