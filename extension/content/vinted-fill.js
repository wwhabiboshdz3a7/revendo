/**
 * Revendo — remplissage du formulaire « Vends ton article » de Vinted.
 *
 * Ne s'active que dans un onglet ouvert par l'extension pour une annonce
 * (sinon il ne fait rien). Ordre calqué sur le formulaire réel :
 *   photos → titre → description → prix → CATÉGORIE (fait apparaître les
 *   lignes suivantes) → marque → taille → état → couleurs → matériaux →
 *   colis → prix (re-vérifié) → vérification du compte → « Sauvegarder le
 *   brouillon ». Le bouton « Ajouter » (publication) n'est JAMAIS cliqué.
 *
 * Ce que l'on sait du formulaire (vu en direct) :
 *   • chaque ligne de détail est un <input readonly placeholder="Sélectionne …">
 *     qui ouvre un panneau ; la valeur choisie s'affiche dans cet input
 *     (c'est la seule source de vérité pour savoir si un choix a « pris ») ;
 *   • catégorie : en haut du panneau, Vinted RECOMMANDE 1–2 catégories
 *     déduites des photos et du titre (lignes avec fil d'Ariane « A > B »),
 *     avant « Tous » ; sinon recherche « Trouver une catégorie » ;
 *   • marque : recherche « Rechercher une marque », et pour une marque
 *     absente du catalogue la ligne « Utiliser "X" comme marque » ; les
 *     textes d'étiquette non reconnus (candidats) n'y sont acceptés que s'ils
 *     correspondent EXACTEMENT à une marque du catalogue Vinted ;
 *   • tailles, couleurs : certaines cases ignorent les clics simulés → on
 *     passe alors par un vrai clic (débogueur Chrome, via le service worker).
 */
(() => {
  if (window.__revendoFill) return;
  window.__revendoFill = true;

  const TAG = '[Revendo]';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let cdpOk = false;

  function send(type, payload = {}) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type, ...payload }, (res) => {
          void chrome.runtime.lastError;
          resolve(res || null);
        });
      } catch (_e) {
        resolve(null);
      }
    });
  }

  main().catch((err) => console.error(TAG, err));

  async function main() {
    let job = null;
    for (let i = 0; i < 8 && !job; i += 1) {
      job = (await send('RV_TAB_JOB'))?.job || null;
      if (!job) await sleep(600);
    }
    if (!job) return; // onglet ouvert à la main : on ne touche à rien
    banner.start(job);
    let result;
    try {
      result = await fill(job);
    } catch (err) {
      console.error(TAG, err);
      result = { ok: false, draftSaved: false, message: `Erreur inattendue : ${err?.message || err}`, fields: [] };
    }
    if (cdpOk) await send('RV_CDP', { op: 'detach' });
    banner.done(result);
    await send('RV_TAB_RESULT', { result });
  }

  // =========================================================================
  // Utilitaires DOM
  // =========================================================================

  async function waitFor(fn, timeout = 5000, interval = 120) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      let v = null;
      try {
        v = fn();
      } catch (_e) {
        v = null;
      }
      if (v) return v;
      await sleep(interval);
    }
    return null;
  }

  function normalize(str) {
    return (str || '')
      .toString()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[’‘ʼ´`]/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }

  const escapeRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function isVisible(el) {
    if (!el || !el.isConnected || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity || '1') > 0.1;
  }

  function lines(el) {
    return (el?.innerText || el?.textContent || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function labelOf(el) {
    const aria = el.getAttribute?.('aria-label');
    if (aria) return aria.trim();
    const by = el.getAttribute?.('aria-labelledby');
    if (by) {
      const t = by
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent || '')
        .join(' ')
        .trim();
      if (t) return t;
    }
    return el.getAttribute?.('title') || lines(el)[0] || lines(el.closest('li') || el.parentElement)[0] || '';
  }

  function qsv(selectors) {
    for (const sel of selectors) {
      try {
        for (const el of document.querySelectorAll(sel)) if (isVisible(el)) return el;
      } catch (_e) {
        /* sélecteur invalide */
      }
    }
    return null;
  }

  function byPlaceholder(re) {
    return [...document.querySelectorAll('input, textarea')].find((i) => isVisible(i) && re.test(i.getAttribute('placeholder') || '')) || null;
  }

  const SEL = {
    title: () => qsv(['[data-testid="title--input"]', 'input[name="title"]']) || byPlaceholder(/ce que tu vends|tell buyers/i),
    desc: () => qsv(['[data-testid="description--input"]', 'textarea[name="description"]']) || byPlaceholder(/informations utiles|useful information/i),
    price: () => qsv(['[data-testid="price-input--input"]', 'input[name="price"]']) || byPlaceholder(/0,00|0\.00/),
    category: () => qsv(['[data-testid="catalog-select-dropdown-input"]']) || byPlaceholder(/s[ée]lectionne une cat[ée]gorie|select a category/i),
    brand: () => qsv(['[data-testid="brand-select-dropdown-input"]']) || byPlaceholder(/s[ée]lectionne une marque|select a brand/i),
    size: () => qsv(['[data-testid="size-select-dropdown-input"]']) || byPlaceholder(/s[ée]lectionne une taille|select a size/i),
    status: () => qsv(['[data-testid="status-select-dropdown-input"]']) || byPlaceholder(/s[ée]lectionne un [ée]tat|select a condition/i),
    color: () => qsv(['[data-testid="color-select-dropdown-input"]']) || byPlaceholder(/s[ée]lectionne .*couleur|select .*colou?r/i),
    material: () =>
      qsv(['[data-testid="material-select-dropdown-input"]', '[data-testid="materials-select-dropdown-input"]']) ||
      byPlaceholder(/s[ée]lectionne .*mat[ée]ria|select .*material/i),
  };

  function setReactValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** Frappe « comme un humain » (execCommand), repli sur le setter React. */
  function typeText(el, text) {
    el.focus();
    if (el.value) {
      el.select?.();
      document.execCommand('delete');
      if (el.value) setReactValue(el, '');
    }
    const ok = document.execCommand('insertText', false, text);
    if (!ok || normalize(el.value) !== normalize(text)) setReactValue(el, text);
  }

  function blur(el) {
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    el.blur?.();
  }

  /** Clic simulé : séquence pointeur + UNE activation (pas de double clic). */
  function clickOnce(el) {
    try {
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
    } catch (_e) {
      /* ignore */
    }
    const o = { bubbles: true, cancelable: true, view: window };
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
      const E = t.startsWith('pointer') && typeof PointerEvent !== 'undefined' ? PointerEvent : MouseEvent;
      el.dispatchEvent(new E(t, o));
    }
    el.click();
  }

  /** Vrai clic (débogueur) au centre de l'élément, en vérifiant qu'il n'est pas recouvert. */
  async function trustedClick(el) {
    if (!cdpOk || !el?.isConnected) return false;
    let x = 0;
    let y = 0;
    for (const block of ['center', 'start', 'end']) {
      try {
        el.scrollIntoView({ block, behavior: 'instant' });
      } catch (_e) {
        /* ignore */
      }
      await sleep(200);
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      x = Math.round(r.left + r.width / 2);
      y = Math.round(r.top + r.height / 2);
      const at = document.elementFromPoint(x, y);
      if (at && (at === el || el.contains(at) || at.contains(el))) break;
    }
    const res = await send('RV_CDP', { op: 'click', x, y });
    return !!res?.ok;
  }

  async function trustedType(el, text, perKey = false) {
    if (!cdpOk) return false;
    el.focus();
    el.select?.();
    const res = await send('RV_CDP', { op: 'insert', text, perKey });
    return !!res?.ok;
  }

  async function pressEscape() {
    if (cdpOk) {
      const res = await send('RV_CDP', { op: 'key', key: 'Escape' });
      if (res?.ok) return;
    }
    const target = document.activeElement || document.body;
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
  }

  /** Clique puis vérifie ; si le choix n'a pas « pris », retente avec un vrai clic. */
  async function commitClick(el, verify, { wait = 1400 } = {}) {
    clickOnce(el);
    if (await waitFor(verify, wait)) return true;
    if (await trustedClick(el)) {
      if (await waitFor(verify, 2200)) return true;
    }
    return false;
  }

  // =========================================================================
  // Panneaux déroulants
  // =========================================================================

  function optionCandidates() {
    const roleEls = [...document.querySelectorAll('[role="radio"], [role="checkbox"], [role="option"], [role="menuitem"]')].filter(
      (el) => isVisible(el) && !el.closest('nav, header, footer'),
    );
    const lis = [...document.querySelectorAll('li')].filter(
      (li) => isVisible(li) && !li.closest('nav, header, footer') && !li.querySelector('[role="radio"], [role="checkbox"], [role="option"]'),
    );
    return [...roleEls, ...lis];
  }

  function visibleInputs() {
    return [...document.querySelectorAll('input, textarea')].filter(isVisible);
  }

  /**
   * Ouvre le panneau d'une ligne. Ne lit ensuite QUE les options apparues
   * après l'ouverture (les cartes « Envoi » déjà visibles sont ignorées).
   */
  async function openPanel(trigger) {
    const before = new Set(optionCandidates());
    const inputsBefore = new Set(visibleInputs());
    const opened = () => optionCandidates().some((o) => !before.has(o));
    clickOnce(trigger);
    let ok = await waitFor(opened, 1500);
    if (!ok) {
      await trustedClick(trigger);
      ok = await waitFor(opened, 2000);
    }
    if (!ok) return null;
    return {
      options: () => optionCandidates().filter((o) => !before.has(o)),
      search: () =>
        visibleInputs().find(
          (i) => !inputsBefore.has(i) && i.type !== 'radio' && i.type !== 'checkbox' && !/articles/i.test(i.getAttribute('placeholder') || ''),
        ) || null,
    };
  }

  async function closePanel() {
    await pressEscape();
    await sleep(250);
  }

  /** L'option est-elle sous le titre « Suggestions » (jumeaux souvent décoratifs) ? */
  function inSuggestions(el) {
    let node = el;
    for (let d = 0; d < 6 && node; d += 1) {
      let sib = node.previousElementSibling;
      for (let h = 0; sib && h < 6; h += 1, sib = sib.previousElementSibling) {
        const t = (sib.textContent || '').trim();
        if (!t || t.length > 45) continue;
        return /^suggestions?$/i.test(t);
      }
      node = node.parentElement;
    }
    return false;
  }

  /**
   * Remonte d'une étiquette (« M / 38 / 10 ») à la case cliquable dont le texte
   * est identique — sans dépasser la liste ni un bloc qui contient un champ
   * (une recherche qui ne renvoie qu'UNE marque laissait remonter jusqu'au
   * bloc du formulaire, et le clic ne choisissait rien).
   */
  function chipHost(el) {
    const t = (el.textContent || '').trim();
    let host = el;
    for (let d = 0; d < 4; d += 1) {
      const p = host.parentElement;
      if (!p || (p.textContent || '').trim() !== t) break;
      if (/^(UL|OL|MAIN|FORM|BODY)$/.test(p.tagName) || p.matches('[role="listbox"], [role="list"], [role="dialog"], [role="menu"]')) break;
      if (p.querySelector('input:not([type="checkbox"]):not([type="radio"]), textarea, select')) break;
      host = p;
    }
    return host;
  }

  function checkboxIn(el, label) {
    let row = el;
    for (let d = 0; d < 4 && row; d += 1) {
      const boxes = row.querySelectorAll?.('input[type="checkbox"]') || [];
      if (boxes.length > 1) return null;
      if (boxes.length === 1) {
        const cb = boxes[0];
        const host = cb.closest('li, [role="option"], label') || cb.parentElement;
        return !label || normalize(host?.textContent || '').includes(normalize(label)) ? cb : null;
      }
      row = row.parentElement;
    }
    return null;
  }

  // =========================================================================
  // Étapes
  // =========================================================================

  async function waitForForm() {
    const ok = await waitFor(() => document.querySelector('input[type="file"]') || SEL.title(), 25000, 300);
    if (!ok) {
      if (/login|signup|session/.test(location.pathname) || document.querySelector('a[href*="login"]')) {
        throw new Error("Ce profil n'est pas connecté à Vinted.");
      }
      throw new Error('Le formulaire Vinted ne s’est pas chargé.');
    }
    await sleep(800);
  }

  async function dismissOverlays() {
    const banner = document.querySelector('#onetrust-banner-sdk');
    if (banner && isVisible(banner)) {
      const refuse = [...banner.querySelectorAll('button')].find((b) => /tout refuser|refuser|continuer sans accepter|reject/i.test(b.textContent || ''));
      if (refuse) {
        clickOnce(refuse);
        await sleep(500);
      }
    }
  }

  // ---------- Photos ----------
  //
  // Sans photos, Vinted ne recommande aucune catégorie et tout le reste échoue :
  // on vérifie donc ce que Vinted a VRAIMENT reçu, par deux sources :
  //   • les vignettes apparues au-dessus du champ titre (img, blob:, data:, fonds) ;
  //   • le moniteur réseau (service worker → monde MAIN) qui compte les envois
  //     POST/PUT « /photo » dans des attributs data-rv-ph-* de <html>.
  // Un lot refusé en silence (zone « un fichier à la fois ») est renvoyé photo
  // par photo, mais JAMAIS si Vinted a commencé à traiter le lot (pas de doublon).

  /** Point de référence pris juste avant l'ajout des photos. */
  const photoTrack = { total: 0, thumbs: 0, net: { started: 0, done: 0, failed: 0 }, how: '' };

  function base64ToFile(b64, name, mime = 'image/jpeg') {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], name, { type: mime, lastModified: Date.now() });
  }

  const titleTop = () => SEL.title()?.getBoundingClientRect().top ?? Infinity;

  /** Vignettes visibles au-dessus du champ titre, dédupliquées par image. */
  function countThumbs() {
    const limit = titleTop();
    const keys = new Set();
    const fits = (el) => {
      if (!isVisible(el)) return false;
      const r = el.getBoundingClientRect();
      return r.top < limit && r.width >= 28 && r.height >= 28;
    };
    for (const img of document.querySelectorAll('main img, form img, img[src^="blob:"], img[src^="data:"]')) {
      if (fits(img)) keys.add(img.currentSrc || img.getAttribute('src') || img);
    }
    for (const el of document.querySelectorAll('main [style*="background"], form [style*="background"]')) {
      const url = /url\(\s*["']?([^"')]+)/.exec(el.style.backgroundImage || '')?.[1];
      if (url && fits(el)) keys.add(url);
    }
    return keys.size;
  }

  /** Indicateurs de chargement (spinners, barres) au-dessus du titre. */
  function countBusy() {
    const limit = titleTop();
    return [...document.querySelectorAll('[role="progressbar"], [aria-busy="true"], [class*="spinner" i], [class*="loader" i], [class*="progress" i]')].filter(
      (el) => isVisible(el) && el.getBoundingClientRect().top < limit,
    ).length;
  }

  /** Compteurs du moniteur réseau (posés par le monde MAIN sur <html>). */
  function netCounts() {
    const d = document.documentElement.dataset;
    const n = (v) => Math.max(0, parseInt(v || '0', 10) || 0);
    const started = n(d.rvPhStarted);
    const done = n(d.rvPhDone);
    const failed = n(d.rvPhFailed);
    return { on: d.rvPhMonitor === '1', started, done, failed, pending: Math.max(0, started - done - failed) };
  }

  /** Envois photo depuis le point de référence. */
  function netDelta() {
    const now = netCounts();
    const b = photoTrack.net;
    const started = Math.max(0, now.started - b.started);
    const done = Math.max(0, now.done - b.done);
    const failed = Math.max(0, now.failed - b.failed);
    return { on: now.on, started, done, failed, ended: done + failed, pending: now.pending };
  }

  const thumbsGained = () => Math.max(0, countThumbs() - photoTrack.thumbs);

  /** Photos reçues par Vinted : vignettes nouvelles, ou envois réussis si les vignettes sont invisibles. */
  function photosShown() {
    if (!photoTrack.total) return 0;
    return Math.min(photoTrack.total, Math.max(thumbsGained(), netDelta().done));
  }

  function photoResult() {
    const shown = photosShown();
    const failed = netDelta().failed;
    const notes = [photoTrack.how, failed ? `${failed} envoi${failed > 1 ? 's' : ''} refusé${failed > 1 ? 's' : ''} par Vinted` : ''].filter(Boolean);
    return { ok: shown > 0, shown, detail: `${shown}/${photoTrack.total} visibles${notes.length ? ` — ${notes.join(', ')}` : ''}` };
  }

  function photoInput() {
    const all = [...document.querySelectorAll('input[type="file"]')];
    return all.find((i) => /image/i.test(i.accept || '') || i.multiple) || all[0] || null;
  }

  function dropFiles(input, files) {
    const dt = new DataTransfer();
    files.forEach((f) => dt.items.add(f));
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /**
   * Attend les photos : arrêt dès que toutes les vignettes sont là OU que tous
   * les envois sont terminés. Délai ≈ 15 s + 6 s par photo (max 120 s),
   * prolongé tant que ça progresse.
   */
  async function waitPhotos(expected) {
    const start = Date.now();
    const budget = Math.min(120000, 15000 + 6000 * expected);
    let last = '';
    let moved = start;
    for (;;) {
      const thumbs = thumbsGained();
      const net = netDelta();
      if (thumbs >= expected || (net.ended >= expected && net.pending === 0)) return;
      const sig = `${thumbs}|${net.started}|${net.ended}`;
      const now = Date.now();
      if (sig !== last) {
        last = sig;
        moved = now;
        banner.progress(`Photos — ${photosShown()}/${expected}`);
      }
      // Plus rien en vol ni de nouveauté depuis 6 s : Vinted a fini (et en a peut-être refusé).
      if (net.on && net.started > 0 && net.pending === 0 && now - moved > 6000) return;
      if (now - start > budget && now - moved > 8000) return;
      if (now - start > budget + 60000) return;
      await sleep(300);
    }
  }

  /**
   * Repli : une photo à la fois (l'input est recherché à chaque fois, React
   * peut le recréer). Renvoie le nombre de photos à attendre ; note dans
   * photoTrack.how comment l'ajout s'est passé. afterBatch : un lot a déjà été
   * déposé (peut-être juste lent) → on lui laisse 10 s de plus après la 1re photo.
   */
  async function dropOneByOne(files, { afterBatch = false } = {}) {
    let sent = 0;
    let accepted = 0;
    let misses = 0;
    // Vignettes et requêtes « /photo » par photo, mesurées sur la première acceptée.
    // Plafonnées à 2 : un lot qui démarre pendant la mesure ne doit pas la fausser.
    let perThumb = 1;
    let perPhoto = 1;
    // Plus d'activité que d'envois unitaires : le lot est finalement traité.
    const batchLate = () => thumbsGained() > sent * perThumb || netDelta().started > sent * perPhoto;
    for (const file of files) {
      // Lot pris en compte en retard → on arrête (pas de doublon).
      if (batchLate()) {
        photoTrack.how = sent ? `lot pris en compte en retard (${sent} photo${sent > 1 ? 's' : ''} peut-être en double)` : '';
        return files.length;
      }
      const input = await waitFor(photoInput, 3000);
      if (!input) break;
      const t0 = thumbsGained();
      const n0 = netDelta();
      dropFiles(input, [file]);
      sent += 1;
      banner.progress(`Photos — une par une (${sent}/${files.length})`);
      const began = await waitFor(() => thumbsGained() > t0 || netDelta().started > n0.started, 10000, 250);
      if (!began) {
        misses += 1;
        if (misses >= 2 || sent === 1) break; // la zone ne prend rien : inutile d'insister
        continue;
      }
      misses = 0;
      accepted += 1;
      await waitFor(() => thumbsGained() > t0 || netDelta().ended > n0.ended, 20000, 250);
      await sleep(300);
      if (accepted === 1) {
        perThumb = Math.min(2, Math.max(1, thumbsGained() - t0));
        perPhoto = Math.min(2, Math.max(1, netDelta().started - n0.started));
        // Lot peut-être seulement lent : 10 s de grâce avant la 2e photo (s'il arrive d'ici là : 1 seul doublon).
        if (afterBatch) await waitFor(batchLate, 10000, 250);
      }
    }
    photoTrack.how = accepted ? 'ajoutées une par une' : 'la zone photo n’a pas réagi';
    return accepted;
  }

  async function fillPhotos(count) {
    const files = [];
    for (let i = 0; i < count; i += 3) {
      const res = await send('RV_TAB_PHOTOS', { from: i, count: 3 });
      for (const p of res?.photos || []) files.push(base64ToFile(p.base64, p.name || `photo-${files.length + 1}.jpg`, p.mime));
    }
    if (!files.length) return { ok: false, detail: 'photos introuvables', shown: 0 };
    const list = files.slice(0, 20);
    const input = photoInput();
    if (!input) return { ok: false, detail: 'zone photo introuvable', shown: 0 };
    window.scrollTo({ top: 0 });
    await sleep(200);
    Object.assign(photoTrack, { total: list.length, thumbs: countThumbs(), net: netCounts(), how: '' });
    const busy0 = countBusy();
    const anySignal = () => thumbsGained() > 0 || netDelta().started > 0 || countBusy() > busy0;

    let expected = list.length;
    if (list.length > 1 && !input.multiple) {
      // Zone « un fichier à la fois » déclarée : pas de lot.
      expected = await dropOneByOne(list);
    } else {
      dropFiles(input, list);
      // Aucun signal en 10 s : lot refusé en silence → une par une.
      if (!(await waitFor(anySignal, 10000, 250)) && list.length > 1) expected = await dropOneByOne(list, { afterBatch: true });
    }
    if (expected > 0) await waitPhotos(expected);
    const res = photoResult();
    if (res.shown > 0) await sleep(1500); // laisse Vinted analyser les photos (recommandations)
    return res;
  }

  /** Attend la fin des envois de photos encore en vol (moniteur réseau), au plus `max` ms. */
  async function settleUploads(max) {
    if (!photoTrack.total || !netCounts().on || !netCounts().pending) return;
    banner.progress('Photos — fin des envois');
    await waitFor(() => netCounts().pending === 0, max, 400);
  }

  // ---------- Texte ----------

  async function fillText(getEl, value) {
    const el = await waitFor(getEl, 5000);
    if (!el) return { ok: false, detail: 'champ introuvable' };
    typeText(el, value);
    blur(el);
    await sleep(150);
    if (normalize(el.value) === normalize(value)) return { ok: true };
    if (await trustedType(el, value)) {
      blur(el);
      await sleep(150);
    }
    return { ok: normalize(el.value).length > 0 };
  }

  // ---------- Prix ----------

  function parseShownPrice(str) {
    const c = (str || '').replace(/[^\d,.-]/g, '');
    if (!c) return NaN;
    return c.includes(',') ? parseFloat(c.replace(/\./g, '').replace(',', '.')) : parseFloat(c);
  }

  async function fillPrice(raw) {
    const expected = parseFloat(String(raw).replace(/\s|€/g, '').replace(',', '.'));
    if (!Number.isFinite(expected) || expected <= 0) return { ok: false, detail: `prix invalide « ${raw} »` };
    const input = await waitFor(SEL.price, 5000);
    if (!input) return { ok: false, detail: 'champ introuvable' };
    const comma = Number.isInteger(expected) ? String(expected) : expected.toFixed(2).replace('.', ',');
    const dot = expected.toFixed(2);
    const good = () => Math.abs(parseShownPrice(SEL.price()?.value) - expected) < 0.001;
    const clear = (el) => {
      el.focus();
      el.select?.();
      document.execCommand('delete');
      if (el.value) setReactValue(el, '');
    };
    const attempts = [
      (el, v) => typeText(el, v),
      (el, v) => setReactValue(el, v),
      async (el, v) => trustedType(el, v),
      async (el, v) => trustedType(el, v, true),
    ];
    for (const attempt of attempts) {
      for (const v of [comma, dot]) {
        const el = SEL.price();
        if (!el) return { ok: false, detail: 'champ introuvable' };
        clear(el);
        await attempt(el, v);
        blur(el);
        await sleep(400);
        if (good()) return { ok: true, detail: SEL.price().value };
      }
    }
    const el = SEL.price();
    if (el) {
      clear(el);
      blur(el);
    }
    return { ok: false, detail: `non rempli par sécurité — saisis ${comma} € toi-même` };
  }

  // ---------- Catégorie ----------

  const NICHES = [
    /pyjama|nuisette|de nuit/,
    /maternit|grossesse/,
    /deguisement|costumes? de/,
    /maillots? de bain|bikini/,
    /\bski\b|randonnee/,
    /clavier|piano|instrument|guitare/,
    /lingerie|sous-vetements/,
  ];

  function wordTier(name, term) {
    const n = normalize(name);
    const t = normalize(term).replace(/s$/, '');
    if (!t) return 0;
    const L = 'a-z0-9';
    if (new RegExp(`^${escapeRx(t)}s?$`).test(n)) return 100;
    if (new RegExp(`^${escapeRx(t)}(s|x)?([^${L}]|$)`).test(n)) return 85;
    if (new RegExp(`(^|[^${L}])${escapeRx(t)}(s|x)?([^${L}]|$)`).test(n)) return 70;
    return 0;
  }

  /** Mots d'indice (étiquette, marque spécialisée) présents dans le nom ou le fil d'Ariane. */
  function hintHits(text, words) {
    return (words || []).filter((w) => w && new RegExp(`(^|[^a-z0-9])${escapeRx(w)}`).test(text)).length;
  }

  /**
   * Note d'une catégorie proposée. kw (catégorie connue) : le nom doit la
   * contenir. Sinon : ordre de Vinted (la 1re est la plus probable), rayon,
   * mots d'indice (« chaussures » pour Converse, « jeans » pour une taille W32…),
   * catégories de niche pénalisées sauf indice contraire.
   */
  function catScore(el, { kw, rayon, path, context, words = [] }, index = 0) {
    const [name = '', ...rest] = lines(el);
    const crumbs = normalize(rest.join(' '));
    const all = `${normalize(name)} ${crumbs}`;
    let s = kw ? wordTier(name, kw) : 50 - 4 * index;
    if (!s) return -Infinity;
    if (rayon) {
      if (crumbs) s += crumbs.startsWith(normalize(rayon)) ? 25 : -60;
    } else {
      if (/enfant|bebe|fille|garcon/.test(crumbs) && !/enfant|bebe|fille|garcon|ans\b/.test(context)) s -= 50;
    }
    for (const w of normalize(path || '').split(/[^a-z]+/).filter((x) => x.length >= 4)) if (crumbs.includes(w)) s += 6;
    if (!kw && words.length) {
      const hits = hintHits(all, words);
      s += hits ? 18 + 6 * Math.min(2, hits - 1) : -10;
    }
    for (const rx of NICHES) if (rx.test(all) && !rx.test(context)) s -= 45;
    return s;
  }

  /** Lignes « recommandées » en tête du panneau : elles portent un fil d'Ariane (A > B). */
  function recoRows(panel) {
    const rows = [];
    for (const el of panel.options()) {
      const t = lines(el).join(' ');
      if (/^(tous|rubriques du catalogue)$/i.test(t)) break;
      if (t.includes('>') && el.children.length <= 6 && t.length < 200) rows.push(el);
    }
    return rows;
  }

  /** Lignes recommandées par Vinted, attendues jusqu'à `ms` (elles arrivent parfois après l'ouverture du menu). */
  async function waitRecos(panel, ms) {
    return (await waitFor(() => (recoRows(panel).length ? recoRows(panel) : null), ms, 300)) || [];
  }

  /** Recherche « Trouver une catégorie » : meilleure ligne pour `term` (note ≥ 70), ou null. */
  async function searchCategory(panel, term, ctx, committed, done) {
    const search = await waitFor(panel.search, 2500);
    if (!search) return null;
    const terms = [...new Set([term, term.split(/\s+/)[0]])].filter((t) => t.length >= 3);
    for (const t of terms) {
      typeText(search, t);
      await sleep(900);
      if (!panel.options().some((o) => wordTier(lines(o)[0] || '', t))) {
        if (await trustedType(search, t)) await sleep(900);
      }
      const rank = () =>
        panel
          .options()
          .map((el) => ({ el, s: catScore(el, { ...ctx, kw: t }) }))
          .sort((a, b) => b.s - a.s)[0];
      let best = rank();
      if (best && best.s >= 70) {
        if (await commitClick(best.el, committed)) return done(best.el, `recherche « ${t} »`);
        // Branche (sous-menu) au lieu d'une catégorie finale : on choisit dans le niveau ouvert.
        await sleep(500);
        best = rank();
        if (best && best.s >= 60 && (await commitClick(best.el, committed))) return done(best.el, `recherche « ${t} »`);
      }
    }
    typeText(search, '');
    await sleep(500);
    return null;
  }

  /**
   * Catégorie, sans IA :
   *  1) recommandations de Vinted (calculées depuis les photos), classées avec
   *     le rayon et les indices de l'étiquette / de la marque ;
   *  2) sinon (ou si aucune ne colle aux indices), recherche du terme connu ;
   *  3) repli : meilleure recommandation compatible avec le rayon.
   * job.category (saisie sur le PC) est exigée telle quelle.
   */
  async function selectCategory(job) {
    const trigger = await waitFor(SEL.category, 6000);
    if (!trigger) return { ok: false, detail: 'champ introuvable' };
    const committed = () => (SEL.category()?.value || '').trim();
    if (committed()) return { ok: true, detail: committed(), name: committed() };

    const hints = job.categoryHints || {};
    const rayon = job.rayon || hints.rayon || '';
    const words = (hints.words || []).map(normalize).filter(Boolean);
    const context = normalize(`${job.title || ''} ${job.category || ''} ${job.categoryPath || ''} ${rayon} ${words.join(' ')}`);
    const ctx = { kw: job.category || '', rayon, path: job.categoryPath || '', context, words };
    const done = (el, how) => {
      const [name, ...rest] = lines(el);
      return { ok: true, detail: `${committed()}${rest.length ? ` (${rest.join(' ')})` : ''} — ${how}`, name: committed() || name, path: rest.join(' ') };
    };

    let panel = await openPanel(trigger);
    if (!panel) return { ok: false, detail: "le menu ne s'est pas ouvert" };
    let recos = await waitRecos(panel, 6000);
    if (!recos.length) {
      // Vinted calcule encore ses recommandations : on referme et on rouvre une fois.
      await closePanel();
      await sleep(3000);
      panel = await openPanel(trigger);
      if (!panel) return { ok: false, detail: "le menu ne s'est pas ouvert" };
      recos = await waitRecos(panel, 6000);
    }
    const ranked = recos.map((el, i) => ({ el, s: catScore(el, ctx, i), hits: hintHits(normalize(lines(el).join(' ')), words) })).sort((a, b) => b.s - a.s);

    // 1) Recommandations de Vinted.
    const top = ranked[0];
    const fitsHints = !words.length || (top && top.hits > 0);
    if (top && (ctx.kw ? top.s >= 70 : top.s > 0 && fitsHints)) {
      if (await commitClick(top.el, committed)) return done(top.el, 'recommandée par Vinted');
    }

    // 2) Recherche : catégorie saisie, sinon terme déduit (taille W32 → « Jeans », Converse → « Baskets »).
    const term = ctx.kw || hints.search || '';
    if (term) {
      const found = await searchCategory(panel, term, ctx, committed, done);
      if (found) return found;
    }

    // 3) Repli : meilleure recommandation compatible avec le rayon (relue : la recherche a pu redessiner la liste).
    const again = recos.some((el) => el.isConnected) ? recos.filter((el) => el.isConnected) : recoRows(panel);
    const fallback = again
      .map((el, i) => ({ el, s: catScore(el, { ...ctx, kw: '', words: [] }, i) }))
      .sort((a, b) => b.s - a.s)[0];
    if (fallback && fallback.s > 0 && (await commitClick(fallback.el, committed))) return done(fallback.el, 'recommandation Vinted (repli)');
    await closePanel();
    const what = ctx.kw || hints.search || 'cet article';
    return { ok: false, detail: recos.length ? `aucune catégorie sûre pour « ${what} »${rayon ? ` (${rayon})` : ''}` : 'Vinted n’a proposé aucune catégorie (photos ?)' };
  }

  // ---------- Marque ----------

  /**
   * Marque. `brand` (lue sur l'étiquette ou saisie) : ligne exacte, sinon
   * « Utiliser "X" comme marque ». `candidates` (textes d'étiquette inconnus) :
   * acceptés seulement s'ils sont EXACTEMENT une marque du catalogue Vinted
   * (jamais créés) — renvoie alors { verified: true, name }.
   */
  async function selectBrand(brand, candidates = []) {
    const trigger = await waitFor(SEL.brand, 4000);
    if (!trigger) return { ok: true, skip: true, detail: 'pas de marque pour cette catégorie' };
    const committed = () => (SEL.brand()?.value || '').trim();
    const slugOf = (v) => normalize(v).replace(/[^a-z0-9]/g, '');

    const panel = await openPanel(trigger);
    if (!panel) return { ok: false, detail: "le menu ne s'est pas ouvert" };
    await sleep(500);

    const tryRows = async (target) => {
      const want = slugOf(target);
      const rows = panel
        .options()
        .filter((el) => slugOf(labelOf(el)) === want)
        .map((el) => chipHost(el))
        .sort((a, b) => Number(inSuggestions(a)) - Number(inSuggestions(b)));
      for (const row of rows.slice(0, 4)) {
        if (!row.isConnected) continue;
        if (await commitClick(row, committed)) return true;
      }
      return false;
    };
    const isCreate = (o) => /utiliser .* comme marque|use .* as brand/i.test(labelOf(o));
    const typeSearch = async (search, text) => {
      typeText(search, text);
      const want = slugOf(text);
      const hit = await waitFor(() => panel.options().some((o) => slugOf(labelOf(o)) === want || isCreate(o)), 5000);
      if (!hit && (await trustedType(search, text))) await sleep(1500);
    };

    if (brand) {
      if (await tryRows(brand)) {
        await closePanel();
        return { ok: true, detail: committed() };
      }
      const search = await waitFor(panel.search, 2500);
      if (search) {
        await typeSearch(search, brand);
        if (await tryRows(brand)) {
          await closePanel();
          return { ok: true, detail: committed() };
        }
        const create = panel.options().find(isCreate);
        if (create && (await commitClick(chipHost(create), committed))) {
          await closePanel();
          return { ok: true, detail: `${committed()} (nouvelle marque)` };
        }
        typeText(search, '');
      }
      await closePanel();
      return { ok: false, detail: `« ${brand} » introuvable` };
    }

    // Textes d'étiquette inconnus : vérifiés dans le catalogue de marques de Vinted.
    const search = await waitFor(panel.search, 2500);
    if (search) {
      for (const cand of candidates.slice(0, 3)) {
        await typeSearch(search, cand);
        if (await tryRows(cand)) {
          await closePanel();
          return { ok: true, verified: true, name: committed(), detail: `${committed()} (lue sur l’étiquette, trouvée dans les marques Vinted)` };
        }
      }
      typeText(search, '');
    }
    await closePanel();
    return { ok: false, detail: `illisible sur l’étiquette${candidates.length ? ` (essayé : ${candidates.slice(0, 3).join(', ')})` : ''} — à choisir` };
  }

  async function dismissAuthenticityModal() {
    const dialog = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')].find((d) => isVisible(d) && /authenticit/i.test(d.textContent || ''));
    if (!dialog) return;
    const btn =
      [...dialog.querySelectorAll('button, [role="button"]')].find((b) => /^\s*(fermer|plus tard|ok|compris)\s*$/i.test(b.textContent || '')) ||
      dialog.querySelector('[aria-label="Fermer" i], [aria-label="Close" i]');
    if (btn) clickOnce(btn);
    else await pressEscape();
    await sleep(400);
  }

  // ---------- Taille ----------

  function isSizeSystemTab(label) {
    const n = (label || '').replace(/\s+/g, '').toLowerCase();
    if (/^(s\/m\/l|ue|eu|uk|fr|it|us|int)$/.test(n)) return true;
    return ['s/m/l', 'ue', 'uk', 'fr', 'it', 'us'].filter((k) => n.includes(k)).length >= 3;
  }

  function sizeTokens(size) {
    const raw = String(size || '').trim();
    const tokens = [raw];
    const alpha = /^([A-Za-z]{1,4})\b/.exec(raw)?.[1];
    if (alpha && alpha !== raw) tokens.push(alpha);
    const num = /\d{1,3}(?:[.,]5)?/.exec(raw)?.[0];
    if (num) tokens.push(num, num.replace(',', '.'));
    return [...new Set(tokens.filter(Boolean))];
  }

  function sizeMatches(label, token) {
    const n = normalize(label).replace(',', '.');
    const t = normalize(token).replace(',', '.');
    if (n === t) return true;
    return n.split(/\s*[/|]\s*|\s+/).includes(t);
  }

  async function selectSize(size) {
    const trigger = await waitFor(SEL.size, 4000);
    if (!trigger) return { ok: true, skip: true, detail: 'pas de taille pour cette catégorie' };
    const committed = () => (SEL.size()?.value || '').trim();
    const tokens = sizeTokens(size);
    const matchesTarget = () => {
      const v = committed();
      return v && tokens.some((t) => sizeMatches(v, t)) ? v : '';
    };
    const panel = await openPanel(trigger);
    if (!panel) return { ok: false, detail: "le menu ne s'est pas ouvert" };
    await sleep(500);
    for (const token of tokens) {
      const cands = panel
        .options()
        .map((el) => chipHost(el))
        .filter((el, i, arr) => arr.indexOf(el) === i)
        .filter((el) => !isSizeSystemTab(labelOf(el)) && sizeMatches(labelOf(el), token))
        // Vinted calcule une suggestion depuis notre description (« Taille : M ») : on l'essaie d'abord.
        .sort((a, b) => Number(inSuggestions(b)) - Number(inSuggestions(a)));
      for (const el of cands.slice(0, 3)) {
        if (!el.isConnected) continue;
        if (await commitClick(el, matchesTarget, { wait: 1800 })) {
          await closePanel();
          return { ok: true, detail: committed() };
        }
      }
      if (matchesTarget()) {
        await closePanel();
        return { ok: true, detail: committed() };
      }
    }
    await closePanel();
    return { ok: false, detail: `taille « ${size} » absente pour cette catégorie` };
  }

  // ---------- État ----------

  async function selectCondition(condition) {
    const trigger = await waitFor(SEL.status, 4000);
    if (!trigger) return { ok: false, detail: 'champ introuvable' };
    const committed = () => (SEL.status()?.value || '').trim();
    if (normalize(committed()) === normalize(condition)) return { ok: true, detail: committed() };
    const panel = await openPanel(trigger);
    if (!panel) return { ok: false, detail: "le menu ne s'est pas ouvert" };
    const row = await waitFor(() => panel.options().find((o) => normalize(lines(o)[0]) === normalize(condition)), 2500);
    if (!row) {
      await closePanel();
      return { ok: false, detail: `« ${condition} » introuvable` };
    }
    const ok = await commitClick(row, () => normalize(committed()) === normalize(condition));
    if (!ok) await closePanel();
    return ok ? { ok: true, detail: committed() } : { ok: false, detail: 'choix non pris en compte' };
  }

  // ---------- Couleurs / matériaux (cases à cocher) ----------

  async function selectMulti(getTrigger, values, label) {
    const trigger = await waitFor(getTrigger, 4000);
    if (!trigger) return { ok: true, skip: true, detail: `pas de ${label} pour cette catégorie` };
    const committed = () => (getTrigger()?.value || '').trim();
    const has = (v) => normalize(committed()).includes(normalize(v));
    const panel = await openPanel(trigger);
    if (!panel) return { ok: false, detail: "le menu ne s'est pas ouvert" };
    await sleep(400);
    const picked = [];
    const missing = [];
    for (const value of values) {
      if (has(value)) {
        picked.push(value);
        continue;
      }
      const rows = panel
        .options()
        .filter((o) => normalize(labelOf(o)) === normalize(value))
        .sort((a, b) => Number(inSuggestions(a)) - Number(inSuggestions(b)));
      let done = false;
      for (const row of rows.slice(0, 4)) {
        const cb = checkboxIn(row, value);
        const isChecked = () => (cb ? cb.checked : row.getAttribute('aria-checked') === 'true') || has(value);
        if (isChecked()) {
          done = true;
          break;
        }
        // Une case à cocher native bascule toujours avec .click() ; sinon clic sur la ligne.
        if (cb) cb.click();
        else clickOnce(row);
        if (await waitFor(isChecked, 1200)) {
          done = true;
          break;
        }
        if (!isChecked() && (await trustedClick(cb || row)) && (await waitFor(isChecked, 1800))) {
          done = true;
          break;
        }
      }
      (done ? picked : missing).push(value);
      await sleep(250);
    }
    await closePanel();
    await waitFor(() => picked.every(has), 2500);
    const shown = committed();
    if (!picked.length) return { ok: false, detail: `${missing.join(', ')} introuvable(s)` };
    return { ok: true, detail: `${shown || picked.join(', ')}${missing.length ? ` — non trouvé : ${missing.join(', ')}` : ''}` };
  }

  // ---------- Colis ----------

  const PACKAGES = { Petit: ['petit', '2 kg', 'small'], Moyen: ['moyen', '5 kg', 'medium'], Grand: ['grand', '10 kg', '20 kg', 'large'] };

  async function selectPackage(pkg) {
    const labels = PACKAGES[pkg] || [];
    const card = [...document.querySelectorAll('[role="radio"], li, label')]
      .filter(isVisible)
      .find((el) => /convient/i.test(el.textContent || '') && lines(el).slice(0, 2).some((l) => labels.includes(normalize(l))));
    if (!card) return { ok: true, skip: true, detail: 'format laissé à Vinted' };
    const radio = card.querySelector('input[type="radio"]');
    const target = card.matches('[role="radio"]') ? card : card.querySelector('[role="radio"]') || card;
    const checked = () => (radio ? radio.checked : target.getAttribute('aria-checked') === 'true');
    if (checked()) return { ok: true, detail: pkg };
    if (radio) {
      radio.click(); // un bouton radio natif se coche toujours avec .click()
      if (await waitFor(checked, 800)) return { ok: true, detail: pkg };
    }
    const ok = await commitClick(target, checked);
    return ok ? { ok: true, detail: pkg } : { ok: false, detail: 'choix non pris en compte' };
  }

  // ---------- Brouillon ----------

  async function saveDraft() {
    const isPublish = (t) => /\bajouter\b|\bpublier\b|mettre en ligne|\bupload\b|t[ée]l[ée]verser/i.test(t);
    const btn = [...document.querySelectorAll('button, [role="button"]')]
      .filter(isVisible)
      .find((b) => {
        const t = (b.textContent || '').trim();
        return /brouillon|save\s*(as\s*)?draft/i.test(t) && !isPublish(t);
      });
    if (!btn) return { saved: false, confirmed: false, message: 'Bouton « Sauvegarder le brouillon » introuvable.' };
    const startPath = location.pathname;
    clickOnce(btn);
    const outcome = await waitFor(() => {
      if (location.pathname !== startPath) return 'redirect';
      const toast = [...document.querySelectorAll('[role="status"], [role="alert"], [class*="toast" i], [class*="snackbar" i], [class*="notification" i]')].find(
        (el) => isVisible(el) && /brouillon.*(enregistr|sauvegard)|draft.*saved/i.test(el.textContent || ''),
      );
      if (toast) return 'toast';
      const errors = [...document.querySelectorAll('[role="alert"], [class*="error" i], [class*="validation" i]')].filter(
        (el) => isVisible(el) && /(doit|obligatoire|requis|renseign|required|invalide)/i.test(el.textContent || ''),
      );
      if (errors.length) return { errors: errors.map((e) => (e.textContent || '').trim()).slice(0, 3) };
      return null;
    }, 15000, 300);
    if (outcome && typeof outcome === 'object') {
      return { saved: false, confirmed: false, message: `Vinted refuse d'enregistrer : ${outcome.errors.join(' · ')}` };
    }
    if (outcome) return { saved: true, confirmed: true };
    return { saved: true, confirmed: false };
  }

  // =========================================================================
  // Séquence complète
  // =========================================================================

  async function fill(job) {
    const fields = [];
    const step = async (label, enabled, fn) => {
      if (!enabled) return null;
      banner.progress(label);
      let res;
      try {
        res = await fn();
      } catch (err) {
        console.error(TAG, label, err);
        res = { ok: false, detail: 'erreur inattendue' };
      }
      if (!res?.skip) fields.push({ label, ok: !!res?.ok, detail: res?.detail || '' });
      await sleep(200);
      return res;
    };

    // Verrou : si la page est rechargée, le job n'est pas rejoué (pas de doublon).
    await send('RV_STARTED');
    cdpOk = !!(await send('RV_CDP', { op: 'attach' }))?.ok;
    if (cdpOk) await sleep(700); // le bandeau du débogueur décale la page une fois
    await send('RV_FOCUS');
    await waitForForm();
    await dismissOverlays();
    // Compteur des envois de photos (si l'injection échoue : vignettes seules).
    if (job.photoCount > 0) await send('RV_NET_MONITOR');

    await step('Photos', job.photoCount > 0, () => fillPhotos(job.photoCount));
    await step('Titre', !!job.title, () => fillText(SEL.title, job.title));
    await step('Description', !!job.description, () => fillText(SEL.desc, job.description));
    await step('Prix', !!job.price, () => fillPrice(job.price));

    // Les recommandations de catégorie viennent des photos : envois terminés d'abord.
    await settleUploads(30000);
    const cat = await step('Catégorie', true, () => selectCategory(job));
    if (cat?.ok) {
      await waitFor(() => SEL.status() || SEL.brand() || SEL.size(), 8000, 300);
      await sleep(500);
    }

    // Sans catégorie, Vinted n'affiche pas les lignes suivantes : on les note « à faire ».
    const afterCat = (fn) => (cat?.ok ? fn() : Promise.resolve({ ok: false, detail: 'à choisir après la catégorie' }));
    const candidates = Array.isArray(job.brandCandidates) ? job.brandCandidates : [];
    const brand = await step('Marque', !!job.brand || candidates.length > 0, () => afterCat(() => selectBrand(job.brand, candidates)));
    await dismissAuthenticityModal();
    const verifiedBrand = brand?.verified && brand.name ? brand.name : '';

    if ((job.composeAfterCategory && cat?.ok) || verifiedBrand) {
      // Titre et description composés d'après la catégorie choisie sur Vinted (et la marque trouvée sur Vinted).
      const recompose = job.composeAfterCategory && cat?.ok;
      const composed = await send('RV_COMPOSE', { categoryName: recompose ? cat.name : '', categoryPath: recompose ? cat.path || '' : '', brand: verifiedBrand });
      if (composed?.ok && composed.title) {
        job.title = composed.title;
        await step('Titre', true, () => fillText(SEL.title, composed.title));
        await step('Description', true, () => fillText(SEL.desc, composed.description));
      }
    }
    await step('Taille', !!job.size, () => afterCat(() => selectSize(job.size)));
    await step('État', !!job.condition, () => afterCat(() => selectCondition(job.condition)));
    await step('Couleur', !!job.colors?.length, () => afterCat(() => selectMulti(SEL.color, job.colors.slice(0, 2), 'couleur')));
    await step('Matériau', !!job.materials?.length, () => afterCat(() => selectMulti(SEL.material, job.materials.slice(0, 3), 'matériau')));
    await step('Colis', !!job.package, () => selectPackage(job.package));
    await dismissAuthenticityModal();

    // Le choix de catégorie re-monte le champ prix : on revérifie juste avant d'enregistrer.
    const priceEntry = fields.find((f) => f.label === 'Prix');
    if (job.price) {
      const again = await fillPrice(job.price);
      if (priceEntry) Object.assign(priceEntry, { ok: again.ok, detail: again.detail || priceEntry.detail });
    }
    // Une couleur peut se décocher si un panneau est resté ouvert : on revérifie.
    if (job.colors?.length && SEL.color() && !normalize(SEL.color().value).includes(normalize(job.colors[0]))) {
      const again = await selectMulti(SEL.color, job.colors.slice(0, 2), 'couleur');
      const entry = fields.find((f) => f.label === 'Couleur');
      if (entry) Object.assign(entry, { ok: again.ok, detail: again.detail });
    }
    // Photos encore en cours d'envoi : on attend, puis on recompte (ligne « Photos » à jour).
    let shown = 0;
    if (photoTrack.total) {
      await settleUploads(90000);
      const again = photoResult();
      shown = again.shown;
      const entry = fields.find((f) => f.label === 'Photos');
      if (entry) Object.assign(entry, { ok: again.ok, detail: again.detail });
    }

    const base = {
      fields: dedupe(fields),
      title: job.title,
      category: cat?.name || '',
      photos: { sent: job.photoCount || 0, shown },
    };

    if (!job.autoSave) return { ...base, ok: true, draftSaved: false, message: 'Formulaire rempli : vérifie puis enregistre le brouillon.' };

    // Sécurité : le profil est-il toujours connecté au bon compte ?
    if (job.account?.id) {
      const me = await send('RV_WHOAMI');
      if (me?.loggedOut) return { ...base, ok: false, draftSaved: false, message: 'Le profil a été déconnecté de Vinted : rien n’a été enregistré.' };
      if (me?.id && me.id !== job.account.id) {
        return { ...base, ok: false, draftSaved: false, message: `Compte Vinted différent (@${me.login}) : rien n’a été enregistré pour ne pas se tromper de compte.` };
      }
    }
    banner.progress('Enregistrement du brouillon');
    // Si Vinted recharge la page après l'enregistrement, ce script disparaît :
    // le service worker garde ce résultat et le valide en voyant la redirection.
    await send('RV_SAVING', { result: { ...base, ok: true, draftSaved: true, draftConfirmed: false, message: 'Brouillon enregistré.' } });
    const saved = await saveDraft();
    return {
      ...base,
      ok: saved.saved,
      draftSaved: saved.saved,
      draftConfirmed: saved.confirmed,
      message: saved.message || (saved.confirmed ? 'Brouillon enregistré.' : 'Brouillon enregistré (confirmation non visible).'),
    };
  }

  /** Garde la dernière entrée de chaque libellé (le titre peut être rempli deux fois). */
  function dedupe(list) {
    const map = new Map();
    for (const f of list) map.set(f.label, f);
    return [...map.values()];
  }

  // =========================================================================
  // Bandeau d'état
  // =========================================================================

  const banner = (() => {
    let root = null;
    let host = null;
    let meta = '';
    let who = 'Revendo';
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    // Icônes SVG (24×24, trait 1,75, style Lucide).
    const svg = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
    const ICON = {
      check: svg('<path d="M20 6 9 17l-5-5"/>'),
      cross: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
      done: svg('<circle cx="12" cy="12" r="9"/><path d="m8.5 12.2 2.4 2.4 4.6-4.9"/>'),
      alert: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/>'),
    };
    const ensure = () => {
      if (root) return root;
      host = document.createElement('div');
      host.style.cssText = 'all:initial;position:fixed;top:16px;right:16px;z-index:2147483647;';
      document.documentElement.appendChild(host);
      root = host.attachShadow({ mode: 'open' });
      root.innerHTML = `
        <style>
          :host{all:initial}
          *{box-sizing:border-box}
          .box{font:13px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#0f172a;background:#fff;
            width:min(344px,calc(100vw - 32px));border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;-webkit-font-smoothing:antialiased;
            box-shadow:0 1px 2px rgba(15,23,42,.06),0 12px 32px -8px rgba(15,23,42,.18)}
          svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round;display:block}
          .head{display:flex;align-items:center;gap:10px;padding:12px 10px 12px 14px;border-bottom:1px solid #eef2f6}
          .st{flex:none;width:28px;height:28px;border-radius:8px;display:grid;place-items:center;background:#e8f5f5;color:#0a9396}
          .st.warn{background:#fff7e6;color:#b45309}
          .st.err{background:#fdeeee;color:#dc2626}
          .spin{width:14px;height:14px;border-radius:50%;border:2px solid #bfe3e3;border-top-color:#0a9396;animation:rv-spin .8s linear infinite}
          @keyframes rv-spin{to{transform:rotate(360deg)}}
          .ttl{flex:1;min-width:0}
          .t{font-weight:600;font-size:13.5px;letter-spacing:-.01em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
          .s{font-size:11.5px;color:#64748b}
          .x{flex:none;width:28px;height:28px;border:0;border-radius:7px;background:none;color:#64748b;cursor:pointer;display:grid;place-items:center;padding:0}
          .x:hover{background:#f1f5f9;color:#0f172a}
          .x:focus-visible{outline:2px solid #0a9396;outline-offset:1px}
          .bar{height:2px;background:#eef2f6;overflow:hidden;position:relative}
          .bar::after{content:"";position:absolute;top:0;bottom:0;left:0;width:34%;background:#0a9396;animation:rv-bar 1.3s ease-in-out infinite}
          .bar.off{display:none}
          @keyframes rv-bar{from{transform:translateX(-100%)}to{transform:translateX(300%)}}
          .body{padding:10px 14px 12px;max-height:60vh;overflow:auto}
          .now b{font-weight:600}
          .meta{margin-top:2px;font-size:12px;color:#64748b}
          .row{display:grid;grid-template-columns:16px 88px minmax(0,1fr);gap:8px;align-items:start;padding:6px 0;border-top:1px solid #f1f5f9}
          .row:first-child{border-top:0}
          .ic{height:19px;display:grid;place-items:center}
          .ic svg{width:14px;height:14px;stroke-width:2}
          .ic.ok{color:#0a9396}
          .ic.ko{color:#dc2626}
          .l{font-weight:550}
          .d{color:#64748b;word-break:break-word}
          .note{margin-top:10px;font-size:12px;color:#64748b}
          .msg{margin-top:10px;font-size:12px;border:1px solid;border-radius:8px;padding:8px 10px}
          .msg.info{background:#f0f9f9;border-color:#cde8e8;color:#0b5c5e}
          .msg.warn{background:#fffbeb;border-color:#fde68a;color:#92400e}
        </style>
        <div class="box" role="status" aria-live="polite">
          <div class="head">
            <span class="st" id="st"></span>
            <div class="ttl"><div class="t" id="t"></div><div class="s" id="s"></div></div>
            <button class="x" id="x" type="button" aria-label="Fermer" title="Fermer">${ICON.cross}</button>
          </div>
          <div class="bar" id="bar"></div>
          <div class="body" id="b"></div>
        </div>`;
      root.getElementById('x').addEventListener('click', () => host.remove());
      return root;
    };
    /** État de l'en-tête : busy (en cours), ok, warn (à compléter), err. */
    const setState = (r, state, title, sub = who) => {
      const st = r.getElementById('st');
      st.className = `st${state === 'warn' || state === 'err' ? ` ${state}` : ''}`;
      st.innerHTML = state === 'busy' ? '<span class="spin"></span>' : state === 'ok' ? ICON.done : ICON.alert;
      r.getElementById('bar').className = state === 'busy' ? 'bar' : 'bar off';
      r.getElementById('t').textContent = title;
      r.getElementById('s').textContent = sub;
    };
    return {
      start(job) {
        const r = ensure();
        who = `Revendo${job.account?.login ? ` · compte @${job.account.login}` : ''}`;
        setState(r, 'busy', 'Remplissage du brouillon…');
        const rec = job.recognition || {};
        const mode = rec.mode === 'manual' ? 'Fiche saisie sur le PC' : 'Reconnaissance : étiquettes + catégories proposées par Vinted';
        meta = `<div class="meta">${esc(mode)}</div>`;
        if (rec.ocr?.error) meta += `<div class="msg warn">Lecture des étiquettes impossible : ${esc(rec.ocr.error)}</div>`;
        r.getElementById('b').innerHTML = `<div class="now">Ne touche à rien pendant ~1 minute.</div>${meta}`;
      },
      progress(label) {
        const r = ensure();
        r.getElementById('b').innerHTML = `<div class="now">En cours : <b>${esc(label)}</b>…</div>${meta}`;
      },
      done(result) {
        const r = ensure();
        const failed = (result.fields || []).filter((f) => !f.ok);
        if (result.draftSaved) {
          const todo = `${failed.length} point${failed.length > 1 ? 's' : ''} à compléter dans le brouillon`;
          setState(r, failed.length ? 'warn' : 'ok', 'Brouillon enregistré', failed.length ? todo : undefined);
        } else {
          setState(r, result.ok ? 'ok' : 'err', result.ok ? 'Formulaire rempli' : 'Brouillon non enregistré');
        }
        let html = (result.fields || [])
          .map(
            (f) =>
              `<div class="row"><span class="ic ${f.ok ? 'ok' : 'ko'}">${f.ok ? ICON.check : ICON.cross}</span><span class="l">${esc(f.label)}</span><span class="d">${esc(f.detail)}</span></div>`,
          )
          .join('');
        if (result.message) html += `<div class="msg ${result.ok ? 'info' : 'warn'}">${esc(result.message)}</div>`;
        html += '<div class="note">Rien n’a été publié : publie toi-même depuis « Mes brouillons » (app ou site Vinted).</div>';
        r.getElementById('b').innerHTML = html;
      },
    };
  })();
})();
