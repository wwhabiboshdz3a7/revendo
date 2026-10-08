/**
 * Revendo — dashboard téléphone (statique, hébergé sur Netlify).
 * Il ne parle qu'à GitHub (le relais) : photos + prix + compte → le PC fait le reste.
 * La configuration (token…) vient du QR code / code de connexion et reste
 * uniquement dans ce navigateur (localStorage).
 *
 * Envoi rapide : chaque photo est compressée (~400 Ko max) puis envoyée à
 * GitHub EN ARRIÈRE-PLAN dès qu'elle est prête, pendant que l'on tape le prix
 * et choisit le compte. Le bouton « Envoyer » n'a plus qu'à faire un commit.
 */
import { decodeConnection } from './shared/config.js';
import { toJpeg, toJpegTarget } from './shared/image.js';
import { formatPriceFR, parsePrice } from './shared/listing.js';
import { GitHubRelay } from './shared/relay.js';
import { CONDITIONS } from './shared/vinted-data.js';
import { hydrateIcons, icon } from './icons.js';

const VERSION = '3.3.0';
const MAX_PHOTOS = 20;
const PREP_PARALLEL = 2; // photos compressées en même temps
const UPLOAD_PARALLEL = 3; // photos envoyées en même temps
const PHOTO_TARGET = { maxSide: 1600, maxBytes: 400 * 1024 };
const POLL_MS = 12000;
const RAYONS = [['', 'Auto'], ['Femmes', 'Femme'], ['Hommes', 'Homme'], ['Enfants', 'Enfant'], ['Maison', 'Maison']];

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const LS = {
  get: (k, d = null) => {
    try {
      const v = localStorage.getItem(`revendo_${k}`);
      return v === null ? d : JSON.parse(v);
    } catch (_e) {
      return d;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(`revendo_${k}`, JSON.stringify(v));
    } catch (_e) {
      /* stockage plein / navigation privée */
    }
  },
  del: (k) => {
    try {
      localStorage.removeItem(`revendo_${k}`);
    } catch (_e) {
      /* navigation privée */
    }
  },
};

let cfg = LS.get('cfg');
let relay = null;
let lastState = null;
let loadError = '';
let refreshing = false;
let pollTimer = null;

/** Annonce en préparation. Les photos : voir newPhoto(). */
const form = {
  photos: [],
  account: LS.get('lastAccount', ''),
  rayon: LS.get('lastRayon', ''),
  condition: '',
  sending: false,
  committing: false,
  sendError: '',
};
const pipe = { prep: 0, up: 0, waiters: new Set() };

// ===========================================================================
// Outils d'affichage
// ===========================================================================

function show(view) {
  for (const v of ['setupView', 'homeView', 'newView']) $(v).classList.toggle('hidden', v !== view);
  document.body.classList.toggle('has-action-bar', view === 'newView');
  window.scrollTo({ top: 0 });
}

// Fine bordure sous la barre d'app collante dès que la page défile.
window.addEventListener('scroll', () => document.querySelector('.appbar-sticky')?.classList.toggle('is-stuck', window.scrollY > 4), { passive: true });

function toast(text, { kind = '', ms = 2800 } = {}) {
  const t = $('toast');
  const ic = kind === 'ok' ? icon('checkCircle', { size: 18, cls: 'ic-ok' }) : kind === 'err' ? icon('alert', { size: 18, cls: 'ic-err' }) : '';
  t.innerHTML = `${ic}<span>${esc(text)}</span>`;
  t.classList.remove('hidden');
  t.style.animation = 'none';
  void t.offsetHeight; // relance l'animation d'apparition
  t.style.animation = '';
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add('hidden'), ms);
}

/** Encadré de message (ok / err / warn / info / neutral) ; texte vide = masqué. */
function callout(el, text, kind = 'neutral', ic = '') {
  if (!text) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  const name = ic || { ok: 'checkCircle', err: 'alert', warn: 'alert', info: 'info', neutral: 'info' }[kind] || 'info';
  el.className = `callout callout-${kind}`;
  el.innerHTML = `${icon(name, { size: 18 })}<span>${esc(text)}</span>`;
}

/** « il y a 5 min » ; court : « 5 min ». */
function timeAgo(ts, { short = false } = {}) {
  const t = typeof ts === 'number' ? ts : Date.parse(ts);
  const s = Math.round((Date.now() - t) / 1000);
  if (!Number.isFinite(s)) return '';
  if (s < 60) return "à l'instant";
  const [n, u] = s < 3600 ? [Math.round(s / 60), 'min'] : s < 86400 ? [Math.round(s / 3600), 'h'] : [Math.round(s / 86400), 'j'];
  return short ? `${n} ${u}` : `il y a ${n} ${u}`;
}

function idToIso(id) {
  return id.replace(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2}).*/, '$1-$2-$3T$4:$5:$6Z');
}

function priceText(p) {
  const n = parseFloat(p);
  return Number.isFinite(n) && n > 0 ? formatPriceFR(n) : '';
}

/** Initiales d'un compte : « elias..djb » → ED, « lauraaix » → LA. */
function initials(login) {
  const parts = String(login || '?').split(/[^a-zA-Z0-9]+/).filter(Boolean);
  const s = parts.length > 1 ? parts[0][0] + parts[1][0] : (parts[0] || '?').slice(0, 2);
  return s.toUpperCase();
}

/** Teinte stable par compte (avatars), choisie dans une palette harmonieuse. */
function hue(login) {
  const HUES = [182, 214, 258, 330, 24, 148, 42, 200];
  let h = 0;
  for (const c of String(login)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return HUES[h % HUES.length];
}

function avatar(login, { small = false, presenceCls = null } = {}) {
  const dot = presenceCls === null ? '' : `<span class="presence ${presenceCls}"></span>`;
  return `<span class="avatar${small ? ' avatar-sm' : ''}" style="--h:${hue(login)}" aria-hidden="true">${esc(initials(login))}${dot}</span>`;
}

/** Petite roue de chargement (SVG). */
function ring(size = 14) {
  return `<svg class="ring" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-opacity=".28" stroke-width="3"/><path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>`;
}

/** Bouton à confirmer d'un 2e appui (évite les boîtes de dialogue natives). */
function armButton(btn, confirmLabel, action) {
  const original = btn.innerHTML;
  btn.addEventListener('click', async () => {
    if (btn.dataset.armed !== '1') {
      btn.dataset.armed = '1';
      btn.innerHTML = `${icon('alert', { size: 18 })}${esc(confirmLabel)}`;
      clearTimeout(btn.timer);
      btn.timer = setTimeout(() => {
        btn.dataset.armed = '';
        btn.innerHTML = original;
      }, 4000);
      return;
    }
    clearTimeout(btn.timer);
    btn.disabled = true;
    try {
      await action();
    } finally {
      btn.disabled = false;
      btn.dataset.armed = '';
      btn.innerHTML = original;
    }
  });
}

// ===========================================================================
// Connexion
// ===========================================================================

function saveConnection(code) {
  const parsed = decodeConnection(code);
  cfg = { relay: parsed.relay, name: parsed.name || cfg?.name || '' };
  LS.set('cfg', cfg);
}

$('connectBtn').addEventListener('click', () => {
  try {
    saveConnection($('codeInput').value);
    start();
  } catch (err) {
    callout($('setupStatus'), err.message, 'err');
  }
});

// Ouverture via le QR code : …/#c=REV1.xxx → on enregistre puis on efface le code de l'URL.
function connectFromHash() {
  if (!location.hash.startsWith('#c=')) return false;
  let ok = true;
  try {
    saveConnection(location.hash);
  } catch (err) {
    ok = false;
    setTimeout(() => callout($('setupStatus'), err.message, 'err'), 0);
  }
  history.replaceState(null, '', location.pathname + location.search);
  return ok;
}
connectFromHash();
// Lien ouvert alors que la page l'était déjà (même onglet) : pas de rechargement.
window.addEventListener('hashchange', () => {
  if (connectFromHash()) location.reload();
});

// ===========================================================================
// Accueil
// ===========================================================================

function accountsList() {
  return (lastState?.accounts || []).slice().sort((a, b) => a.login.localeCompare(b.login));
}

/** Présence d'un compte d'après sa dernière annonce par le PC. */
function presence(a) {
  const t = Date.parse(a.updatedAt || '');
  if (!Number.isFinite(t)) return { cls: '', text: 'jamais vu' };
  const age = Date.now() - t;
  if (age < 45 * 60 * 1000) return { cls: 'on', text: 'en ligne' };
  return { cls: age < 24 * 3600 * 1000 ? 'mid' : '', text: `vu ${timeAgo(t)}` };
}

function renderHello() {
  const h = new Date().getHours();
  const word = h >= 18 || h < 5 ? 'Bonsoir' : 'Bonjour';
  $('hello').textContent = cfg?.name ? `${word} ${cfg.name}` : word;
}

function renderAccountsRow() {
  const box = $('accountsRow');
  if (!lastState) {
    box.innerHTML = loadError
      ? ''
      : Array.from({ length: 2 }, () => '<div class="acc sk-acc"><span class="sk" style="width:36px;height:36px;border-radius:50%"></span><span class="acc-text" style="gap:6px"><span class="sk sk-line" style="width:84px"></span><span class="sk sk-line" style="width:56px;height:10px"></span></span></div>').join('');
    $('accountsMeta').textContent = '';
    return;
  }
  const accs = accountsList();
  const online = accs.filter((a) => presence(a).cls === 'on').length;
  $('accountsMeta').textContent = accs.length ? `${online}/${accs.length} en ligne` : '';
  box.innerHTML = accs.length
    ? accs
        .map((a) => {
          const p = presence(a);
          return `<div class="acc" title="@${esc(a.login)} — ${esc(p.text)}">${avatar(a.login, { presenceCls: p.cls })}<span class="acc-text"><span class="acc-name">@${esc(a.login)}</span><span class="acc-seen ${p.cls}">${esc(p.text)}</span></span></div>`;
        })
        .join('')
    : `<div class="acc-empty">${icon('monitor', { size: 20 })}<span>Aucun compte : ouvre Vinted dans chaque profil Chrome du PC (avec l’extension).</span></div>`;
}

function queueItems() {
  if (!lastState) return [];
  const items = [];
  for (const j of lastState.jobs) {
    const s = lastState.statuses.get(j.id);
    items.push({
      id: j.id,
      account: j.account,
      thumb: j.data?.thumb || s?.thumb,
      price: j.data?.price,
      state: s?.state || 'pending',
      status: s,
      hasFiles: true,
      hints: j.data?.hints || {},
      photoCount: j.data?.photos?.length || j.photos.length,
    });
  }
  for (const [id, s] of lastState.statuses) {
    if (!lastState.jobs.some((j) => j.id === id)) items.push({ id, account: s.account, thumb: s.thumb, price: s.summary?.price, state: s.state, status: s, hasFiles: false, hints: {}, photoCount: 0 });
  }
  return items.sort((a, b) => b.id.localeCompare(a.id)).slice(0, 50);
}

/** Pastille de statut d'une annonce. */
function statusView(i) {
  if (i.state === 'pending') return { cls: 'pending', label: 'En attente' };
  if (i.state === 'processing') return { cls: 'processing', label: 'En cours' };
  if (i.state === 'error') return { cls: 'error', label: 'Échec' };
  if (i.state === 'done') {
    const missing = (i.status?.fields || []).some((f) => f && f.ok === false);
    return missing ? { cls: 'partial', label: 'À compléter' } : { cls: 'done', label: 'Brouillon créé' };
  }
  return { cls: '', label: i.state || '?' };
}

function itemTitle(i) {
  const t = i.status?.summary?.title;
  if (t) return { text: t, fallback: false };
  if (i.state === 'processing') return { text: 'Reconnaissance et remplissage…', fallback: true };
  if (i.hints?.brand) return { text: `Article ${i.hints.brand}`, fallback: true };
  if (i.state === 'pending') return { text: 'Annonce envoyée', fallback: true };
  return { text: 'Annonce sans titre', fallback: true };
}

function thumbHtml(src, size = 22) {
  return `<span class="thumb">${src ? `<img src="${esc(src)}" alt="" loading="lazy" decoding="async">` : icon('image', { size })}</span>`;
}

function renderQueue() {
  const box = $('queue');
  if (!lastState) {
    box.innerHTML = loadError
      ? ''
      : Array.from(
          { length: 3 },
          () => '<div class="item sk-item"><span class="sk" style="width:56px;height:56px;border-radius:10px"></span><span class="item-body"><span class="sk sk-line" style="width:70%"></span><span class="sk sk-line" style="width:45%;height:10px"></span></span><span></span></div>',
        ).join('');
    return;
  }
  const items = queueItems();
  if (!items.length) {
    box.innerHTML = `<div class="empty">
      <span class="empty-icon">${icon('inbox', { size: 24 })}</span>
      <h3>Aucune annonce en cours</h3>
      <p>Prends l’article en photo et indique le prix : le PC prépare le brouillon Vinted.</p>
      <button type="button" class="btn btn-secondary" id="emptyNewBtn">${icon('plus', { size: 18 })}Nouvelle annonce</button>
    </div>`;
    $('emptyNewBtn').addEventListener('click', () => openNew());
    return;
  }
  box.innerHTML = items
    .map((i) => {
      const st = statusView(i);
      const title = itemTitle(i);
      const meta = [`@${i.account}`, timeAgo(i.status?.updatedAt || idToIso(i.id), { short: true })].filter(Boolean).join(' · ');
      const price = priceText(i.price);
      return `<button type="button" class="item" data-id="${esc(i.id)}">
        ${thumbHtml(i.thumb)}
        <span class="item-body">
          <span class="item-row"><span class="item-title${title.fallback ? ' muted' : ''}">${esc(title.text)}</span>${price ? `<span class="item-price">${esc(price)}</span>` : ''}</span>
          <span class="item-row"><span class="pill pill-${st.cls}">${esc(st.label)}</span><span class="item-meta">${esc(meta)}</span></span>
        </span>
        <span class="item-chev">${icon('chevronRight', { size: 18 })}</span>
      </button>`;
    })
    .join('');
  box.querySelectorAll('.item').forEach((c) => c.addEventListener('click', () => openDetail(c.dataset.id)));
}

function renderNewButton() {
  const n = form.photos.length;
  $('newBtn').innerHTML = `${icon('camera', { size: 22 })}${n ? `Reprendre l’annonce · ${plural(n, 'photo')}` : 'Nouvelle annonce'}`;
}

function renderHome() {
  renderAccountsRow();
  renderQueue();
  renderNewButton();
}

/** Relit le relais. spin : l'icône tourne (actualisation demandée, pas le rafraîchissement auto). */
async function refresh({ spin = false } = {}) {
  if (!relay || refreshing) return;
  refreshing = true;
  if (spin) $('refreshBtn').classList.add('is-busy');
  try {
    lastState = await relay.state();
    loadError = '';
    callout($('homeMsg'), '');
    renderHome();
    if (!$('newView').classList.contains('hidden')) renderAccountChips();
    refreshOpenDetail();
  } catch (err) {
    loadError = err.message;
    callout($('homeMsg'), err.message, 'err');
    if (!lastState) renderHome();
  } finally {
    refreshing = false;
    $('refreshBtn').classList.remove('is-busy');
  }
}

$('refreshBtn').addEventListener('click', () => refresh({ spin: true }));
$('newBtn').addEventListener('click', () => openNew());

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') void refresh();
  }, POLL_MS);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && relay) {
    renderHello();
    void refresh();
    retryFailedUploads();
  }
});
// Réseau revenu (ou écran rallumé) : on relance les photos dont l'envoi a échoué.
window.addEventListener('online', () => retryFailedUploads());

function retryFailedUploads() {
  let any = false;
  for (const p of form.photos) {
    if (p.state === 'err') {
      p.state = 'up';
      p.error = '';
      any = true;
    }
  }
  if (any) photosChanged();
}

// ===========================================================================
// Feuille du bas (détail / réglages)
// ===========================================================================

let sheetCtx = null; // { type: 'detail', id, sig } | { type: 'settings' }
let sheetReturnFocus = null;

function openSheet(html, ctx) {
  const sheet = $('sheet');
  $('sheetBody').innerHTML = html;
  $('sheetBody').scrollTop = 0;
  sheetCtx = ctx;
  const wasHidden = sheet.classList.contains('hidden') || sheet.classList.contains('is-closing');
  if (sheet.classList.contains('hidden')) sheetReturnFocus = document.activeElement;
  sheet.classList.remove('hidden', 'is-closing');
  $('sheetPanel').style.transform = '';
  document.body.classList.add('sheet-open');
  if (wasHidden) $('sheetPanel').focus({ preventScroll: true });
}

function closeSheet() {
  const sheet = $('sheet');
  if (sheet.classList.contains('hidden')) return;
  sheetCtx = null;
  document.body.classList.remove('sheet-open');
  const done = () => {
    sheet.classList.add('hidden');
    sheet.classList.remove('is-closing');
    $('sheetPanel').style.transform = '';
  };
  if (reducedMotion()) done();
  else {
    sheet.classList.add('is-closing');
    setTimeout(done, 180);
  }
  sheetReturnFocus?.focus?.({ preventScroll: true });
}

$('sheetClose').addEventListener('click', closeSheet);
$('sheetBackdrop').addEventListener('click', closeSheet);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSheet();
});

// Glisser la poignée vers le bas pour fermer.
(() => {
  const grip = $('sheetGrip');
  const panel = $('sheetPanel');
  let y0 = null;
  let dy = 0;
  grip.addEventListener('pointerdown', (e) => {
    y0 = e.clientY;
    dy = 0;
    grip.setPointerCapture(e.pointerId);
    panel.style.transition = 'none';
  });
  grip.addEventListener('pointermove', (e) => {
    if (y0 === null) return;
    dy = Math.max(0, e.clientY - y0);
    panel.style.transform = `translateY(${dy}px)`;
  });
  const end = () => {
    if (y0 === null) return;
    y0 = null;
    panel.style.transition = '';
    if (dy > 90) closeSheet();
    else panel.style.transform = '';
  };
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
})();

// ===========================================================================
// Détail d'une annonce
// ===========================================================================

/** Ligne « Reconnaissance » : IA + modèle, ou mode gratuit avec la raison. */
function recognitionView(sum) {
  if (sum.mode === 'ai') return { cls: 'ai', ic: 'sparkles', text: sum.aiModel ? `IA · ${sum.aiModel}` : 'IA' };
  if (sum.mode === 'free') {
    if (sum.noKey) return { cls: 'free', ic: 'info', text: 'Mode gratuit — pas de clé IA sur le PC' };
    if (sum.aiError) return { cls: 'warn', ic: 'alert', text: `Mode gratuit — IA indisponible : ${sum.aiError}` };
    return { cls: 'free', ic: 'info', text: 'Mode gratuit' };
  }
  return null;
}

/** Ligne « Photos » : visibles / envoyées (statut récent, sinon déduit des champs). */
function photosView(i) {
  const sp = i.status?.summary?.photos;
  if (sp && Number.isFinite(Number(sp.sent)) && Number(sp.sent) > 0) {
    const shown = Number.isFinite(Number(sp.shown)) ? Number(sp.shown) : null;
    return { text: shown === null ? plural(Number(sp.sent), 'photo') : `${shown}/${sp.sent} visibles`, ok: shown === null ? null : shown >= Number(sp.sent) };
  }
  const f = (i.status?.fields || []).find((x) => /^photos?$/i.test(String(x?.label || '').trim()));
  const m = f && /(\d+)\s*\/\s*(\d+)/.exec(f.detail || '');
  if (m) return { text: `${m[1]}/${m[2]} visibles`, ok: Number(m[1]) >= Number(m[2]) };
  if (i.photoCount) return { text: `${plural(i.photoCount, 'photo')} envoyée${i.photoCount > 1 ? 's' : ''}`, ok: null };
  return null;
}

function detailSig(i) {
  return `${i.state}|${i.status?.updatedAt || ''}|${i.hasFiles}`;
}

function kvRow(label, value, { cls = '', ic = '' } = {}) {
  if (!value) return '';
  return `<div class="kv-row"><dt>${esc(label)}</dt><dd class="${cls}">${ic ? icon(ic, { size: 16 }) : ''}<span>${esc(value)}</span></dd></div>`;
}

function openDetail(id) {
  const i = queueItems().find((x) => x.id === id);
  if (!i) return;
  const s = i.status;
  const sum = s?.summary || {};
  const st = statusView(i);
  const title = itemTitle(i);
  const reco = recognitionView(sum);
  const ph = photosView(i);
  const stuck = i.state === 'processing' && Date.now() - Date.parse(s?.updatedAt || 0) > 10 * 60 * 1000;
  const hints = i.hints || {};
  const hintText = [hints.rayon && `rayon ${hints.rayon}`, hints.brand && `marque ${hints.brand}`, hints.size && `taille ${hints.size}`, hints.condition, hints.notes && `« ${hints.notes} »`].filter(Boolean).join(', ');
  const fields = (s?.fields || [])
    .filter((f) => f && f.label)
    .map((f) => `<li class="${f.ok ? 'ok' : 'ko'}">${icon(f.ok ? 'checkCircle' : 'xCircle', { size: 18, label: f.ok ? 'rempli' : 'à compléter' })}<span class="ck-text"><b>${esc(f.label)}</b>${f.detail ? `<span>${esc(f.detail)}</span>` : ''}</span></li>`)
    .join('');
  const seo = Number.isFinite(sum.seo) ? Math.max(0, Math.min(100, sum.seo)) : null;
  const tips = (sum.seoTodo || []).map((t) => `<li>${esc(t)}</li>`).join('');
  const msgKind = i.state === 'error' ? 'err' : st.cls === 'partial' ? 'warn' : i.state === 'done' ? 'ok' : 'info';
  const meta = [`@${i.account}`, timeAgo(s?.updatedAt || idToIso(i.id))].filter(Boolean).join(' · ');

  let help = '';
  if (i.state === 'pending') help = 'En attente : le profil Chrome de ce compte doit être ouvert sur le PC.';
  else if (i.state === 'processing') help = stuck ? 'Aucune nouvelle depuis plus de 10 minutes : tu peux relancer.' : 'Le PC reconnaît l’article et remplit le formulaire Vinted.';
  else if (i.state === 'done') help = 'Retrouve-le dans Vinted → Profil → Mes brouillons, vérifie et publie.';

  const html = `
    <div class="detail-head">
      ${thumbHtml(i.thumb, 26)}
      <div class="detail-head-text">
        <span class="pill pill-${st.cls}">${esc(st.label)}</span>
        <h2 id="sheetTitle">${esc(title.text)}</h2>
        <p class="detail-meta">${esc(meta)}</p>
      </div>
    </div>
    ${s?.message ? `<div class="callout callout-${msgKind}">${icon(msgKind === 'ok' ? 'checkCircle' : msgKind === 'info' ? 'info' : 'alert', { size: 18 })}<span>${esc(s.message)}</span></div>` : ''}
    <dl class="kv">
      ${reco ? kvRow('Reconnaissance', reco.text, { cls: reco.cls, ic: reco.ic }) : ''}
      ${ph ? kvRow('Photos', ph.text, { cls: ph.ok === false ? 'warn' : '', ic: ph.ok === false ? 'alert' : ph.ok ? 'checkCircle' : '' }) : ''}
      ${kvRow('Catégorie', sum.category)}
      ${kvRow('Marque', sum.brand)}
      ${kvRow('Taille', sum.size)}
      ${kvRow('Couleur', (sum.colors || []).join(' / '))}
      ${kvRow('État', sum.condition)}
      ${kvRow('Prix', priceText(i.price))}
      ${!s ? kvRow('Indications', hintText) : ''}
    </dl>
    ${fields ? `<h3>Remplissage</h3><ul class="checklist">${fields}</ul>` : ''}
    ${seo !== null ? `<h3>Référencement</h3><div class="seo"><div class="seo-bar" role="img" aria-label="Score ${seo} sur 100"><i class="${seo < 60 ? 'low' : ''}" style="width:${seo}%"></i></div><span class="seo-score">${seo}/100</span></div>` : ''}
    ${tips ? `<ul class="tips">${tips}</ul>` : ''}
    ${help ? `<p class="hint">${esc(help)}</p>` : ''}
    <div class="sheet-actions">
      ${(i.state === 'error' || stuck) && i.hasFiles ? `<button type="button" id="retryBtn" class="btn btn-secondary btn-lg">${icon('retry', { size: 18 })}Réessayer</button>` : ''}
      <button type="button" id="deleteBtn" class="btn btn-danger btn-lg">${icon('trash', { size: 18 })}${i.state === 'done' ? 'Retirer du suivi' : 'Supprimer'}</button>
    </div>`;
  openSheet(html, { type: 'detail', id, sig: detailSig(i) });

  $('retryBtn')?.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try {
      await relay.retryJob(id);
      closeSheet();
      toast('Relancée : le PC va la reprendre.', { kind: 'ok' });
      void refresh();
    } catch (err) {
      toast(err.message, { kind: 'err', ms: 4500 });
      if ($('retryBtn')) $('retryBtn').disabled = false;
    }
  });
  armButton($('deleteBtn'), i.state === 'done' ? 'Confirmer (le brouillon reste)' : 'Confirmer la suppression', async () => {
    try {
      await relay.deleteJob(id);
      closeSheet();
      toast(i.state === 'done' ? 'Retirée du suivi.' : 'Annonce supprimée.', { kind: 'ok' });
      void refresh();
    } catch (err) {
      toast(err.message, { kind: 'err', ms: 4500 });
    }
  });
}

/** Met à jour la fiche ouverte si son statut a changé (rafraîchissement auto). */
function refreshOpenDetail() {
  if (sheetCtx?.type !== 'detail') return;
  const i = queueItems().find((x) => x.id === sheetCtx.id);
  if (!i) return closeSheet();
  if (detailSig(i) === sheetCtx.sig) return;
  const top = $('sheetBody').scrollTop;
  openDetail(sheetCtx.id);
  $('sheetBody').scrollTop = top;
}

// ===========================================================================
// Réglages
// ===========================================================================

$('settingsBtn').addEventListener('click', () => {
  const r = cfg.relay;
  openSheet(
    `<h2 id="sheetTitle">Réglages</h2>
    <label class="label" for="nameInput">Ton prénom</label>
    <div class="settings-name">
      <input type="text" id="nameInput" class="input" value="${esc(cfg.name || '')}" placeholder="Pour la salutation" autocomplete="given-name" />
      <button type="button" id="saveNameBtn" class="btn btn-primary">Enregistrer</button>
    </div>
    <div class="list-group">
      <div class="list-row">
        <span class="list-icon">${icon('database', { size: 18 })}</span>
        <span class="list-text"><b>Relais GitHub</b><span>${esc(r.owner)}/${esc(r.repo)} · branche ${esc(r.branch)}</span></span>
      </div>
      <div class="list-row">
        <span class="list-icon">${icon('monitor', { size: 18 })}</span>
        <span class="list-text"><b>Comptes du PC</b><span>${lastState ? `${plural(accountsList().length, 'compte')} déclaré${accountsList().length > 1 ? 's' : ''}` : '—'}</span></span>
      </div>
    </div>
    <div class="sheet-actions"><button type="button" id="testBtn" class="btn btn-secondary btn-lg">${icon('link', { size: 18 })}Tester la connexion</button></div>
    <div id="settingsMsg" class="callout hidden" role="status"></div>
    <div class="sheet-actions"><button type="button" id="logoutBtn" class="btn btn-danger-ghost btn-lg">${icon('logout', { size: 18 })}Déconnecter ce téléphone</button></div>
    <div class="settings-foot">
      <p class="hint">Le code de connexion donne accès au relais : ne le partage pas.</p>
      <p class="version">Revendo ${VERSION}</p>
    </div>`,
    { type: 'settings' },
  );
  $('testBtn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.classList.add('is-busy');
    try {
      const info = await relay.repoInfo();
      // Dépôt public : choix assumé (projet d'école) → simple information, pas d'alerte.
      if (info.private) callout($('settingsMsg'), 'Connexion OK — dépôt privé.', 'ok', 'lock');
      else callout($('settingsMsg'), 'Connexion OK — dépôt public : les photos y transitent le temps du traitement.', 'neutral', 'globe');
    } catch (err) {
      callout($('settingsMsg'), err.message, 'err');
    } finally {
      btn.disabled = false;
      btn.classList.remove('is-busy');
    }
  });
  const saveName = () => {
    cfg.name = $('nameInput').value.trim();
    LS.set('cfg', cfg);
    renderHello();
    closeSheet();
    toast('Prénom enregistré.', { kind: 'ok' });
  };
  $('saveNameBtn').addEventListener('click', saveName);
  $('nameInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveName();
  });
  armButton($('logoutBtn'), 'Confirmer la déconnexion', async () => {
    LS.del('cfg');
    location.reload();
  });
});

// ===========================================================================
// Nouvelle annonce : photos (préparation + envoi en arrière-plan)
// ===========================================================================

/**
 * Photo du formulaire. state : 'prep' (compression) → 'up' (envoi du blob)
 * → 'ok' (sha connu) | 'err' (envoi échoué : relancé au clic « Envoyer »).
 */
function newPhoto(file) {
  return { id: Math.random().toString(36).slice(2, 10), file, state: 'prep', busy: false, preview: '', thumb: '', base64: '', bytes: 0, sha: '', isLabel: false, error: '' };
}

/** Lance les préparations (2 à la fois) puis les envois (3 à la fois), dans l'ordre de la grille. */
function pump() {
  if (!relay) return;
  for (const p of form.photos) {
    if (pipe.prep >= PREP_PARALLEL) break;
    if (p.state === 'prep' && !p.busy) void preparePhoto(p);
  }
  for (const p of form.photos) {
    if (pipe.up >= UPLOAD_PARALLEL) break;
    if (p.state === 'up' && !p.busy) void uploadPhoto(p);
  }
}

async function preparePhoto(p) {
  p.busy = true;
  pipe.prep += 1;
  try {
    // ~400 Ko max : Safari encode « 0,85 » comme ~95 % (≈ 900 Ko par photo).
    const jpg = await toJpegTarget(p.file, PHOTO_TARGET);
    const [preview, thumb] = await Promise.all([toJpeg(jpg.dataUrl, { maxSide: 540, quality: 0.8 }), toJpeg(jpg.dataUrl, { maxSide: 160, quality: 0.7 })]);
    Object.assign(p, { file: null, base64: jpg.base64, bytes: jpg.bytes, preview: preview.dataUrl, thumb: thumb.dataUrl, state: 'up' });
  } catch (err) {
    p.state = 'bad';
    if (form.photos.includes(p)) {
      form.photos = form.photos.filter((x) => x !== p);
      toast(`Photo ignorée : ${err.message}`, { kind: 'err', ms: 4000 });
    }
  } finally {
    p.busy = false;
    pipe.prep -= 1;
    photosChanged();
  }
}

async function uploadPhoto(p) {
  p.busy = true;
  pipe.up += 1;
  try {
    p.sha = await relay.uploadBlob(p.base64);
    p.state = 'ok';
    p.error = '';
  } catch (err) {
    p.state = 'err';
    p.error = err.message;
  } finally {
    p.busy = false;
    pipe.up -= 1;
    photosChanged();
  }
}

function photosBusy() {
  return form.photos.some((p) => p.state === 'prep' || p.state === 'up');
}

/** Attend que plus aucune photo ne soit en préparation ou en cours d'envoi. */
function waitForPhotos() {
  return new Promise((resolve) => {
    const check = () => {
      if (photosBusy()) return;
      pipe.waiters.delete(check);
      resolve();
    };
    pipe.waiters.add(check);
    check();
  });
}

function photosChanged() {
  renderPhotos();
  renderSendState();
  for (const w of [...pipe.waiters]) w();
  pump();
}

const tiles = new Map(); // id photo → élément de la grille

function tileUi(p, i) {
  const n = i + 1;
  const status = {
    prep: '',
    up: `<span class="ph-status" title="Envoi en cours">${ring(13)}<span class="sr-only">Photo ${n} en cours d’envoi</span></span>`,
    ok: `<span class="ph-status" title="Envoyée">${icon('check', { size: 14 })}<span class="sr-only">Photo ${n} envoyée</span></span>`,
    err: `<button type="button" class="ph-status" data-act="retry" aria-label="Renvoyer la photo ${n}" title="${esc(p.error)}">${icon('retry', { size: 13 })}</button>`,
  }[p.state] || '';
  return `${p.state === 'prep' ? `<span class="ph-prep" title="Préparation"><span class="sk"></span>${ring(20)}<span class="sr-only">Photo ${n} en préparation</span></span>` : ''}
    ${status}
    <button type="button" class="ph-del" data-act="del" aria-label="Retirer la photo ${n}"><span>${icon('x', { size: 14 })}</span></button>
    ${i === 0 ? '<span class="ph-cover" aria-hidden="true">Couverture</span>' : ''}
    <button type="button" class="ph-label" data-act="label" aria-pressed="${p.isLabel}" aria-label="Photo ${n} : c’est l’étiquette" title="Photo de l’étiquette">${icon(p.isLabel ? 'check' : 'tag', { size: 14 })}<span class="lbl-text">Étiquette</span></button>`;
}

function renderPhotos() {
  const grid = $('photoGrid');
  const ids = new Set(form.photos.map((p) => p.id));
  for (const [id, el] of tiles) {
    if (!ids.has(id)) {
      el.remove();
      tiles.delete(id);
    }
  }
  form.photos.forEach((p, i) => {
    let el = tiles.get(p.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'ph';
      el.dataset.id = p.id;
      el.innerHTML = '<button type="button" class="ph-open" data-act="cover"></button><div class="ph-ui"></div>';
      tiles.set(p.id, el);
    }
    const open = el.firstElementChild;
    // L'image n'est posée qu'une fois (pas de clignotement quand l'état change).
    if (p.preview && !open.firstElementChild) open.innerHTML = `<img src="${p.preview}" alt="" decoding="async">`;
    open.setAttribute('aria-label', i === 0 ? `Photo 1, couverture` : `Photo ${i + 1} : mettre en couverture`);
    el.dataset.state = p.state;
    el.classList.toggle('is-cover', i === 0);
    const sig = `${p.state}|${i}|${p.isLabel}|${p.error}`;
    if (el.dataset.sig !== sig) {
      el.dataset.sig = sig;
      el.lastElementChild.innerHTML = tileUi(p, i);
    }
    if (grid.children[i] !== el) grid.insertBefore(el, grid.children[i] || null);
  });

  let add = $('addTile');
  if (!add) {
    add = document.createElement('button');
    add.type = 'button';
    add.id = 'addTile';
    add.dataset.act = 'add';
  }
  const n = form.photos.length;
  add.hidden = n >= MAX_PHOTOS;
  add.className = `add-tile${n ? '' : ' add-empty'}`;
  add.setAttribute('aria-label', n ? `Ajouter des photos (${n} sur ${MAX_PHOTOS})` : 'Ajouter des photos');
  add.innerHTML = n
    ? `${icon('plus', { size: 22 })}<span>Ajouter</span><small>${n}/${MAX_PHOTOS}</small>`
    : `<span class="add-icon">${icon('camera', { size: 24 })}</span><b>Ajouter des photos</b><small>Prends l’article et son étiquette (taille, marque) : la reconnaissance sera meilleure.</small>`;
  grid.appendChild(add);
  grid.classList.toggle('is-locked', form.sending);
  $('photoCount').textContent = n ? `${n}/${MAX_PHOTOS}` : '';
  $('photoHint').classList.toggle('hidden', !n);
  if (n && !$('photoHint').childElementCount) $('photoHint').innerHTML = `Touche une photo pour en faire la couverture. Touche ${icon('tag', { size: 15 })} sur la photo de l’étiquette (taille, marque) : la reconnaissance sera meilleure.`;
}

$('photoGrid').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn || form.sending) return;
  const act = btn.dataset.act;
  if (act === 'add') {
    $('photoInput').click();
    return;
  }
  const p = form.photos.find((x) => x.id === btn.closest('.ph')?.dataset.id);
  if (!p) return;
  if (act === 'del') form.photos = form.photos.filter((x) => x !== p);
  else if (act === 'cover') form.photos = [p, ...form.photos.filter((x) => x !== p)];
  else if (act === 'label') p.isLabel = !p.isLabel;
  else if (act === 'retry' && p.state === 'err') {
    p.state = 'up';
    p.error = '';
  }
  form.sendError = '';
  photosChanged();
});

$('photoInput').addEventListener('change', (e) => {
  const files = [...(e.target.files || [])].filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|heic|heif|webp)$/i.test(f.name));
  e.target.value = '';
  const room = MAX_PHOTOS - form.photos.length;
  if (files.length > room) toast(`${MAX_PHOTOS} photos maximum : ${plural(files.length - room, 'photo')} ignorée${files.length - room > 1 ? 's' : ''}.`, { ms: 3500 });
  for (const f of files.slice(0, Math.max(0, room))) form.photos.push(newPhoto(f));
  form.sendError = '';
  photosChanged();
});

// ===========================================================================
// Nouvelle annonce : prix, compte, rayon, précisions
// ===========================================================================

/** Ouvre le formulaire ; une annonce commencée (photos déjà choisies) est reprise telle quelle. */
function openNew({ reset = false } = {}) {
  if (reset || !form.photos.length) {
    form.photos = [];
    form.condition = '';
    form.sendError = '';
    $('price').value = '';
    $('brand').value = '';
    $('size').value = '';
    $('notes').value = '';
    $('moreBox').open = false;
    renderPriceCheck();
  }
  renderPhotos();
  renderAccountChips();
  renderRayonChips();
  renderConditionChips();
  renderMoreSummary();
  renderSendState();
  show('newView');
}

$('backBtn').addEventListener('click', () => {
  show('homeView');
  renderNewButton();
  void refresh();
});

function choice(cls, label, checked, onPick, before = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.setAttribute('role', 'radio');
  b.setAttribute('aria-checked', String(checked));
  b.innerHTML = `${before}<span>${esc(label)}</span>`;
  b.addEventListener('click', onPick);
  return b;
}

/** Flèches gauche/droite dans un groupe de choix (role=radiogroup). */
function arrowKeys(box) {
  box.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const items = [...box.querySelectorAll('[role="radio"]')];
    const at = items.indexOf(document.activeElement);
    if (at < 0) return;
    const next = items[(at + (e.key === 'ArrowRight' ? 1 : items.length - 1)) % items.length];
    next.click();
    box.querySelectorAll('[role="radio"]')[items.indexOf(next)]?.focus();
    e.preventDefault();
  });
}

function renderAccountChips() {
  const box = $('accountChips');
  box.innerHTML = '';
  const accs = accountsList();
  if (!accs.length) {
    box.innerHTML = `<p class="hint" style="margin:0">${lastState ? 'Aucun compte déclaré par le PC pour l’instant.' : 'Chargement des comptes…'}</p>`;
    return;
  }
  if (!accs.some((a) => a.login === form.account)) form.account = accs.length === 1 ? accs[0].login : '';
  for (const a of accs) {
    const p = presence(a);
    const chip = choice('chip chip-acc', `@${a.login}`, form.account === a.login, () => {
      form.account = a.login;
      form.sendError = '';
      LS.set('lastAccount', a.login);
      renderAccountChips();
      renderSendState();
    }, `${avatar(a.login, { small: true })}<span class="dot ${p.cls}" title="${esc(p.text)}"></span>`);
    chip.setAttribute('aria-label', `@${a.login}, ${p.text}`);
    box.appendChild(chip);
  }
}

function renderRayonChips() {
  const box = $('rayonChips');
  box.innerHTML = '';
  for (const [value, label] of RAYONS) {
    box.appendChild(
      choice('seg', label, form.rayon === value, () => {
        form.rayon = value;
        LS.set('lastRayon', value);
        renderRayonChips();
      }),
    );
  }
}

function renderConditionChips() {
  const box = $('conditionChips');
  box.innerHTML = '';
  const pick = (v) => () => {
    form.condition = v;
    renderConditionChips();
    renderMoreSummary();
  };
  box.appendChild(choice('chip', 'Auto', !form.condition, pick('')));
  for (const c of CONDITIONS) box.appendChild(choice('chip', c.name, form.condition === c.name, pick(c.name)));
}

for (const id of ['accountChips', 'rayonChips', 'conditionChips']) arrowKeys($(id));

/** Résumé de la section « Préciser » quand elle est repliée. */
function renderMoreSummary() {
  const parts = [$('brand').value.trim(), $('size').value.trim() && `taille ${$('size').value.trim()}`, form.condition, $('notes').value.trim() && 'note'].filter(Boolean);
  const el = $('moreSub');
  el.textContent = parts.length ? parts.join(' · ') : 'optionnel · marque, taille, état, note';
  el.classList.toggle('set', parts.length > 0);
}
for (const id of ['brand', 'size', 'notes']) $(id).addEventListener('input', renderMoreSummary);

function renderPriceCheck() {
  const raw = $('price').value.trim();
  const n = parsePrice(raw);
  const el = $('priceCheck');
  el.className = `field-hint${!raw ? '' : n ? ' ok' : ' err'}`;
  el.innerHTML = !raw ? '' : n ? `${icon('checkCircle', { size: 16 })}<span>Prix sur Vinted : ${esc(formatPriceFR(n))}</span>` : `${icon('alert', { size: 16 })}<span>Prix invalide (ex : 15 ou 12,50)</span>`;
}

$('price').addEventListener('input', () => {
  renderPriceCheck();
  if (form.sendError) {
    form.sendError = '';
    renderSendState();
  }
});
$('price').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') e.currentTarget.blur();
});

// ===========================================================================
// Nouvelle annonce : barre d'envoi
// ===========================================================================

function renderSendState() {
  const st = $('sendStatus');
  const n = form.photos.length;
  const ok = form.photos.filter((p) => p.state === 'ok').length;
  const err = form.photos.filter((p) => p.state === 'err').length;
  const prep = form.photos.filter((p) => p.state === 'prep').length;
  const up = form.photos.filter((p) => p.state === 'up').length;
  const bar = n ? `<span class="bar" aria-hidden="true"><i style="width:${Math.round((ok / n) * 100)}%"></i></span>` : '';
  let cls = '';
  let html;
  if (form.sendError) {
    cls = 'err';
    html = `${icon('alert', { size: 16 })}<span class="txt">${esc(form.sendError)}</span>`;
  } else if (form.committing) {
    html = `${ring(14)}<span class="txt">Création de l’annonce…</span>`;
  } else if (form.sending) {
    html = `${icon('upload', { size: 16 })}<span class="txt">Envoi des photos ${ok}/${n}…</span>${bar}`;
  } else if (!n) {
    html = `${icon('info', { size: 16 })}<span class="txt">Ajoute des photos, le prix et le compte.</span>`;
  } else if (prep) {
    html = `${ring(14)}<span class="txt">Préparation des photos ${n - prep}/${n}…</span>${bar}`;
  } else if (up) {
    html = `${icon('upload', { size: 16 })}<span class="txt">Envoi en arrière-plan ${ok}/${n}</span>${bar}`;
  } else if (err) {
    cls = 'err';
    html = `${icon('alert', { size: 16 })}<span class="txt">${plural(err, 'photo')} en échec : renvoi automatique à l’envoi</span>`;
  } else {
    cls = 'ok';
    html = `${icon('checkCircle', { size: 16 })}<span class="txt">${n > 1 ? `${n} photos prêtes` : 'Photo prête'}</span>`;
  }
  st.className = `action-status${cls ? ` ${cls}` : ''}`;
  st.innerHTML = html;
  const btn = $('sendBtn');
  btn.disabled = form.sending;
  btn.classList.toggle('is-busy', form.sending);
  btn.setAttribute('aria-busy', String(form.sending));
  btn.firstElementChild.innerHTML = form.sending ? ring(18) : icon('send', { size: 20 });
  $('sendLabel').textContent = form.sending ? (form.committing ? 'Création…' : 'Envoi…') : 'Envoyer au PC';
  $('photoGrid').classList.toggle('is-locked', form.sending);
}

function buildHints() {
  const hints = {
    rayon: form.rayon,
    brand: $('brand').value.trim(),
    size: $('size').value.trim(),
    condition: form.condition,
    notes: $('notes').value.trim(),
    labelIndexes: form.photos.map((p, i) => (p.isLabel ? i : -1)).filter((i) => i >= 0),
  };
  for (const k of Object.keys(hints)) if (hints[k] === '' || (Array.isArray(hints[k]) && !hints[k].length)) delete hints[k];
  return hints;
}

function sendFail(text) {
  form.sendError = text;
  renderSendState();
}

$('sendBtn').addEventListener('click', async () => {
  if (form.sending) return;
  form.sendError = '';
  const price = parsePrice($('price').value);
  if (!form.photos.length) return sendFail('Ajoute au moins une photo.');
  if (!price) {
    $('price').focus();
    return sendFail('Indique le prix.');
  }
  if (!form.account) return sendFail('Choisis le compte Vinted.');
  const account = form.account;
  form.sending = true;
  // Photos en échec : nouvel essai.
  for (const p of form.photos) {
    if (p.state === 'err') {
      p.state = 'up';
      p.error = '';
    }
  }
  photosChanged();
  try {
    await waitForPhotos();
    const failed = form.photos.filter((p) => p.state !== 'ok');
    if (failed.length) throw new Error(`${plural(failed.length, 'photo')} non envoyée${failed.length > 1 ? 's' : ''} (${failed[0].error || 'erreur inconnue'}). Vérifie le réseau puis réessaie.`);
    form.committing = true;
    renderSendState();
    const photos = form.photos.slice();
    const job = { account, price: String(price), hints: buildHints(), thumb: photos[0].thumb, createdBy: 'phone' };
    try {
      await relay.createJob({ ...job, photos: photos.map((p) => ({ sha: p.sha })) });
    } catch (err) {
      // Photo introuvable côté GitHub (envoyée il y a très longtemps ?) : on renvoie les photos elles-mêmes.
      if (err.status !== 422 || !photos.every((p) => p.base64)) throw err;
      form.committing = false;
      await relay.createJob({
        ...job,
        photos: photos.map((p) => ({ base64: p.base64 })),
        onProgress: (d, t) => {
          $('sendStatus').querySelector('.txt').textContent = `Envoi des photos ${d}/${t}…`;
        },
      });
    }
    form.sending = false;
    form.committing = false;
    toast(`Envoyée à @${account} : le PC s’en occupe.`, { kind: 'ok' });
    openNew({ reset: true }); // prêt pour l'article suivant (compte et rayon conservés)
    void refresh();
  } catch (err) {
    form.sendError = err.message;
  } finally {
    form.sending = false;
    form.committing = false;
    renderPhotos();
    renderSendState();
  }
});

// ===========================================================================
// Démarrage
// ===========================================================================

function start() {
  if (!cfg?.relay?.token) {
    show('setupView');
    return;
  }
  try {
    relay = new GitHubRelay(cfg.relay);
  } catch (err) {
    LS.del('cfg');
    show('setupView');
    callout($('setupStatus'), err.message, 'err');
    return;
  }
  renderHello();
  renderHome(); // squelettes en attendant la 1re lecture
  show('homeView');
  void refresh({ spin: true });
  startPolling();
}

hydrateIcons();
start();
