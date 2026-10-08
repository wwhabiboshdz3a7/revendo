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
 *     absente du catalogue la ligne « Utiliser "X" comme marque » ;
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

  /** Remonte d'une étiquette (« M / 38 / 10 ») à la case cliquable dont le texte est identique. */
  function chipHost(el) {
    const t = (el.textContent || '').trim();
    let host = el;
    for (let d = 0; d < 4; d += 1) {
      const p = host.parentElement;
      if (!p || (p.textContent || '').trim() !== t) break;
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

  function base64ToFile(b64, name, mime = 'image/jpeg') {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], name, { type: mime, lastModified: Date.now() });
  }

  function countThumbs() {
    const title = SEL.title();
    const limit = title ? title.getBoundingClientRect().top : Infinity;
    return [...document.querySelectorAll('main img, form img')].filter((img) => isVisible(img) && img.getBoundingClientRect().top < limit).length;
  }

  async function fillPhotos(count) {
    const files = [];
    for (let i = 0; i < count; i += 3) {
      const res = await send('RV_TAB_PHOTOS', { from: i, count: 3 });
      for (const p of res?.photos || []) files.push(base64ToFile(p.base64, p.name || `photo-${files.length + 1}.jpg`, p.mime));
    }
    if (!files.length) return { ok: false, detail: 'photos introuvables' };
    const input =
      [...document.querySelectorAll('input[type="file"]')].find((i) => /image/i.test(i.accept || '') || i.multiple) ||
      document.querySelector('input[type="file"]');
    if (!input) return { ok: false, detail: 'zone photo introuvable' };
    window.scrollTo({ top: 0 });
    await sleep(200);
    const before = countThumbs();
    const dt = new DataTransfer();
    files.slice(0, 20).forEach((f) => dt.items.add(f));
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => countThumbs() - before >= files.length, 20000, 300);
    const n = Math.max(0, countThumbs() - before);
    if (n > 0) await sleep(1500); // laisse Vinted analyser les photos (recommandations)
    return { ok: n > 0, detail: `${Math.min(n, files.length)}/${files.length} visibles` };
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

  function catScore(el, { kw, rayon, path, context }) {
    const [name = '', ...rest] = lines(el);
    const crumbs = normalize(rest.join(' '));
    let s = kw ? wordTier(name, kw) : 50;
    if (!s) return -Infinity;
    if (rayon) {
      if (crumbs) s += crumbs.startsWith(normalize(rayon)) ? 25 : -60;
    } else {
      if (/enfant|bebe|fille|garcon/.test(crumbs) && !/enfant|bebe|fille|garcon|ans\b/.test(context)) s -= 50;
    }
    for (const w of normalize(path || '').split(/[^a-z]+/).filter((x) => x.length >= 4)) if (crumbs.includes(w)) s += 6;
    for (const rx of NICHES) if (rx.test(crumbs + ' ' + normalize(name)) && !rx.test(context)) s -= 45;
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

  async function selectCategory(job) {
    const trigger = await waitFor(SEL.category, 6000);
    if (!trigger) return { ok: false, detail: 'champ introuvable' };
    const committed = () => (SEL.category()?.value || '').trim();
    if (committed()) return { ok: true, detail: committed(), name: committed() };

    const panel = await openPanel(trigger);
    if (!panel) return { ok: false, detail: "le menu ne s'est pas ouvert" };
    await sleep(600);
    const context = normalize(`${job.title || ''} ${job.category || ''} ${job.categoryPath || ''} ${job.rayon || ''}`);
    const ctx = { kw: job.category || '', rayon: job.rayon || '', path: job.categoryPath || '', context };
    const done = (el, how) => {
      const [name, ...rest] = lines(el);
      return { ok: true, detail: `${committed()}${rest.length ? ` (${rest.join(' ')})` : ''} — ${how}`, name: committed() || name, path: rest.join(' ') };
    };

    // 1) Recommandations de Vinted (photos + titre).
    const recos = recoRows(panel);
    if (recos.length) {
      const scored = recos.map((el) => ({ el, s: catScore(el, ctx) })).sort((a, b) => b.s - a.s);
      const pick = ctx.kw ? (scored[0].s >= 70 ? scored[0] : null) : scored[0].s > 0 ? scored[0] : null;
      if (pick && (await commitClick(pick.el, committed))) return done(pick.el, 'recommandée par Vinted');
    }

    // 2) Recherche « Trouver une catégorie ».
    if (ctx.kw) {
      const search = await waitFor(panel.search, 2500);
      if (search) {
        const terms = [...new Set([ctx.kw, ctx.kw.split(/\s+/)[0]])].filter((t) => t.length >= 3);
        for (const term of terms) {
          typeText(search, term);
          await sleep(900);
          if (!panel.options().some((o) => wordTier(lines(o)[0] || '', term))) {
            if (await trustedType(search, term)) await sleep(900);
          }
          let best = panel
            .options()
            .map((el) => ({ el, s: catScore(el, { ...ctx, kw: term }) }))
            .sort((a, b) => b.s - a.s)[0];
          if (best && best.s >= 70) {
            if (await commitClick(best.el, committed)) return done(best.el, `recherche « ${term} »`);
            // Branche (sous-menu) au lieu d'une catégorie finale : on choisit dans le niveau ouvert.
            await sleep(500);
            best = panel
              .options()
              .map((el) => ({ el, s: catScore(el, { ...ctx, kw: term }) }))
              .sort((a, b) => b.s - a.s)[0];
            if (best && best.s >= 60 && (await commitClick(best.el, committed))) return done(best.el, `recherche « ${term} »`);
          }
        }
        typeText(search, '');
        await sleep(500);
      }
    }

    // 3) Repli : première recommandation compatible avec le rayon.
    if (recos.length) {
      const fallback = recos
        .filter((el) => el.isConnected)
        .map((el) => ({ el, s: catScore(el, { ...ctx, kw: '' }) }))
        .sort((a, b) => b.s - a.s)[0];
      if (fallback && fallback.s > 0 && (await commitClick(fallback.el, committed))) return done(fallback.el, 'recommandation Vinted (repli)');
    }
    await closePanel();
    return { ok: false, detail: `aucune catégorie sûre pour « ${ctx.kw || 'cet article'} »${ctx.rayon ? ` (${ctx.rayon})` : ''}` };
  }

  // ---------- Marque ----------

  async function selectBrand(brand) {
    const trigger = await waitFor(SEL.brand, 4000);
    if (!trigger) return { ok: true, skip: true, detail: 'pas de marque pour cette catégorie' };
    const committed = () => (SEL.brand()?.value || '').trim();
    const target = normalize(brand);
    const exact = (el) => normalize(labelOf(el)) === target;

    const panel = await openPanel(trigger);
    if (!panel) return { ok: false, detail: "le menu ne s'est pas ouvert" };
    await sleep(500);

    const tryRows = async () => {
      const rows = panel
        .options()
        .filter(exact)
        .map((el) => chipHost(el))
        .sort((a, b) => Number(inSuggestions(a)) - Number(inSuggestions(b)));
      for (const row of rows.slice(0, 4)) {
        if (!row.isConnected) continue;
        if (await commitClick(row, committed)) return true;
      }
      return false;
    };

    if (await tryRows()) {
      await closePanel();
      return { ok: true, detail: committed() };
    }
    const search = await waitFor(panel.search, 2500);
    if (search) {
      typeText(search, brand);
      const hit = await waitFor(
        () => panel.options().some(exact) || panel.options().some((o) => /utiliser .* comme marque|use .* as brand/i.test(labelOf(o))),
        5000,
      );
      if (!hit && (await trustedType(search, brand))) await sleep(1500);
      if (await tryRows()) {
        await closePanel();
        return { ok: true, detail: committed() };
      }
      const create = panel.options().find((o) => /utiliser .* comme marque|use .* as brand/i.test(labelOf(o)));
      if (create && (await commitClick(chipHost(create), committed))) {
        await closePanel();
        return { ok: true, detail: `${committed()} (nouvelle marque)` };
      }
      typeText(search, '');
    }
    await closePanel();
    return { ok: false, detail: `« ${brand} » introuvable` };
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

    await step('Photos', job.photoCount > 0, () => fillPhotos(job.photoCount));
    await step('Titre', !!job.title, () => fillText(SEL.title, job.title));
    await step('Description', !!job.description, () => fillText(SEL.desc, job.description));
    await step('Prix', !!job.price, () => fillPrice(job.price));

    const cat = await step('Catégorie', true, () => selectCategory(job));
    if (job.composeAfterCategory && cat?.ok) {
      // Mode gratuit : titre et description composés d'après la catégorie choisie par Vinted.
      const composed = await send('RV_COMPOSE', { categoryName: cat.name, categoryPath: cat.path });
      if (composed?.ok) {
        job.title = composed.title;
        await step('Titre', true, () => fillText(SEL.title, composed.title));
        await step('Description', true, () => fillText(SEL.desc, composed.description));
      }
    }
    if (cat?.ok) {
      await waitFor(() => SEL.status() || SEL.brand() || SEL.size(), 8000, 300);
      await sleep(500);
    }

    // Sans catégorie, Vinted n'affiche pas les lignes suivantes : on les note « à faire ».
    const afterCat = (fn) => (cat?.ok ? fn() : Promise.resolve({ ok: false, detail: 'à choisir après la catégorie' }));
    await step('Marque', !!job.brand, () => afterCat(() => selectBrand(job.brand)));
    await dismissAuthenticityModal();
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

    const base = {
      fields: dedupe(fields),
      title: job.title,
      category: cat?.name || '',
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
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const ensure = () => {
      if (root) return root;
      host = document.createElement('div');
      host.style.cssText = 'all:initial;position:fixed;top:14px;right:14px;z-index:2147483647;';
      document.documentElement.appendChild(host);
      root = host.attachShadow({ mode: 'open' });
      root.innerHTML = `
        <style>
          .box{font:13px/1.45 -apple-system,"Segoe UI",Arial,sans-serif;background:#fff;color:#17191c;width:350px;border-radius:14px;
            box-shadow:0 12px 34px rgba(0,0,0,.2);overflow:hidden;border:1px solid #e3e6e9}
          .head{background:linear-gradient(135deg,#0bb8c1,#077a81);color:#fff;padding:12px 14px;font-weight:700;display:flex;justify-content:space-between;gap:8px}
          .x{cursor:pointer;opacity:.85}
          .body{padding:10px 14px 12px;max-height:60vh;overflow:auto}
          .row{display:flex;gap:8px;padding:4px 0;border-bottom:1px solid #f1f3f4}
          .row:last-child{border-bottom:0}
          .l{font-weight:650;min-width:98px}
          .d{color:#5f646a;word-break:break-word}
          .note{margin-top:8px;font-size:12px;color:#5f646a}
          .warn{margin-top:8px;font-size:12px;background:#fff6e5;border:1px solid #ffd99a;border-radius:8px;padding:8px}
        </style>
        <div class="box"><div class="head"><span id="t"></span><span class="x" id="x">✕</span></div><div class="body" id="b"></div></div>`;
      root.getElementById('x').addEventListener('click', () => host.remove());
      return root;
    };
    return {
      start(job) {
        const r = ensure();
        r.getElementById('t').textContent = '⏳ Revendo remplit le brouillon…';
        const mode = job.recognition?.mode === 'ai' ? `reconnaissance IA (${job.recognition.model || ''})` : 'mode gratuit (recommandations Vinted)';
        r.getElementById('b').innerHTML = `<div class="note">Ne touche à rien pendant ~1 minute.<br>${esc(mode)}${job.account?.login ? ` · compte @${esc(job.account.login)}` : ''}</div>`;
      },
      progress(label) {
        const r = ensure();
        r.getElementById('b').innerHTML = `<div class="note">En cours : <b>${esc(label)}</b>…</div>`;
      },
      done(result) {
        const r = ensure();
        const failed = (result.fields || []).filter((f) => !f.ok);
        r.getElementById('t').textContent = result.draftSaved
          ? failed.length
            ? `Brouillon enregistré — ${failed.length} point(s) à compléter`
            : 'Brouillon enregistré ✅'
          : result.ok
            ? 'Formulaire rempli'
            : 'Brouillon NON enregistré';
        let html = (result.fields || [])
          .map((f) => `<div class="row"><span class="l">${f.ok ? '✅' : '❌'} ${esc(f.label)}</span><span class="d">${esc(f.detail)}</span></div>`)
          .join('');
        if (result.message) html += `<div class="${result.ok ? 'note' : 'warn'}">${esc(result.message)}</div>`;
        html += '<div class="note">Rien n’a été publié : publie toi-même depuis « Mes brouillons » (app ou site Vinted).</div>';
        r.getElementById('b').innerHTML = html;
      },
    };
  })();
})();
