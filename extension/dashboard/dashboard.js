/**
 * Revendo — dashboard du PC (onglet plein écran de l'extension).
 */
/* global qrcode */
import { AI_PRESETS, testAi } from '../shared/ai.js';
import { decodeConnection, encodeConnection, phoneLink } from '../shared/config.js';
import { toJpeg } from '../shared/image.js';
import { buildDescription, buildTitle, detectSize, findCategoryDef, formatPriceFR, normalize, parsePrice } from '../shared/listing.js';
import { GitHubRelay, safeLogin } from '../shared/relay.js';
import { analyzeListing, optimizeTitle, SEO_TIPS } from '../shared/seo.js';
import { CATEGORY_DEFS, COLORS, CONDITIONS, MATERIALS, RAYONS } from '../shared/vinted-data.js';
import * as store from '../background/store.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const send = (type, payload = {}) => chrome.runtime.sendMessage({ type, ...payload });

let settings = await store.getSettings();
let account = await store.getAccount();

const state = {
  photos: [], // { id, name, dataUrl, isLabel }
  rayon: '',
  condition: settings.worker.defaultCondition || 'Très bon état',
  colors: [],
  relayAccounts: [],
  touched: { title: false, category: false, size: false },
  keywords: [], // mots-clés « boost référencement » validés par l'utilisateur
};

let relayMemo = { key: '', relay: null };
function relay() {
  if (!store.relayConfigured(settings)) return null;
  const key = JSON.stringify(settings.relay);
  if (relayMemo.key !== key) relayMemo = { key, relay: new GitHubRelay(settings.relay) };
  return relayMemo.relay;
}

function setHint(el, text, kind = '') {
  el.textContent = text;
  el.className = `${el.className.split(' ')[0]}${kind ? ` ${kind}` : ''}`;
}

function timeAgo(ts) {
  const s = Math.round((Date.now() - (typeof ts === 'number' ? ts : Date.parse(ts))) / 1000);
  if (!Number.isFinite(s)) return '';
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.round(s / 3600)} h`;
  return `il y a ${Math.round(s / 86400)} j`;
}

// ===========================================================================
// En-tête, onglets
// ===========================================================================

function renderHeader() {
  const name = settings.profile.name || '';
  $('greeting').textContent = name ? `Bonjour ${name} 👋` : 'Bonjour 👋';
  $('avatar').textContent = (name[0] || 'R').toUpperCase();
  $('accountLine').textContent = account?.login
    ? `Ce profil Chrome = @${account.login} (${account.domain})${account.loggedOut ? ' — déconnecté de Vinted !' : ''}`
    : 'Aucun compte Vinted détecté dans ce profil : ouvre vinted.fr connecté.';
}

async function renderRobotPill() {
  const ws = await store.getWorkerState();
  const pill = $('robotPill');
  if (!store.relayConfigured(settings)) {
    pill.textContent = 'Relais à configurer';
    pill.className = 'status-pill off';
  } else if (!settings.worker.enabled) {
    pill.textContent = 'Robot en pause';
    pill.className = 'status-pill off';
  } else if (ws.current) {
    pill.textContent = 'Robot : remplissage en cours…';
    pill.className = 'status-pill ok';
  } else {
    pill.textContent = `Robot actif${ws.lastPollAt ? ` · vérifié ${timeAgo(ws.lastPollAt)}` : ''}`;
    pill.className = 'status-pill ok';
  }
  $('robotLine').textContent = ws.lastError ? `Dernière erreur : ${ws.lastError}` : ws.current ? `En cours : ${ws.current.jobId}` : '';
}

function showTab(name) {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== name));
  history.replaceState(null, '', `#${name}`);
  if (name === 'file') void renderQueue();
  if (name === 'comptes') void renderAccounts();
  if (name === 'journal') void renderLog();
}
document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

// ===========================================================================
// Nouvelle annonce
// ===========================================================================

function buildStaticControls() {
  $('categoryList').innerHTML = CATEGORY_DEFS.map((d) => `<option value="${esc(d.kw)}"></option>`).join('');
  const matOpts = ['<option value="">—</option>', ...MATERIALS.map((m) => `<option>${esc(m)}</option>`)].join('');
  $('material1').innerHTML = matOpts;
  $('material2').innerHTML = matOpts;
  $('wCondition').innerHTML = CONDITIONS.map((c) => `<option>${esc(c.name)}</option>`).join('');
  $('aiPreset').innerHTML = Object.entries(AI_PRESETS)
    .map(([k, p]) => `<option value="${k}">${esc(p.label)}</option>`)
    .join('');
}

function renderRayons() {
  const box = $('rayonChips');
  box.innerHTML = '';
  for (const r of ['', ...RAYONS.slice(0, 5)]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `chip${state.rayon === r ? ' active' : ''}`;
    b.textContent = r || 'Auto';
    b.addEventListener('click', () => {
      state.rayon = r;
      renderRayons();
      renderSizeChips();
      scheduleDesc();
    });
    box.appendChild(b);
  }
}

function renderConditions() {
  const box = $('conditionGroup');
  box.innerHTML = '';
  for (const c of CONDITIONS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `seg${state.condition === c.name ? ' active' : ''}`;
    b.innerHTML = `<b>${esc(c.name)}</b><span>${esc(c.desc)}</span>`;
    b.addEventListener('click', () => {
      state.condition = c.name;
      renderConditions();
      scheduleDesc();
    });
    box.appendChild(b);
  }
}

function renderColors() {
  const box = $('colorSwatches');
  box.innerHTML = '';
  for (const c of COLORS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `swatch${state.colors.includes(c.name) ? ' active' : ''}`;
    b.innerHTML = `<span class="dot" style="background:${c.hex}"></span><span class="name">${esc(c.name)}</span>`;
    b.addEventListener('click', () => {
      state.colors = state.colors.includes(c.name) ? state.colors.filter((x) => x !== c.name) : [...state.colors, c.name].slice(-2);
      renderColors();
      scheduleDesc();
    });
    box.appendChild(b);
  }
}

function renderSizeChips() {
  const def = findCategoryDef($('category').value || $('title').value);
  const sizes = def?.shoes
    ? ['36', '37', '38', '39', '40', '41', '42', '43', '44', '45']
    : state.rayon === 'Enfants'
      ? ['2 ans', '4 ans', '6 ans', '8 ans', '10 ans', '12 ans', '14 ans']
      : ['XS', 'S', 'M', 'L', 'XL', 'XXL'];
  const box = $('sizeChips');
  box.innerHTML = '';
  for (const s of sizes) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `chip${normalize($('size').value) === normalize(s) ? ' active' : ''}`;
    b.textContent = s;
    b.addEventListener('click', () => {
      $('size').value = s;
      state.touched.size = true;
      renderSizeChips();
      scheduleDesc();
    });
    box.appendChild(b);
  }
}

async function renderTargets() {
  const sel = $('target');
  const prev = sel.value;
  const opts = [];
  opts.push(`<option value="__self">${account?.login ? `Ce profil — @${esc(account.login)}` : 'Ce profil (compte non détecté)'}</option>`);
  for (const a of state.relayAccounts) {
    if (account?.login && safeLogin(a.login) === safeLogin(account.login)) continue;
    opts.push(`<option value="${esc(a.login)}">@${esc(a.login)} (autre profil, via le relais)</option>`);
  }
  sel.innerHTML = opts.join('');
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  $('targetHint').textContent =
    sel.value === '__self' ? 'Le brouillon est créé tout de suite dans ce profil.' : "Envoyé au profil Chrome de ce compte, qui créera le brouillon (il doit être ouvert sur le PC).";
}
$('target').addEventListener('change', renderTargets);

// ---------- Photos ----------

async function addFiles(fileList) {
  const files = [...(fileList || [])].filter((f) => f.type.startsWith('image/'));
  for (const f of files.slice(0, 20 - state.photos.length)) {
    const jpg = await toJpeg(f, { maxSide: 1600, quality: 0.86 });
    state.photos.push({ id: crypto.randomUUID(), name: f.name, dataUrl: jpg.dataUrl, isLabel: false });
  }
  renderPhotos();
}

function renderPhotos() {
  const grid = $('photoGrid');
  grid.innerHTML = '';
  state.photos.forEach((p, i) => {
    const tile = document.createElement('div');
    tile.className = `photo-tile${p.isLabel ? ' is-label' : ''}`;
    tile.innerHTML = `<img src="${p.dataUrl}" alt="">${i === 0 ? '<span class="cover">Couverture</span>' : ''}`;
    const rm = document.createElement('button');
    rm.className = 'remove';
    rm.textContent = '✕';
    rm.addEventListener('click', () => {
      state.photos = state.photos.filter((x) => x.id !== p.id);
      renderPhotos();
    });
    const lbl = document.createElement('div');
    lbl.className = 'label-toggle';
    lbl.textContent = p.isLabel ? '✓ Étiquette' : 'Étiquette ?';
    lbl.addEventListener('click', () => {
      p.isLabel = !p.isLabel;
      renderPhotos();
    });
    tile.addEventListener('dblclick', () => {
      state.photos = [p, ...state.photos.filter((x) => x.id !== p.id)];
      renderPhotos();
    });
    tile.append(rm, lbl);
    grid.appendChild(tile);
  });
}

$('photoInput').addEventListener('change', async (e) => {
  await addFiles(e.target.files);
  e.target.value = '';
});
['dragenter', 'dragover'].forEach((t) => $('dropzone').addEventListener(t, (e) => (e.preventDefault(), $('dropzone').classList.add('over'))));
['dragleave', 'drop'].forEach((t) => $('dropzone').addEventListener(t, (e) => (e.preventDefault(), $('dropzone').classList.remove('over'))));
$('dropzone').addEventListener('drop', (e) => addFiles(e.dataTransfer?.files));

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
  $('description').value = buildDescription({ ...f, title, aiBody: state.aiBody || '' }, { hashtags: settings.profile.hashtags, signature: settings.profile.signature });
  $('descCount').textContent = `${$('description').value.length} caractères`;
  renderSeo();
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
    if (id === 'category') renderSizeChips();
    scheduleDesc();
  }),
);
['material1', 'material2', 'parcel'].forEach((id) => $(id).addEventListener('change', scheduleDesc));
$('description').addEventListener('input', () => {
  $('autoDesc').checked = false;
  $('descCount').textContent = `${$('description').value.length} caractères`;
});
$('autoDesc').addEventListener('change', () => $('autoDesc').checked && regenerate());
$('regenBtn').addEventListener('click', regenerate);
$('price').addEventListener('input', () => {
  const raw = $('price').value.trim();
  const n = parsePrice(raw);
  $('priceCheck').textContent = !raw ? '' : n ? `Sera saisi : ${formatPriceFR(n)}` : '⚠️ Prix invalide';
  scheduleDesc();
});
$('title').addEventListener('input', () => {
  if (!state.touched.size) {
    const s = detectSize($('title').value);
    if (s) $('size').value = s;
  }
});


// ===========================================================================
// Boost référencement (calcul local, aucune API)
// ===========================================================================

function renderSeo() {
  const f = currentFields();
  const a = analyzeListing({ ...f, description: $('description').value }, { photoCount: state.photos.length });
  $('seoScore').textContent = a.score;
  const bar = $('seoBar');
  bar.style.width = `${a.score}%`;
  bar.className = a.score >= 80 ? 'good' : a.score >= 55 ? 'mid' : '';
  $('seoGrade').textContent = `${a.grade} — calculé sur la fiche telle qu'elle sera envoyée à Vinted.`;
  $('seoTodo').innerHTML = a.todo.length
    ? a.todo
        .slice(0, 5)
        .map((c) => `<li><b>+${c.weight - c.earned}</b><span>${esc(c.tip)}</span></li>`)
        .join('')
    : '<li class="done">Fiche complète : rien d’important à ajouter.</li>';
  const suggested = a.optimizedTitle && a.optimizedTitle !== f.title ? a.optimizedTitle : '';
  $('seoTitleBox').classList.toggle('hidden', !suggested);
  $('seoTitle').textContent = suggested;
  const chips = [...new Set([...state.keywords, ...a.keywords, ...a.synonyms])].slice(0, 12);
  $('seoKwBox').classList.toggle('hidden', !chips.length);
  const box = $('seoKeywords');
  box.innerHTML = '';
  for (const k of chips) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `chip add${state.keywords.includes(k) ? ' active' : ''}`;
    b.textContent = k;
    b.addEventListener('click', () => {
      state.keywords = state.keywords.includes(k) ? state.keywords.filter((x) => x !== k) : [...state.keywords, k];
      if ($('autoDesc').checked) regenerate();
      else {
        $('description').value += `${$('description').value.endsWith('\n') ? '' : '\n'}✔️ ${k}`;
        renderSeo();
      }
    });
    box.appendChild(b);
  }
}

$('applyTitleBtn').addEventListener('click', () => {
  $('title').value = $('seoTitle').textContent;
  state.touched.title = true;
  scheduleDesc();
  renderSeo();
});
$('seoTips').innerHTML = SEO_TIPS.map((t) => `<li>${esc(t)}</li>`).join('');
let seoTimer;
const panelAnnonce = document.querySelector('[data-panel="annonce"]');
['input', 'change', 'click'].forEach((ev) =>
  panelAnnonce.addEventListener(ev, (e) => {
    if (e.target.closest?.('#seoCard')) return;
    clearTimeout(seoTimer);
    seoTimer = setTimeout(renderSeo, 250);
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
  state.aiBody = f.aiBody || '';
  renderRayons();
  renderConditions();
  renderColors();
  renderSizeChips();
  $('autoDesc').checked = true;
  regenerate();
}

async function analyze() {
  if (!state.photos.length) {
    setHint($('analyzeStatus'), 'Ajoute d’abord des photos.', 'err');
    return null;
  }
  $('analyzeBtn').disabled = true;
  setHint($('analyzeStatus'), store.aiConfigured(settings) ? 'Analyse des photos par l’IA…' : 'Mode gratuit : couleur + lecture des étiquettes…');
  try {
    const hints = { rayon: state.rayon, price: $('price').value.trim(), labelIndexes: state.photos.map((p, i) => (p.isLabel ? i : -1)).filter((i) => i >= 0) };
    const res = await send('RV_ANALYZE', { photos: state.photos.slice(0, 6).map((p) => p.dataUrl), hints });
    if (!res?.ok) throw new Error(res?.error || 'analyse impossible');
    applyFields(res.fields);
    const r = res.recognition;
    const found = [res.fields.category && `catégorie ${res.fields.category}`, res.fields.brand && `marque ${res.fields.brand}`, res.fields.size && `taille ${res.fields.size}`, res.fields.colors?.length && res.fields.colors.join('/')]
      .filter(Boolean)
      .join(' · ');
    setHint(
      $('analyzeStatus'),
      `${r.mode === 'ai' ? `IA (${r.model})` : 'Mode gratuit'} : ${found || 'rien de sûr'}${r.error ? ` — IA indisponible : ${r.error}` : ''}${r.mode !== 'ai' && !res.fields.category ? ' · la catégorie sera choisie parmi les recommandations de Vinted' : ''}`,
      'ok',
    );
    return res.fields;
  } catch (err) {
    setHint($('analyzeStatus'), `Erreur : ${err.message}`, 'err');
    return null;
  } finally {
    $('analyzeBtn').disabled = false;
  }
}
$('analyzeBtn').addEventListener('click', analyze);

// ---------- Création ----------

$('createBtn').addEventListener('click', async () => {
  const status = $('createStatus');
  const price = parsePrice($('price').value);
  if (!state.photos.length) return setHint(status, 'Ajoute au moins une photo.', 'err');
  if (!price) return setHint(status, 'Indique un prix valide.', 'err');
  $('createBtn').disabled = true;
  try {
    if (!$('title').value.trim() && !$('category').value.trim()) await analyze();
    const f = currentFields();
    if ($('autoDesc').checked) regenerate();
    const target = $('target').value;
    if (target === '__self') {
      const listing = {
        ...f,
        title: f.title || (f.category ? buildTitle(f) : ''),
        description: $('description').value,
        price: String(price),
        autoSave: $('autoSave').checked,
        recognition: { mode: store.aiConfigured(settings) ? 'ai' : 'free' },
      };
      setHint(status, 'Ouverture de Vinted…');
      const res = await send('RV_RUN_MANUAL', { listing, photos: state.photos.map((p) => p.dataUrl) });
      if (!res?.ok) throw new Error(res?.error || 'échec');
      setHint(status, 'Fenêtre Vinted ouverte : le brouillon se remplit (bandeau en haut à droite).', 'ok');
    } else {
      const r = relay();
      if (!r) throw new Error('Configure le relais GitHub (Réglages).');
      setHint(status, 'Envoi des photos au relais…');
      const thumb = (await toJpeg(state.photos[0].dataUrl, { maxSide: 160, quality: 0.7 })).dataUrl;
      const hints = { ...f, description: $('autoDesc').checked ? '' : $('description').value, skipAi: !!(f.title && f.category) };
      const { id } = await r.createJob({
        account: target,
        price: String(price),
        hints,
        photos: state.photos.map((p) => ({ base64: p.dataUrl.split(',')[1] })),
        thumb,
        createdBy: 'pc',
        onProgress: (d, t) => setHint(status, `Envoi des photos ${d}/${t}…`),
      });
      setHint(status, `Envoyé à @${target} (${id}) : son profil Chrome va créer le brouillon.`, 'ok');
      resetForm();
    }
  } catch (err) {
    setHint(status, `Erreur : ${err.message}`, 'err');
  } finally {
    $('createBtn').disabled = false;
  }
});

function resetForm() {
  state.photos = [];
  state.colors = [];
  state.aiBody = '';
  state.keywords = [];
  state.touched = { title: false, category: false, size: false };
  ['title', 'category', 'brand', 'size', 'price'].forEach((id) => ($(id).value = ''));
  $('material1').value = '';
  $('material2').value = '';
  $('parcel').value = '';
  $('priceCheck').textContent = '';
  $('analyzeStatus').textContent = '';
  renderPhotos();
  renderColors();
  renderSizeChips();
  regenerate();
}

// ===========================================================================
// File d'attente
// ===========================================================================

async function renderQueue() {
  const list = $('queueList');
  const r = relay();
  if (!r) {
    list.innerHTML = '<p class="hint">Configure d’abord le relais GitHub (onglet Réglages).</p>';
    return;
  }
  try {
    const st = await r.state();
    const items = [];
    for (const j of st.jobs) {
      const s = st.statuses.get(j.id);
      items.push({ id: j.id, account: j.account, thumb: j.data?.thumb || s?.thumb, price: j.data?.price, state: s?.state || 'pending', status: s, hasFiles: true });
    }
    for (const [id, s] of st.statuses) if (!st.jobs.some((j) => j.id === id)) items.push({ id, account: s.account, thumb: s.thumb, price: s.summary?.price, state: s.state, status: s, hasFiles: false });
    items.sort((a, b) => b.id.localeCompare(a.id));
    const open = items.filter((i) => i.state === 'pending' || i.state === 'processing').length;
    $('queueCount').textContent = open ? String(open) : '';
    if (!items.length) {
      list.innerHTML = '<p class="hint">Aucune annonce pour l’instant. Envoie-en une depuis le téléphone !</p>';
      return;
    }
    const label = { pending: 'En attente', processing: 'En cours', done: 'Brouillon créé', error: 'Erreur' };
    list.innerHTML = items
      .slice(0, 60)
      .map((i) => {
        const title = i.status?.summary?.title || (i.state === 'pending' ? 'Annonce à traiter' : '');
        const when = i.status?.updatedAt || i.id.replace(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2}).*/, '$1-$2-$3T$4:$5:$6Z');
        return `<div class="qitem">
          ${i.thumb ? `<img src="${esc(i.thumb)}" alt="">` : '<div class="noimg"></div>'}
          <div>
            <h3><span class="badge ${i.state}">${label[i.state] || i.state}</span>${esc(title)}</h3>
            <p>@${esc(i.account)}${i.price ? ` · ${esc(formatPriceFR(parseFloat(i.price)))}` : ''} · ${timeAgo(when)}</p>
            ${i.status?.message ? `<p>${esc(i.status.message)}</p>` : ''}
          </div>
          <div class="qactions">
            ${i.state === 'error' && i.hasFiles ? `<button class="ghost" data-retry="${esc(i.id)}">Réessayer</button>` : ''}
            <button class="ghost" data-del="${esc(i.id)}">Supprimer</button>
          </div>
        </div>`;
      })
      .join('');
    list.querySelectorAll('[data-retry]').forEach((b) =>
      b.addEventListener('click', async () => {
        b.disabled = true;
        await r.retryJob(b.dataset.retry).catch((e) => alert(e.message));
        void renderQueue();
      }),
    );
    list.querySelectorAll('[data-del]').forEach((b) =>
      b.addEventListener('click', async () => {
        if (!confirm('Supprimer cette annonce du relais ?')) return;
        b.disabled = true;
        await r.deleteJob(b.dataset.del).catch((e) => alert(e.message));
        void renderQueue();
      }),
    );
  } catch (err) {
    list.innerHTML = `<p class="hint err">${esc(err.message)}</p>`;
  }
}
$('refreshQueueBtn').addEventListener('click', renderQueue);
$('pollBtn').addEventListener('click', async () => {
  $('pollBtn').disabled = true;
  const res = await send('RV_POLL_NOW');
  const why = { relay: 'relais non configuré', account: 'aucun compte Vinted détecté dans ce profil', 'logged-out': 'profil déconnecté de Vinted', running: 'un remplissage est déjà en cours', idle: 'rien à traiter pour ce compte' };
  $('robotLine').textContent = res?.started ? `Annonce ${res.started} prise en charge.` : res?.error ? `Erreur : ${res.error}` : why[res?.skipped] || (res?.idle ? why.idle : '');
  $('pollBtn').disabled = false;
  void renderQueue();
});

// ===========================================================================
// Comptes
// ===========================================================================

async function loadRelayAccounts() {
  const r = relay();
  if (!r) return;
  try {
    state.relayAccounts = (await r.state({ withJobJson: false })).accounts;
  } catch (_e) {
    state.relayAccounts = [];
  }
  await renderTargets();
}

async function renderAccounts() {
  $('thisAccount').textContent = account?.login ? `@${account.login} — ${account.domain}${account.loggedOut ? ' (déconnecté !)' : ''}` : 'Aucun compte détecté';
  await loadRelayAccounts();
  const box = $('accountsList');
  if (!state.relayAccounts.length) {
    box.innerHTML = '<p class="hint">Aucun compte déclaré. Dans chaque profil Chrome : ouvre Vinted connecté, puis « Déclarer ce compte ».</p>';
    return;
  }
  box.innerHTML = state.relayAccounts
    .map((a) => {
      const age = Date.now() - Date.parse(a.updatedAt || 0);
      const cls = age < 45 * 60 * 1000 ? 'on' : age < 24 * 3600 * 1000 ? 'mid' : '';
      return `<div class="acc"><span><span class="dot ${cls}"></span>@${esc(a.login)} <span class="muted">${esc(a.domain || '')}</span></span><span class="muted">vu ${timeAgo(a.updatedAt)}${a.profile ? ` · profil ${esc(a.profile)}` : ''}</span></div>`;
    })
    .join('');
}
$('refreshAccountsBtn').addEventListener('click', renderAccounts);
$('detectBtn').addEventListener('click', async () => {
  const res = await send('RV_DETECT_ACCOUNT');
  if (res?.opened) alert('Un onglet Vinted vient de s’ouvrir : connecte-toi si besoin, puis reclique.');
  account = await store.getAccount();
  renderHeader();
  void renderAccounts();
});
$('announceBtn').addEventListener('click', async () => {
  const res = await send('RV_ANNOUNCE');
  if (!res?.ok) alert(res?.error || 'Échec');
  void renderAccounts();
});

// ===========================================================================
// Réglages
// ===========================================================================

function fillSettingsForm() {
  $('ghOwner').value = settings.relay.owner;
  $('ghRepo').value = settings.relay.repo;
  $('ghBranch').value = settings.relay.branch;
  $('ghToken').value = settings.relay.token;
  $('aiEnabled').checked = settings.ai.enabled;
  $('aiPreset').value = settings.ai.preset;
  $('aiModel').value = settings.ai.model;
  $('aiBaseUrl').value = settings.ai.baseUrl;
  $('aiKey').value = settings.ai.key;
  $('aiKeyLink').href = AI_PRESETS[settings.ai.preset]?.keyUrl || 'https://aistudio.google.com/apikey';
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
}

$('aiPreset').addEventListener('change', () => ($('aiKeyLink').href = AI_PRESETS[$('aiPreset').value]?.keyUrl || '#'));

async function saveRelayForm() {
  settings = await store.saveSettings({
    relay: { owner: $('ghOwner').value.trim(), repo: $('ghRepo').value.trim(), branch: $('ghBranch').value.trim() || 'main', token: $('ghToken').value.trim() },
  });
}
$('saveRelayBtn').addEventListener('click', async () => {
  await saveRelayForm();
  setHint($('relayStatus'), 'Enregistré.', 'ok');
  renderRobotPill();
});
$('testRelayBtn').addEventListener('click', async () => {
  await saveRelayForm();
  const r = relay();
  if (!r) return setHint($('relayStatus'), 'Remplis les 4 champs.', 'err');
  setHint($('relayStatus'), 'Test…');
  try {
    const info = await r.ensureReady();
    const warn = info.private ? '' : ' ⚠️ Ce dépôt est PUBLIC : passe-le en privé (Settings → Danger Zone → Change visibility), sinon tes photos sont visibles par tous.';
    setHint($('relayStatus'), `Connexion OK (${info.private ? 'dépôt privé' : 'dépôt public'}, ${Math.round(info.sizeKb / 1024)} Mo).${warn}`, info.private ? 'ok' : 'err');
    await send('RV_ANNOUNCE').catch(() => null);
    void loadRelayAccounts();
  } catch (err) {
    setHint($('relayStatus'), err.message, 'err');
  }
});

async function saveAiForm() {
  settings = await store.saveSettings({
    ai: { enabled: $('aiEnabled').checked, preset: $('aiPreset').value, key: $('aiKey').value.trim(), model: $('aiModel').value.trim(), baseUrl: $('aiBaseUrl').value.trim() },
  });
}
$('saveAiBtn').addEventListener('click', async () => {
  await saveAiForm();
  setHint($('aiStatus'), 'Enregistré.', 'ok');
});
$('testAiBtn').addEventListener('click', async () => {
  await saveAiForm();
  setHint($('aiStatus'), 'Test…');
  try {
    const model = await testAi(settings.ai);
    setHint($('aiStatus'), `Clé OK (modèle ${model}).`, 'ok');
  } catch (err) {
    setHint($('aiStatus'), err.message, 'err');
  }
});

$('saveWorkerBtn').addEventListener('click', async () => {
  settings = await store.saveSettings({
    worker: { enabled: $('wEnabled').checked, autoSave: $('wAutoSave').checked, closeTab: $('wCloseTab').checked, ocr: $('wOcr').checked, defaultCondition: $('wCondition').value },
    profile: { name: $('pName').value.trim(), signature: $('pSignature').value.trim(), hashtags: Math.max(0, Math.min(100, parseInt($('pHashtags').value, 10) || 0)) },
  });
  setHint($('workerStatus'), 'Enregistré.', 'ok');
  renderHeader();
  renderRobotPill();
  regenerate();
});

// ---------- Code de connexion / QR ----------

function currentCode() {
  if (!store.relayConfigured(settings)) throw new Error('Configure et enregistre d’abord le relais GitHub.');
  return encodeConnection({ relay: settings.relay, ai: settings.ai.enabled ? settings.ai : null, name: settings.profile.name });
}
$('makeCodeBtn').addEventListener('click', () => {
  try {
    $('codeOut').value = currentCode();
    setHint($('codeStatus'), 'Code généré : colle-le dans les autres profils Chrome (Réglages → « J’ai déjà un code »).', 'ok');
  } catch (err) {
    setHint($('codeStatus'), err.message, 'err');
  }
});
$('copyCodeBtn').addEventListener('click', async () => {
  try {
    if (!$('codeOut').value) $('codeOut').value = currentCode();
    await navigator.clipboard.writeText($('codeOut').value);
    setHint($('codeStatus'), 'Copié.', 'ok');
  } catch (err) {
    setHint($('codeStatus'), err.message, 'err');
  }
});
$('importCodeBtn').addEventListener('click', async () => {
  try {
    const cfg = decodeConnection($('codeIn').value);
    settings = await store.saveSettings({ relay: cfg.relay, ...(cfg.ai ? { ai: { ...cfg.ai, enabled: true } } : {}), ...(cfg.name ? { profile: { name: cfg.name, signature: cfg.name } } : {}) });
    fillSettingsForm();
    renderHeader();
    setHint($('codeStatus'), 'Code importé : relais et IA configurés pour ce profil.', 'ok');
    await send('RV_ANNOUNCE').catch(() => null);
    renderRobotPill();
  } catch (err) {
    setHint($('codeStatus'), err.message, 'err');
  }
});

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
    $('qr').innerHTML = qr.createImgTag(4, 8);
    setHint($('codeStatus'), 'Scanne ce QR code avec le téléphone.', 'ok');
  } catch (err) {
    setHint($('codeStatus'), err.message, 'err');
  }
});
$('copyLinkBtn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(phoneUrl());
    setHint($('codeStatus'), 'Lien copié (envoie-le-toi, il contient ton token).', 'ok');
  } catch (err) {
    setHint($('codeStatus'), err.message, 'err');
  }
});

// ---------- Entretien ----------

$('pruneBtn').addEventListener('click', async () => {
  const r = relay();
  if (!r) return;
  try {
    const n = await r.pruneStatuses(30);
    setHint($('maintStatus'), `${n} ancien(s) statut(s) effacé(s).`, 'ok');
  } catch (err) {
    setHint($('maintStatus'), err.message, 'err');
  }
});
$('compactBtn').addEventListener('click', async () => {
  const r = relay();
  if (!r || !confirm("Compacter l'historique du relais ? N'envoie aucune annonce pendant quelques secondes.")) return;
  try {
    await r.compactHistory();
    setHint($('maintStatus'), 'Historique compacté.', 'ok');
  } catch (err) {
    setHint($('maintStatus'), err.message, 'err');
  }
});

// ===========================================================================
// Journal + mises à jour en direct
// ===========================================================================

async function renderLog() {
  const { rv_log = [] } = await chrome.storage.local.get('rv_log');
  $('logList').innerHTML = rv_log.length
    ? rv_log.map((l) => `<div class="${l.level}">${new Date(l.at).toLocaleString('fr-FR')} — ${esc(l.message)}</div>`).join('')
    : '<p class="hint">Rien pour l’instant.</p>';
}
$('refreshLogBtn').addEventListener('click', renderLog);

chrome.storage.onChanged.addListener(async (changes) => {
  if (changes.rv_account) {
    account = changes.rv_account.newValue;
    renderHeader();
    void renderTargets();
  }
  if (changes.rv_worker) renderRobotPill();
  if (changes.rv_log) void renderLog();
  if (changes.rv_last_result) {
    const r = changes.rv_last_result.newValue;
    if (r?.origin === 'manual') setHint($('createStatus'), r.message, r.state === 'done' ? 'ok' : 'err');
    if (!$('queueList').closest('.hidden')) void renderQueue();
  }
});

setInterval(() => {
  renderRobotPill();
  if (!document.hidden && !$('queueList').closest('.hidden')) void renderQueue();
}, 20000);

// ===========================================================================
// Init
// ===========================================================================

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
showTab(['annonce', 'file', 'comptes', 'reglages', 'journal'].includes(initial) ? initial : store.relayConfigured(settings) ? 'annonce' : 'reglages');
