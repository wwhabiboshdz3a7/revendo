/**
 * Revendo — dashboard du PC (onglet plein écran de l'extension).
 * Barre latérale (navigation, état du robot, compte Vinted du profil) et cinq
 * pages : nouvelle annonce, file d'attente, comptes, réglages, journal.
 * Icônes : SVG inline de ./icons.js (aucun emoji d'interface).
 */
/* global qrcode */
import { decodeConnection, encodeConnection, phoneLink } from '../shared/config.js';
import { toJpeg, toJpegTarget } from '../shared/image.js';
import { buildDescription, buildTitle, detectSize, findCategoryDef, formatPriceFR, normalize, parsePrice } from '../shared/listing.js';
import { GitHubRelay, safeLogin } from '../shared/relay.js';
import { analyzeListing, optimizeTitle, SEO_TIPS } from '../shared/seo.js';
import { CATEGORY_DEFS, COLORS, CONDITIONS, MATERIALS, RAYONS } from '../shared/vinted-data.js';
import * as store from '../background/store.js';
import { hydrateIcons, icon } from './icons.js';

const MAX_PHOTOS = 20;
const PHOTO_TARGET = { maxSide: 1600, maxBytes: 400 * 1024 }; // même cible que le téléphone : envoi rapide, étiquettes encore lisibles
const TABS = ['annonce', 'file', 'comptes', 'reglages', 'journal'];
const STUCK_MS = 16 * 60 * 1000; // « en cours » sans nouvelles depuis 16 min (le PC date son statut à chaque page) : on propose de relancer

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const send = (type, payload = {}) => chrome.runtime.sendMessage({ type, ...payload });
const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;

let settings = await store.getSettings();
let account = await store.getAccount();

const state = {
  photos: [], // { id, name, dataUrl, bytes, isLabel }
  preparing: 0, // photos en cours de compression
  rayon: '',
  condition: settings.worker.defaultCondition || 'Très bon état',
  colors: [],
  relayAccounts: [],
  accountsLoaded: false,
  accountsError: '',
  touched: { title: false, category: false, brand: false, size: false },
  keywords: [], // mots-clés « boost référencement » validés par l'utilisateur
  recognition: null, // résultat de la dernière lecture des photos (ce qui a été trouvé, erreur de lecture…)
  recognized: null, // { categoryHints, brandCandidates } de cette lecture, pour le remplissage sur Vinted
  seo: null, // dernier score de référencement { score, grade }
  tab: 'annonce',
  queue: null, // éléments de la file (dernière lecture du relais)
  queueError: '',
  queueFilter: 'all',
  openRows: new Set(), // lignes de la file dont le détail est déplié
  robotLineAt: 0,
};

let relayMemo = { key: '', relay: null };
function relay() {
  if (!store.relayConfigured(settings)) return null;
  const key = JSON.stringify(settings.relay);
  if (relayMemo.key !== key) relayMemo = { key, relay: new GitHubRelay(settings.relay) };
  return relayMemo.relay;
}

// ===========================================================================
// Outils d'affichage
// ===========================================================================

const MSG_ICONS = { ok: 'checkCircle', err: 'alert', warn: 'alertTriangle', info: 'info', busy: 'loader' };

/** Message d'état sous un formulaire : icône + texte. kind : '' | ok | err | warn | info | busy. Vide = masqué. */
function setMsg(el, text, kind = '') {
  clearTimeout(el.flashTimer);
  el.classList.remove('ok', 'err', 'warn', 'info', 'busy');
  if (!text) {
    el.innerHTML = '';
    return;
  }
  if (kind) el.classList.add(kind);
  const ic = MSG_ICONS[kind];
  el.innerHTML = `${ic ? icon(ic, { size: 16, cls: kind === 'busy' ? 'spin' : '' }) : ''}<span>${esc(text)}</span>`;
}

/** Message de réussite qui s'efface tout seul. */
function flash(el, text) {
  setMsg(el, text, 'ok');
  el.flashTimer = setTimeout(() => setMsg(el, ''), 3500);
}

function toast(text, { kind = '', ms = 3000 } = {}) {
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

/** Exécute une action en montrant le bouton occupé (icône qui tourne, pas de double clic). */
async function withBusy(btn, fn) {
  if (btn.disabled) return undefined;
  const html = btn.innerHTML;
  btn.disabled = true;
  btn.classList.add('is-busy');
  const svg = btn.querySelector('svg');
  if (svg) svg.outerHTML = icon('loader', { size: Number(svg.getAttribute('width')) || 18, cls: 'spin' });
  try {
    return await fn();
  } finally {
    btn.innerHTML = html;
    btn.disabled = false;
    btn.classList.remove('is-busy');
  }
}

/** Bouton « à confirmer » : 1er clic = demande de confirmation (4 s), 2e clic = action. */
function arm(btn, label) {
  btn.dataset.original = btn.innerHTML;
  btn.dataset.armed = '1';
  btn.innerHTML = `${icon('alertTriangle', { size: 16 })}${esc(label)}`;
  clearTimeout(btn.armTimer);
  btn.armTimer = setTimeout(() => disarm(btn), 4000);
}
function disarm(btn) {
  clearTimeout(btn.armTimer);
  if (btn.dataset.armed !== '1') return;
  btn.innerHTML = btn.dataset.original;
  btn.dataset.armed = '';
}
function armButton(btn, label, action) {
  btn.addEventListener('click', () => {
    if (btn.dataset.armed !== '1') return arm(btn, label);
    disarm(btn);
    return withBusy(btn, action);
  });
}

function timeAgo(ts) {
  const s = Math.round((Date.now() - (typeof ts === 'number' ? ts : Date.parse(ts))) / 1000);
  if (!Number.isFinite(s)) return '';
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.round(s / 3600)} h`;
  return `il y a ${Math.round(s / 86400)} j`;
}

/** Date d'un identifiant de job (20261007-153012-ab12 → ISO). */
const idToIso = (id) => String(id).replace(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2}).*/, '$1-$2-$3T$4:$5:$6Z');
const priceText = (p) => (p && Number.isFinite(parseFloat(p)) ? formatPriceFR(parseFloat(p)) : '');

/** Teinte stable dérivée d'un identifiant (couleur des avatars). */
function hue(str) {
  let h = 0;
  for (const c of String(str || '')) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}
function avatarHtml(login, { cls = '', presence = '' } = {}) {
  const letter = esc((String(login || '?').replace(/^@/, '')[0] || '?').toUpperCase());
  return `<span class="avatar ${cls}" style="--h:${hue(login)}">${letter}${presence !== '' ? `<span class="presence ${presence}"></span>` : ''}</span>`;
}

/** État vide : icône + titre + phrase + action éventuelle. */
function emptyHtml(ic, title, text, action = '', cls = '') {
  return `<div class="empty ${cls}"><span class="empty-icon">${icon(ic, { size: 24 })}</span><h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ''}${action}</div>`;
}

// ===========================================================================
// Barre latérale, navigation
// ===========================================================================

function renderHeader() {
  const name = settings.profile.name || '';
  $('greeting').textContent = `${name ? `Bonjour ${name}. ` : ''}Photos et prix : Revendo reconnaît l'article et prépare le brouillon Vinted.`;
  const login = account?.login || '';
  const av = $('avatar');
  av.textContent = (login[0] || name[0] || 'R').toUpperCase();
  av.style.setProperty('--h', hue(login || name));
  $('accountName').textContent = login ? `@${login}` : 'Aucun compte Vinted';
  const line = $('accountLine');
  line.textContent = login ? (account.loggedOut ? 'Déconnecté de Vinted' : account.domain || 'www.vinted.fr') : 'Ouvre vinted.fr connecté';
  line.classList.toggle('err', !!(login && account.loggedOut));
}

const VERSION = chrome.runtime.getManifest().version;

/** a < b pour des versions « 3.4.0 » (absente = pas comparable). */
function versionLt(a, b) {
  if (!a || !b) return false;
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0);
  return false;
}

/** Ce profil attend qu'un autre profil Chrome ait fini (verrou du robot encore valable). */
function waitingOther(ws) {
  return !!ws.waitingFor?.holder && Date.parse(ws.waitingFor.until || 0) > Date.now();
}

async function renderRobotPill() {
  const ws = await store.getWorkerState();
  let view;
  if (!store.relayConfigured(settings)) view = ['off', 'Relais à configurer', 'Réglages → Relais GitHub'];
  else if (!settings.worker.enabled) view = ['off', 'Robot en pause', 'Réactivable dans les réglages'];
  else if (ws.current) view = ['busy', 'Remplissage en cours', ws.current.origin === 'manual' ? 'Annonce créée sur ce PC' : `Annonce ${ws.current.jobId}`];
  else if (ws.lastError) view = ['warn', 'Robot actif', `Erreur : ${ws.lastError}`];
  else if (waitingOther(ws)) view = ['busy', 'En attente de son tour', ws.waitingFor.jobId ? `@${ws.waitingFor.holder} remplit Vinted` : `tour réservé à @${ws.waitingFor.holder}`];
  else view = ['ok', 'Robot actif', ws.lastPollAt ? `Vérifié ${timeAgo(ws.lastPollAt)}` : 'En attente d’annonces'];
  const [cls, title, sub] = view;
  const pill = $('robotPill');
  pill.className = `robot robot-${cls}`;
  pill.title = `${title} · ${sub}`;
  pill.innerHTML = `<span class="robot-dot"></span><span class="robot-text"><b>${esc(title)}</b><small>${esc(sub)}</small></span>`;
  // Ligne d'état de la file (sauf si « Traiter maintenant » vient d'y écrire).
  if (Date.now() - state.robotLineAt > 15000) {
    if (ws.current) setMsg($('robotLine'), `Remplissage en cours : ${ws.current.origin === 'manual' ? 'annonce créée sur ce PC' : ws.current.jobId}`, 'busy');
    else if (ws.lastError) setMsg($('robotLine'), `Dernière erreur du robot : ${ws.lastError}`, 'warn');
    else if (waitingOther(ws) && settings.worker.enabled) setMsg($('robotLine'), `Un seul profil remplit Vinted à la fois : ${ws.waitingFor.jobId ? `@${ws.waitingFor.holder} est en cours` : `le tour est réservé à @${ws.waitingFor.holder}`}, ce profil prend la suite ensuite.`, 'busy');
    else setMsg($('robotLine'), '');
  }
}

function showTab(name) {
  state.tab = name;
  document.querySelectorAll('#tabs [data-tab]').forEach((b) => {
    const on = b.dataset.tab === name;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== name));
  history.replaceState(null, '', `#${name}`);
  window.scrollTo({ top: 0 });
  if (name === 'file') void renderQueue();
  if (name === 'comptes') void renderAccounts();
  if (name === 'journal') void renderLog();
}
document.querySelectorAll('#tabs [data-tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
// Boutons « aller à » des états vides.
document.addEventListener('click', (e) => {
  const g = e.target.closest?.('[data-goto]');
  if (g && TABS.includes(g.dataset.goto)) showTab(g.dataset.goto);
});

// ===========================================================================
// Nouvelle annonce
// ===========================================================================

function buildStaticControls() {
  $('categoryList').innerHTML = CATEGORY_DEFS.map((d) => `<option value="${esc(d.kw)}"></option>`).join('');
  const matOpts = ['<option value="">—</option>', ...MATERIALS.map((m) => `<option>${esc(m)}</option>`)].join('');
  $('material1').innerHTML = matOpts;
  $('material2').innerHTML = matOpts;
  $('wCondition').innerHTML = CONDITIONS.map((c) => `<option>${esc(c.name)}</option>`).join('');
  $('seoTips').innerHTML = SEO_TIPS.map((t) => `<li>${esc(t)}</li>`).join('');
}

function renderRayons() {
  $('rayonChips').innerHTML = ['', ...RAYONS.slice(0, 5)]
    .map((r) => `<button type="button" class="chip${state.rayon === r ? ' active' : ''}" role="radio" aria-checked="${state.rayon === r}" data-rayon="${esc(r)}">${esc(r || 'Auto')}</button>`)
    .join('');
}
$('rayonChips').addEventListener('click', (e) => {
  const b = e.target.closest('[data-rayon]');
  if (!b) return;
  state.rayon = b.dataset.rayon;
  renderRayons();
  renderSizeChips();
  scheduleDesc();
});

function renderConditions() {
  $('conditionGroup').innerHTML = CONDITIONS.map(
    (c) => `<button type="button" class="opt" role="radio" aria-checked="${state.condition === c.name}" data-cond="${esc(c.name)}"><b>${esc(c.name)}</b><span>${esc(c.desc)}</span></button>`,
  ).join('');
}
$('conditionGroup').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cond]');
  if (!b) return;
  state.condition = b.dataset.cond;
  renderConditions();
  scheduleDesc();
});

function renderColors() {
  $('colorSwatches').innerHTML = COLORS.map(
    (c) =>
      `<button type="button" class="swatch" aria-pressed="${state.colors.includes(c.name)}" data-color="${esc(c.name)}"><span class="dot" style="background:${esc(c.hex)}"></span><span class="name">${esc(c.name)}</span></button>`,
  ).join('');
}
$('colorSwatches').addEventListener('click', (e) => {
  const b = e.target.closest('[data-color]');
  if (!b) return;
  const name = b.dataset.color;
  state.colors = state.colors.includes(name) ? state.colors.filter((x) => x !== name) : [...state.colors, name].slice(-2);
  renderColors();
  scheduleDesc();
});

function renderSizeChips() {
  const def = findCategoryDef($('category').value || $('title').value);
  const sizes = def?.shoes
    ? ['36', '37', '38', '39', '40', '41', '42', '43', '44', '45']
    : state.rayon === 'Enfants'
      ? ['2 ans', '4 ans', '6 ans', '8 ans', '10 ans', '12 ans', '14 ans']
      : ['XS', 'S', 'M', 'L', 'XL', 'XXL'];
  const cur = normalize($('size').value);
  $('sizeChips').innerHTML = sizes.map((s) => `<button type="button" class="chip${cur === normalize(s) ? ' active' : ''}" data-size="${esc(s)}">${esc(s)}</button>`).join('');
}
$('sizeChips').addEventListener('click', (e) => {
  const b = e.target.closest('[data-size]');
  if (!b) return;
  $('size').value = b.dataset.size;
  state.touched.size = true;
  renderSizeChips();
  scheduleDesc();
});

async function renderTargets() {
  const sel = $('target');
  const prev = sel.value;
  const opts = [`<option value="__self">${account?.login ? `Ce profil — @${esc(account.login)}` : 'Ce profil (compte non détecté)'}</option>`];
  for (const a of state.relayAccounts) {
    if (account?.login && safeLogin(a.login) === safeLogin(account.login)) continue;
    opts.push(`<option value="${esc(a.login)}">@${esc(a.login)} — autre profil, via le relais</option>`);
  }
  sel.innerHTML = opts.join('');
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  const self = sel.value === '__self';
  $('targetHint').textContent = self ? 'Le brouillon est créé tout de suite dans ce profil.' : 'Envoyé au profil Chrome de ce compte, qui créera le brouillon (il doit être ouvert sur le PC).';
  $('createLabel').textContent = self ? 'Créer le brouillon' : `Envoyer à @${sel.value}`;
  renderRecap();
}
$('target').addEventListener('change', renderTargets);

// ---------- Photos ----------

async function addFiles(fileList) {
  const files = [...(fileList || [])].filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif|avif)$/i.test(f.name));
  if (!files.length) return;
  const room = MAX_PHOTOS - state.photos.length - state.preparing;
  if (room <= 0) {
    toast(`${MAX_PHOTOS} photos maximum.`, { kind: 'err' });
    return;
  }
  const batch = files.slice(0, room);
  if (files.length > room) toast(`${MAX_PHOTOS} photos maximum : ${plural(files.length - room, 'photo')} ignorée${files.length - room > 1 ? 's' : ''}.`);
  state.preparing += batch.length;
  renderPhotos();
  let failed = 0;
  for (const f of batch) {
    try {
      // Compression par poids cible (~400 Ko) : une photo iPhone de 900 Ko n'alourdit plus le relais ni Vinted.
      const jpg = await toJpegTarget(f, PHOTO_TARGET);
      state.photos.push({ id: crypto.randomUUID(), name: f.name, dataUrl: jpg.dataUrl, bytes: jpg.bytes, isLabel: false });
    } catch (_err) {
      failed += 1;
    } finally {
      state.preparing -= 1;
      renderPhotos();
    }
  }
  if (failed) toast(`${plural(failed, 'photo')} illisible${failed > 1 ? 's' : ''} (format non pris en charge ?).`, { kind: 'err', ms: 4500 });
  scheduleSeo();
}

function renderPhotos() {
  const tiles = state.photos.map((p, i) => {
    const n = i + 1;
    return `<div class="photo-tile${i === 0 ? ' is-cover' : ''}" data-id="${p.id}" title="Double-clic : mettre en couverture">
      <img src="${p.dataUrl}" alt="Photo ${n}${p.isLabel ? ' (étiquette)' : ''}" draggable="false">
      ${i === 0 ? '<span class="tile-cover">Couverture</span>' : `<button type="button" class="tile-btn tile-star" data-act="cover" aria-label="Mettre la photo ${n} en couverture">${icon('star', { size: 15 })}</button>`}
      <button type="button" class="tile-btn tile-remove" data-act="remove" aria-label="Retirer la photo ${n}">${icon('x', { size: 15 })}</button>
      <button type="button" class="tile-label" data-act="label" aria-pressed="${p.isLabel}" title="Photo d'étiquette : lue en priorité pour la marque et la taille">${icon(p.isLabel ? 'check' : 'scanText', { size: 14 })}Étiquette</button>
    </div>`;
  });
  for (let i = 0; i < state.preparing; i += 1) tiles.push('<div class="photo-tile sk-tile" aria-hidden="true"><span class="sk sk-fill"></span></div>');
  $('photoGrid').innerHTML = tiles.join('');
  const n = state.photos.length;
  $('photoCount').textContent = n ? `${n}/${MAX_PHOTOS}` : '';
  $('dropzone').classList.toggle('compact', n + state.preparing > 0);
  renderRecap();
}

$('photoGrid').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  const tile = e.target.closest('.photo-tile[data-id]');
  if (!b || !tile) return;
  const p = state.photos.find((x) => x.id === tile.dataset.id);
  if (!p) return;
  const act = b.dataset.act;
  if (act === 'remove') state.photos = state.photos.filter((x) => x !== p);
  else if (act === 'cover') state.photos = [p, ...state.photos.filter((x) => x !== p)];
  else if (act === 'label') p.isLabel = !p.isLabel;
  renderPhotos();
  // Garde le focus clavier sur le bouton utilisé.
  if (act === 'label') $('photoGrid').querySelector(`[data-id="${p.id}"] [data-act="label"]`)?.focus();
  scheduleSeo();
});
$('photoGrid').addEventListener('dblclick', (e) => {
  const tile = e.target.closest('.photo-tile[data-id]');
  if (!tile || e.target.closest('[data-act]')) return;
  const p = state.photos.find((x) => x.id === tile.dataset.id);
  if (!p) return;
  state.photos = [p, ...state.photos.filter((x) => x !== p)];
  renderPhotos();
});

$('photoInput').addEventListener('change', async (e) => {
  const files = [...(e.target.files || [])];
  e.target.value = '';
  await addFiles(files);
});
// Glisser-déposer sur toute la carte « Photos ».
const photoCard = $('dropzone').closest('.card');
['dragenter', 'dragover'].forEach((t) =>
  photoCard.addEventListener(t, (e) => {
    e.preventDefault();
    $('dropzone').classList.add('over');
  }),
);
['dragleave', 'drop'].forEach((t) =>
  photoCard.addEventListener(t, (e) => {
    e.preventDefault();
    if (t === 'dragleave' && photoCard.contains(e.relatedTarget)) return;
    $('dropzone').classList.remove('over');
  }),
);
photoCard.addEventListener('drop', (e) => addFiles(e.dataTransfer?.files));
// Coller une image (Ctrl+V) sur la page « Nouvelle annonce ».
document.addEventListener('paste', (e) => {
  if (state.tab !== 'annonce' || e.target.closest?.('input, textarea')) return;
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) addFiles(files);
});

// ---------- Champs ----------

function materials() {
  return [$('material1').value, $('material2').value].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
}

function currentFields() {
  return {
    title: $('title').value.trim(),
    rayon: state.rayon,
    category: $('category').value.trim(),
    brand: $('brand').value.trim(),
    size: $('size').value.trim(),
    colors: state.colors.slice(0, 2),
    materials: materials(),
    condition: state.condition,
    package: $('parcel').value,
    price: $('price').value.trim(),
    keywords: state.keywords.slice(),
  };
}

function regenerate() {
  const f = currentFields();
  // Titre optimisé automatiquement tant que l'utilisateur ne l'a pas écrit lui-même.
  if (!state.touched.title && f.category) {
    const opt = optimizeTitle(f.title, f);
    if (opt && opt !== f.title) {
      $('title').value = opt;
      f.title = opt;
    }
  }
  const title = f.title || (f.category ? buildTitle(f) : '');
  $('description').value = buildDescription({ ...f, title }, { hashtags: settings.profile.hashtags, signature: settings.profile.signature });
  renderDescCount();
  renderSeo();
}
function renderDescCount() {
  const n = $('description').value.length;
  $('descCount').textContent = `${n.toLocaleString('fr-FR')} caractère${n > 1 ? 's' : ''}`;
}
let descTimer;
function scheduleDesc() {
  if (!$('autoDesc').checked) return;
  clearTimeout(descTimer);
  descTimer = setTimeout(regenerate, 300);
}

['title', 'category', 'brand', 'size'].forEach((id) =>
  $(id).addEventListener('input', () => {
    state.touched[id] = true;
    if (id === 'category' || id === 'size') renderSizeChips();
    scheduleDesc();
  }),
);
['material1', 'material2', 'parcel'].forEach((id) => $(id).addEventListener('change', scheduleDesc));
$('description').addEventListener('input', () => {
  $('autoDesc').checked = false;
  renderDescCount();
});
$('autoDesc').addEventListener('change', () => $('autoDesc').checked && regenerate());
$('regenBtn').addEventListener('click', () => {
  $('autoDesc').checked = true;
  regenerate();
});
$('price').addEventListener('input', () => {
  const raw = $('price').value.trim();
  const n = parsePrice(raw);
  setMsg($('priceCheck'), !raw ? '' : n ? `Sera saisi : ${formatPriceFR(n)}` : 'Prix invalide', n ? '' : 'err');
  scheduleDesc();
});
$('title').addEventListener('input', () => {
  if (!state.touched.size) {
    const s = detectSize($('title').value);
    if (s) $('size').value = s;
  }
});

// ---------- Récapitulatif ----------

function renderRecap() {
  const price = parsePrice($('price').value);
  const target = $('target').value || '__self';
  const self = target === '__self';
  const labels = state.photos.filter((p) => p.isLabel).length;
  const n = state.photos.length;
  const cat = $('category').value.trim();
  const rows = [
    ['Photos', n ? `${n}${labels ? ` · ${plural(labels, 'étiquette')}` : ''}` : state.preparing ? 'Préparation…' : 'Aucune', n ? '' : 'warn'],
    ['Prix', price ? formatPriceFR(price) : 'À indiquer', price ? '' : 'warn'],
    ['Compte', self ? (account?.login ? `@${account.login} · ce profil` : 'Ce profil') : `@${target} · via le relais`, ''],
    ['Catégorie', cat || 'Recommandée par Vinted', cat ? '' : 'empty'],
    ['Marque', $('brand').value.trim() || '—', $('brand').value.trim() ? '' : 'empty'],
    ['Taille', $('size').value.trim() || '—', $('size').value.trim() ? '' : 'empty'],
  ];
  const seo = state.seo;
  const seoRow = seo
    ? `<div class="recap-row"><dt>Référencement</dt><dd><button type="button" class="recap-link" id="recapSeoBtn" title="Voir les conseils de référencement"><span class="mini-bar"><i class="${seoClass(seo.score)}" style="width:${seo.score}%"></i></span>${seo.score}/100</button></dd></div>`
    : '';
  $('recap').innerHTML = rows.map(([k, v, cls]) => `<div class="recap-row"><dt>${esc(k)}</dt><dd class="${cls ? `${cls}-val` : ''}" title="${esc(v)}">${esc(v)}</dd></div>`).join('') + seoRow;
}
$('recap').addEventListener('click', (e) => {
  if (!e.target.closest('#recapSeoBtn')) return;
  $('seoCard').scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
});

/** Couleur de la jauge de référencement. */
function seoClass(score) {
  return score >= 80 ? 'good' : score >= 55 ? 'mid' : '';
}

// ===========================================================================
// Boost référencement (calcul local, aucune API)
// ===========================================================================

function renderSeo() {
  const f = currentFields();
  const a = analyzeListing({ ...f, description: $('description').value }, { photoCount: state.photos.length });
  state.seo = { score: a.score, grade: a.grade };
  $('seoScore').textContent = a.score;
  const bar = $('seoBar');
  bar.style.width = `${a.score}%`;
  bar.className = seoClass(a.score);
  $('seoGrade').textContent = `${a.grade} · calculé sur la fiche envoyée à Vinted`;
  $('seoTodo').innerHTML = a.todo.length
    ? a.todo
        .slice(0, 5)
        .map((c) => `<li><b>+${c.weight - c.earned}</b><span>${esc(c.tip)}</span></li>`)
        .join('')
    : `<li class="done">${icon('checkCircle', { size: 16 })}<span>Fiche complète : rien d’important à ajouter.</span></li>`;
  const suggested = a.optimizedTitle && a.optimizedTitle !== f.title ? a.optimizedTitle : '';
  $('seoTitleBox').classList.toggle('hidden', !suggested);
  $('seoTitle').textContent = suggested;
  const chips = [...new Set([...state.keywords, ...a.keywords, ...a.synonyms])].slice(0, 12);
  $('seoKwBox').classList.toggle('hidden', !chips.length);
  $('seoKeywords').innerHTML = chips
    .map((k) => {
      const on = state.keywords.includes(k);
      return `<button type="button" class="chip${on ? ' active' : ''}" aria-pressed="${on}" data-kw="${esc(k)}">${icon(on ? 'check' : 'plus', { size: 14 })}${esc(k)}</button>`;
    })
    .join('');
  renderRecap();
}

$('seoKeywords').addEventListener('click', (e) => {
  const b = e.target.closest('[data-kw]');
  if (!b) return;
  const k = b.dataset.kw;
  state.keywords = state.keywords.includes(k) ? state.keywords.filter((x) => x !== k) : [...state.keywords, k];
  if ($('autoDesc').checked) regenerate();
  else {
    $('description').value += `${$('description').value.endsWith('\n') ? '' : '\n'}✔️ ${k}`;
    renderDescCount();
    renderSeo();
  }
});
$('applyTitleBtn').addEventListener('click', () => {
  $('title').value = $('seoTitle').textContent;
  state.touched.title = true;
  scheduleDesc();
  renderSeo();
});
let seoTimer;
function scheduleSeo() {
  clearTimeout(seoTimer);
  seoTimer = setTimeout(renderSeo, 250);
}
const panelAnnonce = document.querySelector('[data-panel="annonce"]');
['input', 'change', 'click'].forEach((ev) =>
  panelAnnonce.addEventListener(ev, (e) => {
    if (e.target.closest?.('#seoCard')) return;
    scheduleSeo();
  }),
);

// ---------- Reconnaissance ----------

function applyFields(f) {
  if (f.title) $('title').value = f.title;
  if (f.category) $('category').value = f.category;
  if (f.brand) $('brand').value = f.brand;
  if (f.size) $('size').value = f.size;
  if (f.rayon) state.rayon = f.rayon;
  if (f.condition) state.condition = f.condition;
  if (f.colors?.length) state.colors = f.colors.slice(0, 2);
  $('material1').value = f.materials?.[0] || '';
  $('material2').value = f.materials?.[1] || '';
  if (f.package) $('parcel').value = f.package;
  state.recognized = { categoryHints: f.categoryHints || null, brandCandidates: f.brandCandidates || [] };
  renderRayons();
  renderConditions();
  renderColors();
  renderSizeChips();
  $('autoDesc').checked = true;
  regenerate();
}

/** Phrase de résultat : ce qui a été lu sur les étiquettes, et ce qui sera choisi sur Vinted. */
function recognitionSummary(r = {}, f = {}) {
  const found = [f.brand && `marque ${f.brand}`, f.size && `taille ${f.size}`, f.colors?.length && f.colors.join('/'), f.materials?.length && f.materials.join(', ')]
    .filter(Boolean)
    .join(' · ');
  const tail = f.category ? '' : ' Catégorie : choisie parmi les propositions de Vinted.';
  const tries = !f.brand && f.brandCandidates?.length ? ` Marque à vérifier sur Vinted : ${f.brandCandidates.join(', ')}.` : '';
  if (r.ocr?.error) return { text: `Lecture des étiquettes impossible (${r.ocr.error}). ${found ? `Trouvé : ${found}.` : ''}${tail}`, kind: 'warn' };
  if (!found) return { text: `Rien de lisible sur les étiquettes : photographie l’étiquette de près.${tries}${tail}`, kind: 'warn' };
  return { text: `Lu sur les photos : ${found}.${tries}${tail}`, kind: 'ok' };
}

let analyzing = null; // analyse en cours : « Créer » attend son résultat au lieu de partir sans
async function analyze() {
  if (analyzing) return analyzing;
  const status = $('analyzeStatus');
  if (!state.photos.length) {
    setMsg(status, 'Ajoute d’abord des photos.', 'err');
    return null;
  }
  setMsg(status, 'Lecture des étiquettes et des couleurs… (jusqu’à une minute)', 'busy');
  analyzing = withBusy($('analyzeBtn'), async () => {
    try {
      const hints = {
        rayon: state.rayon,
        price: $('price').value.trim(),
        labelIndexes: state.photos.map((p, i) => (p.isLabel ? i : -1)).filter((i) => i >= 0),
        // Ce que l'utilisateur a déjà saisi lui-même prime sur la reconnaissance.
        ...(state.touched.brand && $('brand').value.trim() ? { brand: $('brand').value.trim() } : {}),
        ...(state.touched.size && $('size').value.trim() ? { size: $('size').value.trim() } : {}),
      };
      // Toutes les photos : les étiquettes marquées sont lues d'abord.
      const res = await send('RV_ANALYZE', { photos: state.photos.map((p) => p.dataUrl), hints });
      if (!res?.ok) throw new Error(res?.error || 'analyse impossible');
      applyFields(res.fields);
      state.recognition = res.recognition || null;
      const { text, kind } = recognitionSummary(res.recognition || {}, res.fields || {});
      setMsg(status, text, kind);
      return res.fields;
    } catch (err) {
      setMsg(status, `Erreur : ${err.message}`, 'err');
      return null;
    }
  }).finally(() => {
    analyzing = null;
  });
  return analyzing;
}
$('analyzeBtn').addEventListener('click', analyze);

// ---------- Création ----------

async function createDraft() {
  const status = $('createStatus');
  const price = parsePrice($('price').value);
  if (!state.photos.length) return setMsg(status, 'Ajoute au moins une photo.', 'err');
  if (state.preparing) return setMsg(status, 'Patiente : photos en cours de préparation.', 'err');
  if (!price) {
    setMsg(status, 'Indique un prix valide.', 'err');
    $('price').focus();
    return undefined;
  }
  try {
    if (analyzing) await analyzing; // « Reconnaître » en cours : on attend la fiche reconnue
    else if (!$('title').value.trim() && !$('category').value.trim()) await analyze();
    if ($('autoDesc').checked) regenerate();
    const f = currentFields();
    const target = $('target').value;
    if (target === '__self') {
      const listing = {
        ...f,
        title: f.title || (f.category ? buildTitle(f) : ''),
        description: $('description').value,
        price: String(price),
        autoSave: $('autoSave').checked,
        // Sans lecture lancée (fiche saisie à la main) : rien n'a été reconnu.
        recognition: state.recognition || { mode: 'manual', found: {}, ocr: { photos: 0, error: '' } },
        ...(state.recognized?.categoryHints && !f.category ? { categoryHints: state.recognized.categoryHints } : {}),
        ...(state.recognized?.brandCandidates?.length && !f.brand ? { brandCandidates: state.recognized.brandCandidates } : {}),
      };
      setMsg(status, 'Ouverture de Vinted…', 'busy');
      const res = await send('RV_RUN_MANUAL', { listing, photos: state.photos.map((p) => p.dataUrl) });
      if (!res?.ok) throw new Error(res?.error || 'échec');
      setMsg(status, 'Fenêtre Vinted ouverte : le brouillon se remplit (bandeau en haut à droite).', 'ok');
    } else {
      const r = relay();
      if (!r) throw new Error('Configure le relais GitHub (Réglages).');
      setMsg(status, 'Envoi des photos au relais…', 'busy');
      const thumb = (await toJpeg(state.photos[0].dataUrl, { maxSide: 160, quality: 0.7 })).dataUrl;
      const hints = {
        ...f,
        description: $('autoDesc').checked ? '' : $('description').value,
        labelIndexes: state.photos.map((p, i) => (p.isLabel ? i : -1)).filter((i) => i >= 0),
      };
      const { id } = await r.createJob({
        account: target,
        price: String(price),
        hints,
        photos: state.photos.map((p) => ({ base64: p.dataUrl.split(',')[1] })),
        thumb,
        createdBy: 'pc',
        onProgress: (d, t) => setMsg(status, `Envoi des photos ${d}/${t}…`, 'busy'),
      });
      resetForm({ keepChoices: true });
      setMsg(status, `Envoyé à @${target} (${id}) : son profil Chrome va créer le brouillon.`, 'ok');
      toast(`Annonce envoyée à @${target}.`, { kind: 'ok' });
      void refreshQueueCount();
    }
  } catch (err) {
    setMsg(status, `Erreur : ${err.message}`, 'err');
  }
  return undefined;
}
$('createBtn').addEventListener('click', async () => {
  await withBusy($('createBtn'), createDraft);
  // withBusy remet le libellé d'avant l'envoi : on le recale sur le compte choisi entre-temps.
  void renderTargets();
});

/** Vide le formulaire. keepChoices : garde rayon et état (annonces en série). */
function resetForm({ keepChoices = false } = {}) {
  state.photos = [];
  state.colors = [];
  state.recognized = null;
  state.keywords = [];
  state.recognition = null;
  state.touched = { title: false, category: false, brand: false, size: false };
  if (!keepChoices) {
    state.rayon = '';
    state.condition = settings.worker.defaultCondition || 'Très bon état';
    setMsg($('createStatus'), '');
  }
  ['title', 'category', 'brand', 'size', 'price'].forEach((id) => ($(id).value = ''));
  $('material1').value = '';
  $('material2').value = '';
  $('parcel').value = '';
  $('autoDesc').checked = true;
  setMsg($('priceCheck'), '');
  setMsg($('analyzeStatus'), '');
  renderPhotos();
  renderRayons();
  renderConditions();
  renderColors();
  renderSizeChips();
  regenerate();
}
armButton($('resetBtn'), 'Confirmer', async () => resetForm());

// ===========================================================================
// File d'attente
// ===========================================================================

/** Jobs + statuts du relais → éléments affichés (du plus récent au plus ancien). */
function queueItems(st) {
  const items = [];
  for (const j of st.jobs) {
    const s = st.statuses.get(j.id);
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
  for (const [id, s] of st.statuses) {
    if (!st.jobs.some((j) => j.id === id)) items.push({ id, account: s.account, thumb: s.thumb, price: s.summary?.price, state: s.state, status: s, hasFiles: false, hints: {}, photoCount: 0 });
  }
  return items.sort((a, b) => b.id.localeCompare(a.id));
}

const isOpen = (i) => i.state === 'pending' || i.state === 'processing' || i.state === 'retry';
const FILTERS = { all: () => true, open: isOpen, done: (i) => i.state === 'done', error: (i) => i.state === 'error' };

function updateQueueCount(n) {
  $('queueCount').textContent = n ? String(n) : '';
  $('queueCount').title = n ? `${plural(n, 'annonce')} en cours` : '';
}

/** Pastille de statut. « À compléter » : brouillon créé mais des champs restent vides. */
function statusView(i) {
  if (i.state === 'pending') return { cls: 'pending', label: 'En attente' };
  if (i.state === 'processing') return { cls: 'processing', label: 'En cours' };
  if (i.state === 'retry') return { cls: 'pending', label: 'Nouvel essai prévu' };
  if (i.state === 'error') return { cls: 'error', label: 'Échec' };
  if (i.state === 'done') {
    const missing = (i.status?.fields || []).some((f) => f && f.ok === false);
    return missing ? { cls: 'partial', label: 'À compléter' } : { cls: 'done', label: 'Brouillon créé' };
  }
  return { cls: '', label: i.state || '?' };
}

/** Heure prévue du nouvel essai automatique (« 17:42 »), '' si inconnue. */
function retryClock(status) {
  const t = Date.parse(status?.retryAt || '');
  return Number.isFinite(t) ? new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '';
}

function itemTitle(i) {
  const t = i.status?.summary?.title;
  if (t) return { text: t, fallback: false };
  if (i.state === 'processing') return { text: 'Reconnaissance et remplissage…', fallback: true };
  if (i.hints?.title) return { text: i.hints.title, fallback: true };
  if (i.hints?.brand) return { text: `Article ${i.hints.brand}`, fallback: true };
  if (i.state === 'pending') return { text: 'Annonce à traiter', fallback: true };
  return { text: 'Annonce sans titre', fallback: true };
}

/** Reconnaissance : ce qui a été lu sur les étiquettes (statuts récents uniquement). */
function recognitionView(sum) {
  if (sum.mode !== 'auto') return null;
  if (sum.ocrError) return { cls: 'warn', ic: 'alertTriangle', text: `Étiquettes illisibles : ${sum.ocrError}` };
  const f = sum.found || {};
  const parts = [f.brand === 'étiquette' && 'marque lue', f.brand === 'vinted' && 'marque vérifiée sur Vinted', f.size === 'étiquette' && 'taille lue', f.condition === 'étiquette' && 'ticket lu']
    .filter(Boolean)
    .join(' · ');
  return { cls: '', ic: 'scanText', text: parts ? `Étiquette : ${parts}` : 'Étiquette : rien de lisible' };
}

/** Photos visibles / envoyées (summary.photos, sinon ligne « Photos » du remplissage). */
function photosView(i) {
  const sp = i.status?.summary?.photos;
  if (sp && Number(sp.sent) > 0) {
    const sent = Number(sp.sent);
    const shown = Number.isFinite(Number(sp.shown)) && sp.shown !== null && sp.shown !== '' ? Number(sp.shown) : null;
    return { text: shown === null ? plural(sent, 'photo') : `Photos ${shown}/${sent} visibles`, ok: shown === null ? null : shown >= sent };
  }
  const f = (i.status?.fields || []).find((x) => /^photos?$/i.test(String(x?.label || '').trim()));
  const m = f && /(\d+)\s*\/\s*(\d+)/.exec(f.detail || '');
  if (m) return { text: `Photos ${m[1]}/${m[2]} visibles`, ok: Number(m[1]) >= Number(m[2]) };
  if (i.photoCount) return { text: plural(i.photoCount, 'photo'), ok: null };
  return null;
}

function rowHtml(i) {
  const s = i.status;
  const sum = s?.summary || {};
  const st = statusView(i);
  const title = itemTitle(i);
  const reco = recognitionView(sum);
  const ph = photosView(i);
  const stuck = i.state === 'processing' && Date.now() - Date.parse(s?.updatedAt || 0) > STUCK_MS;
  const open = state.openRows.has(i.id);
  const meta = [`@${i.account}`, priceText(i.price), timeAgo(s?.updatedAt || idToIso(i.id))].filter(Boolean).join(' · ');
  const seo = Number.isFinite(sum.seo) ? Math.max(0, Math.min(100, sum.seo)) : null;
  const tags = [
    reco && `<span class="tag ${reco.cls}" title="${esc(reco.text)}">${icon(reco.ic, { size: 14 })}<span>${esc(reco.text)}</span></span>`,
    ph && `<span class="tag ${ph.ok === false ? 'warn' : ''}">${icon(ph.ok === false ? 'alertTriangle' : 'image', { size: 14 })}<span>${esc(ph.text)}</span></span>`,
    seo !== null && `<span class="tag">${icon('trendingUp', { size: 14 })}<span>Référencement ${seo}/100</span></span>`,
  ]
    .filter(Boolean)
    .join('');

  const msgKind = i.state === 'error' ? 'err' : st.cls === 'partial' || i.state === 'retry' ? 'warn' : i.state === 'done' ? 'ok' : '';
  let msg = s?.message || '';
  if (!msg && i.state === 'pending') msg = 'En attente : le profil Chrome de ce compte doit être ouvert sur le PC.';
  if (i.state === 'retry') {
    const late = Date.now() - Date.parse(s?.retryAt || 0) > 2 * 60 * 1000;
    msg = late
      ? `Nouvel essai en retard : le profil Chrome de @${i.account} doit être ouvert sur le PC. Cause du 1er échec : ${s?.lastError || 'inconnue'}`
      : `Nouvel essai automatique${retryClock(s) ? ` vers ${retryClock(s)}` : ''} (rien à faire). Cause : ${s?.lastError || s?.message || 'inconnue'}`;
  }
  if (stuck) msg = `${msg ? `${msg} ` : ''}Aucune nouvelle depuis plus de 10 minutes : tu peux relancer.`;
  const msgIc = msgKind === 'ok' ? 'checkCircle' : msgKind === 'err' ? 'alert' : msgKind === 'warn' ? 'alertTriangle' : i.state === 'pending' ? 'clock' : 'info';

  // Détail dépliable : fiche reconnue + résultat champ par champ.
  const hints = i.hints || {};
  const kv = [
    ['Catégorie', sum.category],
    ['Marque', sum.brand],
    ['Taille', sum.size],
    ['Couleur', (sum.colors || []).join(' / ')],
    ['État', sum.condition],
    ['Prix', priceText(i.price)],
    ...(!s ? [['Rayon', hints.rayon], ['Marque', hints.brand], ['Taille', hints.size], ['Note', hints.notes]] : []),
  ].filter(([, v]) => v);
  const fields = (s?.fields || []).filter((f) => f && f.label);
  const hasDetail = kv.length || fields.length;
  const detail = hasDetail
    ? `<div class="qrow-detail" id="d-${esc(i.id)}">
        <div><p class="detail-title">${s ? 'Fiche' : 'Indications envoyées'}</p><dl class="kv">${kv.map(([k, v]) => `<div class="kv-row"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('') || '<div class="kv-row"><dd>—</dd></div>'}</dl></div>
        ${fields.length ? `<div><p class="detail-title">Remplissage</p><ul class="checklist">${fields.map((f) => `<li class="${f.ok ? 'ok' : 'ko'}">${icon(f.ok ? 'checkCircle' : 'xCircle', { size: 16, label: f.ok ? 'rempli' : 'à compléter' })}<span class="ck-text"><b>${esc(f.label)}</b>${f.detail ? `<span>${esc(f.detail)}</span>` : ''}</span></li>`).join('')}</ul></div>` : ''}
        <p class="detail-foot">${esc(i.id)}${s?.worker?.ext ? ` · extension ${esc(s.worker.ext)}` : ''}</p>
      </div>`
    : '';

  const canRetry = (i.state === 'error' || i.state === 'retry' || stuck) && i.hasFiles;
  return `<article class="qrow${open ? ' is-open' : ''}" data-id="${esc(i.id)}">
    <div class="qrow-main">
      <span class="thumb">${i.thumb ? `<img src="${esc(i.thumb)}" alt="" loading="lazy" decoding="async">` : icon('image', { size: 22 })}</span>
      <div class="qrow-body">
        <div class="qrow-top"><h3 class="qrow-title${title.fallback ? ' muted' : ''}" title="${esc(title.text)}">${esc(title.text)}</h3><span class="pill pill-${st.cls}">${esc(st.label)}</span></div>
        <p class="qrow-meta">${esc(meta)}</p>
        <div class="qrow-tags">${tags}</div>
        ${msg ? `<p class="qrow-msg ${msgKind}">${icon(msgIc, { size: 15 })}<span>${esc(msg)}</span></p>` : ''}
      </div>
      <div class="qrow-actions">
        ${canRetry ? `<button type="button" class="btn btn-secondary btn-sm" data-act="retry">${icon('retry', { size: 16 })}Réessayer</button>` : ''}
        <button type="button" class="btn btn-danger-ghost btn-sm" data-act="del">${icon('trash', { size: 16 })}${i.state === 'done' ? 'Retirer' : 'Supprimer'}</button>
        ${hasDetail ? `<button type="button" class="btn-icon btn-icon-ghost qrow-toggle" data-act="toggle" aria-expanded="${open}" aria-controls="d-${esc(i.id)}" aria-label="Détails de l'annonce">${icon('chevronDown', { size: 18 })}</button>` : ''}
      </div>
    </div>
    ${detail}
  </article>`;
}

function skeletonRows(n) {
  return Array.from(
    { length: n },
    () =>
      '<div class="qrow sk-row" aria-hidden="true"><div class="qrow-main"><span class="sk" style="width:56px;height:72px;border-radius:10px"></span><div class="qrow-body"><span class="sk sk-line" style="width:55%"></span><span class="sk sk-line" style="width:30%;height:10px"></span><span class="sk sk-line" style="width:40%;height:10px"></span></div><span></span></div></div>',
  ).join('');
}

let queueHtml = '';
function setQueueHtml(html) {
  if (html === queueHtml) return; // évite de reconstruire (et de perdre le focus) si rien n'a changé
  queueHtml = html;
  $('queueList').innerHTML = html;
}

function drawQueue() {
  if (state.queueError && !state.queue) {
    setQueueHtml(emptyHtml('alert', 'Lecture du relais impossible', state.queueError, `<button type="button" class="btn btn-secondary" data-act="reload">${icon('refresh', { size: 16 })}Réessayer</button>`));
    return;
  }
  const items = state.queue || [];
  const counts = Object.fromEntries(Object.entries(FILTERS).map(([k, fn]) => [k, items.filter(fn).length]));
  document.querySelectorAll('#queueFilter [data-filter]').forEach((b) => {
    b.setAttribute('aria-checked', String(b.dataset.filter === state.queueFilter));
    b.querySelector('.seg-count').textContent = counts[b.dataset.filter] ? String(counts[b.dataset.filter]) : '';
  });
  updateQueueCount(counts.open);
  const shown = items.filter(FILTERS[state.queueFilter] || FILTERS.all).slice(0, 60);
  if (!items.length) {
    setQueueHtml(
      emptyHtml('inbox', 'Aucune annonce pour l’instant', 'Envoie-en une depuis le téléphone, ou crée-la ici : elle apparaîtra dans cette liste.', `<button type="button" class="btn btn-secondary" data-goto="annonce">${icon('plus', { size: 16 })}Nouvelle annonce</button>`),
    );
  } else if (!shown.length) {
    setQueueHtml(emptyHtml('check', 'Rien dans ce filtre', '', '', 'empty-sm'));
  } else {
    setQueueHtml(shown.map(rowHtml).join(''));
  }
  if (state.queueError) {
    state.robotLineAt = Date.now();
    setMsg($('robotLine'), `Relais : ${state.queueError}`, 'err');
  }
}

let queueLoad = null; // lecture du relais en cours (partagée entre les appels)
let queueStale = false; // appel reçu pendant cette lecture : relire une fois de plus
async function renderQueue() {
  const r = relay();
  if (!r) {
    state.queue = null;
    updateQueueCount(0);
    setQueueHtml(emptyHtml('gitBranch', 'Relais non configuré', 'Configure le relais GitHub pour recevoir les annonces du téléphone.', `<button type="button" class="btn btn-secondary" data-goto="reglages">${icon('settings', { size: 16 })}Ouvrir les réglages</button>`));
    return undefined;
  }
  if (!state.queue && !state.queueError) setQueueHtml(skeletonRows(3));
  // Une lecture partie avant une écriture (Réessayer, Supprimer…) renverrait l'ancien
  // état : on relit juste après elle, et l'appelant attend la version à jour.
  if (queueLoad) {
    queueStale = true;
    return queueLoad;
  }
  queueLoad = (async () => {
    try {
      do {
        queueStale = false;
        try {
          state.queue = queueItems(await r.state());
          state.queueError = '';
        } catch (err) {
          state.queueError = err.message;
        }
      } while (queueStale);
    } finally {
      queueLoad = null;
    }
    drawQueue();
  })();
  return queueLoad;
}

/** Met à jour le compteur de la barre latérale sans afficher la file. */
async function refreshQueueCount() {
  const r = relay();
  if (!r) return updateQueueCount(0);
  try {
    updateQueueCount(queueItems(await r.state({ withJobJson: false })).filter(isOpen).length);
  } catch (_e) {
    /* relais injoignable : le compteur garde sa dernière valeur */
  }
  return undefined;
}

$('queueFilter').addEventListener('click', (e) => {
  const b = e.target.closest('[data-filter]');
  if (!b) return;
  state.queueFilter = b.dataset.filter;
  drawQueue();
});
$('queueList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  if (act === 'reload') return withBusy(b, renderQueue);
  const row = b.closest('.qrow');
  const id = row?.dataset.id;
  const r = relay();
  if (!id || !r) return undefined;
  if (act === 'toggle') {
    const open = !state.openRows.has(id);
    if (open) state.openRows.add(id);
    else state.openRows.delete(id);
    row.classList.toggle('is-open', open);
    b.setAttribute('aria-expanded', String(open));
    return undefined;
  }
  if (act === 'retry') {
    return withBusy(b, async () => {
      try {
        await r.retryJob(id);
        toast('Relancée : le robot va la reprendre.', { kind: 'ok' });
      } catch (err) {
        toast(err.message, { kind: 'err', ms: 5000 });
      }
      await renderQueue();
    });
  }
  if (act === 'del') {
    if (b.dataset.armed !== '1') return arm(b, 'Confirmer');
    disarm(b);
    return withBusy(b, async () => {
      try {
        await r.deleteJob(id);
        state.openRows.delete(id);
        toast('Annonce retirée du relais.', { kind: 'ok' });
      } catch (err) {
        toast(err.message, { kind: 'err', ms: 5000 });
      }
      await renderQueue();
    });
  }
  return undefined;
});
$('refreshQueueBtn').addEventListener('click', () => withBusy($('refreshQueueBtn'), renderQueue));
$('pollBtn').addEventListener('click', () =>
  withBusy($('pollBtn'), async () => {
    const res = await send('RV_POLL_NOW').catch((err) => ({ error: err.message }));
    const why = {
      relay: 'Relais non configuré.',
      account: 'Aucun compte Vinted détecté dans ce profil.',
      'logged-out': 'Ce profil est déconnecté de Vinted.',
      running: 'Un remplissage est déjà en cours.',
      busy: 'Une vérification est déjà en cours.',
      'claimed-elsewhere': 'Annonce déjà prise en charge par un autre profil.',
      idle: 'Rien à traiter pour ce compte.',
    };
    state.robotLineAt = Date.now();
    if (res?.started) setMsg($('robotLine'), `Annonce ${res.started} prise en charge.`, 'ok');
    else if (res?.skipped === 'locked') setMsg($('robotLine'), `@${res.holder || '?'} remplit Vinted en ce moment : ce profil prend la suite dès qu’il a fini (un seul à la fois).`, 'busy');
    else if (res?.error) setMsg($('robotLine'), `Erreur : ${res.error}`, 'err');
    else setMsg($('robotLine'), why[res?.skipped] || why.idle, 'info');
    await renderQueue();
  }),
);

// ===========================================================================
// Comptes
// ===========================================================================

async function loadRelayAccounts() {
  const r = relay();
  if (!r) return;
  try {
    const st = await r.state({ withJobJson: false });
    state.relayAccounts = st.accounts;
    state.accountsError = '';
    if (!state.queue) updateQueueCount(queueItems(st).filter(isOpen).length);
  } catch (err) {
    state.relayAccounts = [];
    state.accountsError = err.message;
  }
  state.accountsLoaded = true;
  await renderTargets();
}

function renderThisAccount() {
  const box = $('thisAccount');
  if (!account?.login) {
    box.innerHTML = `<span class="avatar avatar-lg">${icon('user', { size: 22 })}</span><span class="this-account-text"><b>Aucun compte détecté</b><small>Ouvre vinted.fr connecté dans ce profil, puis « Détecter ».</small></span><span class="pill">Non détecté</span>`;
    return;
  }
  box.innerHTML = `${avatarHtml(account.login, { cls: 'avatar-lg' })}<span class="this-account-text"><b>@${esc(account.login)}</b><small>${esc(account.domain || 'www.vinted.fr')}</small></span>${
    account.loggedOut ? '<span class="pill pill-error">Déconnecté</span>' : '<span class="pill pill-ok">Connecté</span>'
  }`;
}

async function renderAccounts() {
  renderThisAccount();
  const box = $('accountsList');
  if (!relay()) {
    box.innerHTML = emptyHtml('gitBranch', 'Relais non configuré', 'Les comptes des autres profils apparaissent ici une fois le relais configuré.', `<button type="button" class="btn btn-secondary" data-goto="reglages">${icon('settings', { size: 16 })}Ouvrir les réglages</button>`, 'empty-sm');
    return;
  }
  if (!state.accountsLoaded) {
    box.innerHTML = Array.from({ length: 2 }, () => '<div class="list-row" aria-hidden="true"><span class="sk" style="width:36px;height:36px;border-radius:50%"></span><span class="list-text" style="gap:8px"><span class="sk sk-line" style="width:40%"></span><span class="sk sk-line" style="width:25%;height:10px"></span></span></div>').join('');
  }
  await loadRelayAccounts();
  if (state.accountsError) {
    box.innerHTML = emptyHtml('alert', 'Lecture du relais impossible', state.accountsError, '', 'empty-sm');
    return;
  }
  if (!state.relayAccounts.length) {
    box.innerHTML = emptyHtml('users', 'Aucun compte déclaré', 'Dans chaque profil Chrome : ouvre Vinted connecté, puis « Déclarer ce compte au téléphone ».', '', 'empty-sm');
    return;
  }
  const mine = account?.login ? safeLogin(account.login) : '';
  box.innerHTML = state.relayAccounts
    .slice()
    .sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0))
    .map((a) => {
      const age = Date.now() - Date.parse(a.updatedAt || 0);
      const presence = age < 45 * 60 * 1000 ? 'on' : age < 24 * 3600 * 1000 ? 'mid' : 'off';
      const self = mine && safeLogin(a.login) === mine;
      const sub = [a.domain, a.profile && `profil ${a.profile}`, a.ext && `extension ${a.ext}`].filter(Boolean).join(' · ');
      const outdated = versionLt(a.ext, VERSION);
      const warn = outdated ? `<small class="err">Extension à mettre à jour : sinon ce profil peut remplir Vinted en même temps qu’un autre.</small>` : '';
      return `<div class="list-row">${avatarHtml(a.login, { cls: 'avatar-md', presence })}<span class="list-text"><b>@${esc(a.login)}${self ? '<span class="pill pill-accent pill-plain">Ce profil</span>' : ''}</b><small>${esc(sub || '—')}</small>${warn}</span><span class="list-side${presence === 'on' ? ' on' : ''}">${a.updatedAt ? `vu ${esc(timeAgo(a.updatedAt))}` : ''}</span></div>`;
    })
    .join('');
}
$('refreshAccountsBtn').addEventListener('click', () => withBusy($('refreshAccountsBtn'), renderAccounts));
$('detectBtn').addEventListener('click', () =>
  withBusy($('detectBtn'), async () => {
    const res = await send('RV_DETECT_ACCOUNT').catch(() => null);
    account = await store.getAccount();
    renderHeader();
    void renderTargets();
    await renderAccounts();
    if (res?.opened) toast('Un onglet Vinted vient de s’ouvrir : connecte-toi si besoin, puis reclique.', { ms: 6000 });
    else toast(account?.login ? `Compte détecté : @${account.login}` : 'Aucun compte Vinted détecté.', { kind: account?.login ? 'ok' : 'err' });
  }),
);
$('announceBtn').addEventListener('click', () =>
  withBusy($('announceBtn'), async () => {
    const res = await send('RV_ANNOUNCE').catch((err) => ({ error: err.message }));
    if (!res?.ok) toast(res?.error || 'Échec de la déclaration.', { kind: 'err', ms: 5000 });
    else toast('Compte déclaré : il apparaît sur le téléphone.', { kind: 'ok' });
    await renderAccounts();
  }),
);

// ===========================================================================
// Réglages
// ===========================================================================

function fillSettingsForm() {
  $('ghOwner').value = settings.relay.owner;
  $('ghRepo').value = settings.relay.repo;
  $('ghBranch').value = settings.relay.branch;
  $('ghToken').value = settings.relay.token;
  $('wEnabled').checked = settings.worker.enabled;
  $('wAutoSave').checked = settings.worker.autoSave;
  $('wCloseTab').checked = settings.worker.closeTab;
  $('wOcr').checked = settings.worker.ocr;
  $('wCondition').value = settings.worker.defaultCondition;
  $('pName').value = settings.profile.name;
  $('pSignature').value = settings.profile.signature;
  $('pHashtags').value = settings.profile.hashtags;
  $('webUrl').value = settings.webUrl;
  $('autoSave').checked = settings.worker.autoSave;
  renderSettingsState();
}

/** Pastilles d'état des sections Relais et Reconnaissance. */
function renderSettingsState() {
  const r = settings.relay;
  $('relayState').innerHTML = store.relayConfigured(settings)
    ? `<span class="pill pill-ok">Configuré</span><span class="pill pill-plain">${esc(r.owner)}/${esc(r.repo)} · ${esc(r.branch || 'main')}</span>`
    : '<span class="pill pill-warn">À configurer</span>';
  $('recoState').innerHTML = settings.worker.ocr !== false
    ? '<span class="pill pill-ok">Étiquettes lues · sans IA</span>'
    : '<span class="pill pill-warn">Lecture des étiquettes coupée</span>';
}

// La lecture des étiquettes s'enregistre dès qu'on la bascule (pas de bouton dans sa carte).
$('wOcr').addEventListener('change', async () => {
  settings = await store.saveSettings({ worker: { ocr: $('wOcr').checked } });
  renderSettingsState();
  toast($('wOcr').checked ? 'Lecture des étiquettes activée.' : 'Lecture des étiquettes coupée.', { kind: 'ok' });
});

async function saveRelayForm() {
  settings = await store.saveSettings({
    relay: { owner: $('ghOwner').value.trim(), repo: $('ghRepo').value.trim(), branch: $('ghBranch').value.trim() || 'main', token: $('ghToken').value.trim() },
  });
  renderSettingsState();
}
$('saveRelayBtn').addEventListener('click', () =>
  withBusy($('saveRelayBtn'), async () => {
    await saveRelayForm();
    flash($('relayStatus'), 'Enregistré.');
    renderRobotPill();
  }),
);
$('testRelayBtn').addEventListener('click', () =>
  withBusy($('testRelayBtn'), async () => {
    await saveRelayForm();
    setMsg($('relayInfo'), '');
    const r = relay();
    if (!r) return setMsg($('relayStatus'), 'Remplis le compte, le dépôt et le token.', 'err');
    setMsg($('relayStatus'), 'Test de la connexion…', 'busy');
    try {
      const info = await r.ensureReady();
      const size = info.sizeKb >= 1024 ? `${Math.round(info.sizeKb / 1024)} Mo` : `${info.sizeKb} Ko`;
      setMsg($('relayStatus'), `Connexion OK — dépôt ${info.private ? 'privé' : 'public'}, ${size}.`, 'ok');
      if (!info.canPush) setMsg($('relayInfo'), 'Le token ne peut pas écrire dans ce dépôt : donne-lui « Contents : Read and write ».', 'warn');
      else if (!info.private) setMsg($('relayInfo'), 'Dépôt public : les photos y transitent le temps du traitement.', 'info');
      renderRobotPill();
      await send('RV_ANNOUNCE').catch(() => null);
      void loadRelayAccounts();
    } catch (err) {
      setMsg($('relayStatus'), err.message, 'err');
    }
    return undefined;
  }),
);

$('saveWorkerBtn').addEventListener('click', () =>
  withBusy($('saveWorkerBtn'), async () => {
    settings = await store.saveSettings({
      worker: { enabled: $('wEnabled').checked, autoSave: $('wAutoSave').checked, closeTab: $('wCloseTab').checked, ocr: $('wOcr').checked, defaultCondition: $('wCondition').value },
      profile: { name: $('pName').value.trim(), signature: $('pSignature').value.trim(), hashtags: Math.max(0, Math.min(100, parseInt($('pHashtags').value, 10) || 0)) },
    });
    flash($('workerStatus'), 'Enregistré.');
    renderHeader();
    renderRobotPill();
    if ($('autoDesc').checked) regenerate(); // ne pas écraser une description écrite à la main
  }),
);

// ---------- Code de connexion / QR ----------

function currentCode() {
  if (!store.relayConfigured(settings)) throw new Error('Configure et enregistre d’abord le relais GitHub.');
  return encodeConnection({ relay: settings.relay, name: settings.profile.name });
}
$('makeCodeBtn').addEventListener('click', () => {
  try {
    $('codeOut').value = currentCode();
    setMsg($('codeStatus'), 'Code généré : colle-le dans les autres profils Chrome (Réglages → « J’ai déjà un code »).', 'ok');
  } catch (err) {
    setMsg($('codeStatus'), err.message, 'err');
  }
});
$('copyCodeBtn').addEventListener('click', async () => {
  try {
    if (!$('codeOut').value) $('codeOut').value = currentCode();
    await navigator.clipboard.writeText($('codeOut').value);
    toast('Code copié.', { kind: 'ok' });
  } catch (err) {
    setMsg($('codeStatus'), err.message, 'err');
  }
});
$('importCodeBtn').addEventListener('click', () =>
  withBusy($('importCodeBtn'), async () => {
    try {
      const cfg = decodeConnection($('codeIn').value);
      settings = await store.saveSettings({ relay: cfg.relay, ...(cfg.name ? { profile: { name: cfg.name, signature: cfg.name } } : {}) });
      fillSettingsForm();
      renderHeader();
      setMsg($('codeStatus'), 'Code importé : relais configuré pour ce profil.', 'ok');
      await send('RV_ANNOUNCE').catch(() => null);
      renderRobotPill();
      void loadRelayAccounts();
    } catch (err) {
      setMsg($('codeStatus'), err.message, 'err');
    }
  }),
);

function phoneUrl() {
  const web = $('webUrl').value.trim();
  if (!/^https:\/\//.test(web)) throw new Error('Indique l’adresse https:// du dashboard Netlify.');
  return phoneLink(web, currentCode());
}
$('makeQrBtn').addEventListener('click', async () => {
  try {
    settings = await store.saveSettings({ webUrl: $('webUrl').value.trim() });
    const url = phoneUrl();
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    $('qr').innerHTML = qr.createImgTag(4, 8, 'QR code de connexion du téléphone');
    setMsg($('codeStatus'), 'Scanne ce QR code avec le téléphone.', 'ok');
  } catch (err) {
    setMsg($('codeStatus'), err.message, 'err');
  }
});
$('copyLinkBtn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(phoneUrl());
    toast('Lien copié (il contient ton token : envoie-le-toi seulement à toi).', { kind: 'ok', ms: 4500 });
  } catch (err) {
    setMsg($('codeStatus'), err.message, 'err');
  }
});

// ---------- Entretien ----------

$('pruneBtn').addEventListener('click', () =>
  withBusy($('pruneBtn'), async () => {
    const r = relay();
    if (!r) return setMsg($('maintStatus'), 'Configure d’abord le relais GitHub.', 'err');
    try {
      const n = await r.pruneStatuses(30);
      setMsg($('maintStatus'), n ? `${plural(n, 'ancien statut')} effacé${n > 1 ? 's' : ''}.` : 'Aucun statut de plus de 30 jours.', 'ok');
    } catch (err) {
      setMsg($('maintStatus'), err.message, 'err');
    }
    return undefined;
  }),
);
armButton($('compactBtn'), 'Confirmer le compactage', async () => {
  const r = relay();
  if (!r) return setMsg($('maintStatus'), 'Configure d’abord le relais GitHub.', 'err');
  try {
    await r.compactHistory();
    setMsg($('maintStatus'), 'Historique compacté.', 'ok');
  } catch (err) {
    setMsg($('maintStatus'), err.message, 'err');
  }
  return undefined;
});

// ===========================================================================
// Journal + mises à jour en direct
// ===========================================================================

const LOG_ICONS = { error: 'alert', warn: 'alertTriangle', ok: 'checkCircle', info: 'info' };
async function renderLog() {
  const { rv_log = [] } = await chrome.storage.local.get('rv_log');
  $('logList').innerHTML = rv_log.length
    ? rv_log
        .map((l) => {
          const m = l.message || '';
          const level = l.level === 'info' && /brouillon enregistré/i.test(m) ? (/à compléter|étiquettes impossible/i.test(m) ? 'warn' : 'ok') : l.level || 'info';
          const d = new Date(l.at);
          const valid = Number.isFinite(d.getTime()); // toISOString() lève une erreur sur une date invalide
          const when = valid ? d.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
          return `<div class="log-row ${esc(level)}">${icon(LOG_ICONS[level] || 'info', { size: 16 })}<time datetime="${valid ? d.toISOString() : ''}">${esc(when)}</time><span class="log-msg">${esc(l.message)}</span></div>`;
        })
        .join('')
    : emptyHtml('activity', 'Rien pour l’instant', 'Les actions du robot (annonces prises en charge, brouillons, erreurs) s’afficheront ici.');
}
$('refreshLogBtn').addEventListener('click', () => withBusy($('refreshLogBtn'), renderLog));

chrome.storage.onChanged.addListener(async (changes) => {
  if (changes.rv_account) {
    account = changes.rv_account.newValue;
    renderHeader();
    void renderTargets();
    if (state.tab === 'comptes') renderThisAccount();
  }
  if (changes.rv_settings) {
    settings = await store.getSettings();
    renderSettingsState();
    renderRobotPill();
  }
  if (changes.rv_worker) renderRobotPill();
  if (changes.rv_log && state.tab === 'journal') void renderLog();
  if (changes.rv_last_result) {
    const r = changes.rv_last_result.newValue;
    if (r?.origin === 'manual') setMsg($('createStatus'), r.message, r.state === 'done' ? 'ok' : 'err');
    if (state.tab === 'file') void renderQueue();
    else void refreshQueueCount();
  }
});

setInterval(() => {
  renderRobotPill();
  if (document.hidden) return;
  if (state.tab === 'file') void renderQueue();
  else void refreshQueueCount();
}, 20000);

// ===========================================================================
// Init
// ===========================================================================

hydrateIcons();
try {
  $('version').textContent = `Version ${chrome.runtime.getManifest().version}`;
} catch (_e) {
  /* hors extension : pas de version */
}
buildStaticControls();
fillSettingsForm();
renderHeader();
renderRobotPill();
renderRayons();
renderConditions();
renderColors();
renderSizeChips();
renderPhotos();
regenerate();
await renderTargets();
void loadRelayAccounts();
const initial = location.hash.replace('#', '');
showTab(TABS.includes(initial) ? initial : store.relayConfigured(settings) ? 'annonce' : 'reglages');
