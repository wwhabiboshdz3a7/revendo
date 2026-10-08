/**
 * Revendo — dashboard téléphone (statique, hébergé sur Netlify).
 * Il ne parle qu'à GitHub (le relais) : photos + prix + compte → le PC fait le reste.
 * La configuration (token…) vient du QR code / code de connexion et reste
 * uniquement dans ce navigateur (localStorage).
 */
import { decodeConnection } from './shared/config.js';
import { toJpeg } from './shared/image.js';
import { formatPriceFR, parsePrice } from './shared/listing.js';
import { GitHubRelay } from './shared/relay.js';
import { CONDITIONS } from './shared/vinted-data.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
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
  del: (k) => localStorage.removeItem(`revendo_${k}`),
};

let cfg = LS.get('cfg');
let relay = null;
let lastState = null;
let pollTimer = null;

const form = {
  photos: [], // { id, dataUrl, base64, isLabel }
  account: LS.get('lastAccount', ''),
  rayon: LS.get('lastRayon', ''),
  condition: '',
};

// ===========================================================================
// Navigation
// ===========================================================================

function show(view) {
  for (const v of ['setupView', 'homeView', 'newView']) $(v).classList.toggle('hidden', v !== view);
  window.scrollTo({ top: 0 });
}

function toast(text, ms = 2600) {
  const t = $('toast');
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add('hidden'), ms);
}

function msg(el, text, kind = '') {
  el.textContent = text;
  el.className = `msg${kind ? ` ${kind}` : ''}`;
}

function timeAgo(ts) {
  const s = Math.round((Date.now() - Date.parse(ts)) / 1000);
  if (!Number.isFinite(s)) return '';
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.round(s / 3600)} h`;
  return `il y a ${Math.round(s / 86400)} j`;
}

function idToIso(id) {
  return id.replace(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2}).*/, '$1-$2-$3T$4:$5:$6Z');
}

// ===========================================================================
// Connexion
// ===========================================================================

function connect(code) {
  const parsed = decodeConnection(code);
  cfg = { relay: parsed.relay, name: parsed.name || '' };
  LS.set('cfg', cfg);
  start();
}

$('connectBtn').addEventListener('click', () => {
  try {
    connect($('codeInput').value);
  } catch (err) {
    msg($('setupStatus'), err.message, 'err');
  }
});

// Ouverture via le QR code : …/#c=REV1.xxx → on enregistre puis on efface le code de l'URL.
if (location.hash.startsWith('#c=')) {
  try {
    const parsed = decodeConnection(location.hash);
    cfg = { relay: parsed.relay, name: parsed.name || '' };
    LS.set('cfg', cfg);
  } catch (err) {
    setTimeout(() => msg($('setupStatus'), err.message, 'err'), 0);
  }
  history.replaceState(null, '', location.pathname);
}

// ===========================================================================
// Accueil
// ===========================================================================

function accountsList() {
  return (lastState?.accounts || []).slice().sort((a, b) => a.login.localeCompare(b.login));
}

function onlineClass(a) {
  const age = Date.now() - Date.parse(a.updatedAt || 0);
  return age < 45 * 60 * 1000 ? 'on' : age < 24 * 3600 * 1000 ? 'mid' : '';
}

function renderAccountsRow() {
  const accs = accountsList();
  $('accountsRow').innerHTML = accs.length
    ? accs.map((a) => `<span class="acc"><span class="dot ${onlineClass(a)}"></span>@${esc(a.login)}</span>`).join('')
    : '<span class="muted" style="font-size:14px">Aucun compte : ouvre Vinted dans chaque profil Chrome du PC (avec l’extension).</span>';
}

const STATE_LABEL = { pending: 'En attente du PC', processing: 'En cours sur le PC', done: 'Brouillon créé', error: 'À vérifier' };

function queueItems() {
  if (!lastState) return [];
  const items = [];
  for (const j of lastState.jobs) {
    const s = lastState.statuses.get(j.id);
    items.push({ id: j.id, account: j.account, thumb: j.data?.thumb || s?.thumb, price: j.data?.price, state: s?.state || 'pending', status: s, hasFiles: true, hints: j.data?.hints });
  }
  for (const [id, s] of lastState.statuses) {
    if (!lastState.jobs.some((j) => j.id === id)) items.push({ id, account: s.account, thumb: s.thumb, price: s.summary?.price, state: s.state, status: s, hasFiles: false });
  }
  return items.sort((a, b) => b.id.localeCompare(a.id)).slice(0, 50);
}

function renderQueue() {
  const items = queueItems();
  const box = $('queue');
  if (!items.length) {
    box.innerHTML = '<div class="empty">Rien pour l’instant.<br>Appuie sur « Nouvelle annonce » 📸</div>';
    return;
  }
  box.innerHTML = items
    .map((i) => {
      const title = i.status?.summary?.title || (i.state === 'pending' ? 'Annonce envoyée' : i.state === 'processing' ? 'Reconnaissance et remplissage…' : '');
      const price = i.price ? formatPriceFR(parseFloat(i.price)) : '';
      return `<div class="card" data-id="${esc(i.id)}">
        ${i.thumb ? `<img src="${esc(i.thumb)}" alt="">` : '<div class="noimg"></div>'}
        <div>
          <span class="badge ${i.state}">${STATE_LABEL[i.state] || i.state}</span>
          <h3>${esc(title)}</h3>
          <p>@${esc(i.account)}${price ? ` · ${price}` : ''} · ${timeAgo(i.status?.updatedAt || idToIso(i.id))}</p>
        </div>
        <span class="chev">›</span>
      </div>`;
    })
    .join('');
  box.querySelectorAll('.card').forEach((c) => c.addEventListener('click', () => openDetail(c.dataset.id)));
}

async function refresh({ quiet = false } = {}) {
  if (!relay) return;
  try {
    lastState = await relay.state();
    renderAccountsRow();
    renderQueue();
    if (!$('newView').classList.contains('hidden')) renderAccountChips();
    if (!quiet) msg($('homeMsg'), '');
  } catch (err) {
    msg($('homeMsg'), err.message, 'err');
  }
}

$('refreshBtn').addEventListener('click', () => refresh());
$('newBtn').addEventListener('click', openNew);

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') void refresh({ quiet: true });
  }, 12000);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void refresh({ quiet: true });
});

// ===========================================================================
// Détail d'une annonce
// ===========================================================================

function openSheet(html) {
  $('sheetBody').innerHTML = html;
  $('sheet').classList.remove('hidden');
}
function closeSheet() {
  $('sheet').classList.add('hidden');
}
$('sheetClose').addEventListener('click', closeSheet);
$('sheet').addEventListener('click', (e) => {
  if (e.target === $('sheet')) closeSheet();
});

function openDetail(id) {
  const i = queueItems().find((x) => x.id === id);
  if (!i) return;
  const s = i.status;
  const sum = s?.summary || {};
  const rows = [
    ['Statut', STATE_LABEL[i.state] || i.state],
    ['Compte', `@${i.account}`],
    ['Prix', i.price ? formatPriceFR(parseFloat(i.price)) : ''],
    ['Titre', sum.title],
    ['Catégorie', sum.category],
    ['Marque', sum.brand],
    ['Taille', sum.size],
    ['Couleur', (sum.colors || []).join(' / ')],
    ['État', sum.condition],
    ['Reconnaissance', sum.mode === 'ai' ? 'IA' : sum.mode === 'free' ? 'mode gratuit' : ''],
    ['Référencement', Number.isFinite(sum.seo) ? `${sum.seo}/100` : ''],
  ].filter(([, v]) => v);
  const seoTips = (sum.seoTodo || []).map((t) => `<li>${esc(t)}</li>`).join('');
  const fields = (s?.fields || []).map((f) => `<div class="row"><b>${f.ok ? '✅' : '❌'} ${esc(f.label)}</b><span>${esc(f.detail)}</span></div>`).join('');
  const stuck = i.state === 'processing' && Date.now() - Date.parse(s?.updatedAt || 0) > 10 * 60 * 1000;
  openSheet(`
    ${i.thumb ? `<img class="hero" src="${esc(i.thumb)}" alt="">` : ''}
    <h2>${esc(sum.title || 'Annonce')}</h2>
    ${s?.message ? `<p class="msg ${i.state === 'error' ? 'err' : 'ok'}" style="text-align:left">${esc(s.message)}</p>` : ''}
    ${rows.map(([k, v]) => `<div class="row"><b>${esc(k)}</b><span>${esc(v)}</span></div>`).join('')}
    ${fields ? `<h2 style="margin-top:16px">Remplissage</h2>${fields}` : ''}
    ${seoTips ? `<h2 style="margin-top:16px">📈 Pour mieux ressortir dans la recherche</h2><ul class="tips">${seoTips}</ul>` : ''}
    ${i.state === 'pending' ? '<p class="hint">En attente : le profil Chrome de ce compte doit être ouvert sur le PC.</p>' : ''}
    ${i.state === 'done' ? '<p class="hint">Retrouve-le dans Vinted → Profil → Mes brouillons, vérifie et publie.</p>' : ''}
    <div class="actions">
      ${(i.state === 'error' || stuck) && i.hasFiles ? '<button id="retryBtn">Réessayer</button>' : ''}
      <button id="deleteBtn" class="danger">${i.state === 'done' ? 'Retirer du suivi' : 'Supprimer'}</button>
    </div>`);
  $('retryBtn')?.addEventListener('click', async () => {
    try {
      await relay.retryJob(id);
      closeSheet();
      toast('Relancé : le PC va la reprendre.');
      void refresh();
    } catch (err) {
      toast(err.message, 4000);
    }
  });
  $('deleteBtn').addEventListener('click', async () => {
    if (!confirm(i.state === 'done' ? 'Retirer du suivi ? (le brouillon Vinted n’est pas touché)' : 'Supprimer cette annonce ?')) return;
    try {
      await relay.deleteJob(id);
      closeSheet();
      void refresh();
    } catch (err) {
      toast(err.message, 4000);
    }
  });
}

// ===========================================================================
// Réglages
// ===========================================================================

$('settingsBtn').addEventListener('click', () => {
  openSheet(`
    <h2>Réglages</h2>
    <div class="row"><b>Relais</b><span>${esc(cfg.relay.owner)}/${esc(cfg.relay.repo)} (${esc(cfg.relay.branch)})</span></div>
    <label for="nameInput">Ton prénom</label>
    <input type="text" id="nameInput" value="${esc(cfg.name || '')}" />
    <p id="settingsMsg" class="msg"></p>
    <div class="actions">
      <button id="testBtn">Tester la connexion</button>
      <button id="saveNameBtn">Enregistrer</button>
    </div>
    <div class="actions"><button id="logoutBtn" class="danger">Déconnecter ce téléphone</button></div>
    <p class="hint">Le code de connexion donne accès au relais : ne le partage pas.</p>`);
  $('testBtn').addEventListener('click', async () => {
    try {
      const info = await relay.repoInfo();
      msg($('settingsMsg'), info.private ? 'Connexion OK (dépôt privé).' : 'Connexion OK, mais le dépôt est PUBLIC : passe-le en privé sur GitHub !', info.private ? 'ok' : 'err');
    } catch (err) {
      msg($('settingsMsg'), err.message, 'err');
    }
  });
  $('saveNameBtn').addEventListener('click', () => {
    cfg.name = $('nameInput').value.trim();
    LS.set('cfg', cfg);
    renderHello();
    closeSheet();
  });
  $('logoutBtn').addEventListener('click', () => {
    if (!confirm('Oublier la connexion sur ce téléphone ?')) return;
    LS.del('cfg');
    location.reload();
  });
});

function renderHello() {
  $('hello').textContent = cfg?.name ? `Salut ${cfg.name} 👋` : 'Salut 👋';
}

// ===========================================================================
// Nouvelle annonce
// ===========================================================================

function openNew() {
  form.photos = [];
  form.condition = '';
  $('price').value = '';
  $('brand').value = '';
  $('size').value = '';
  $('notes').value = '';
  $('priceCheck').textContent = '';
  msg($('sendStatus'), '');
  renderPhotos();
  renderAccountChips();
  renderRayonChips();
  renderConditionChips();
  show('newView');
}
$('backBtn').addEventListener('click', () => {
  show('homeView');
  void refresh({ quiet: true });
});

$('photoInput').addEventListener('change', async (e) => {
  const files = [...(e.target.files || [])].filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|heic|webp)$/i.test(f.name));
  e.target.value = '';
  const room = 20 - form.photos.length;
  msg($('sendStatus'), files.length ? 'Préparation des photos…' : '');
  for (const [n, f] of files.slice(0, room).entries()) {
    try {
      const jpg = await toJpeg(f, { maxSide: 1600, quality: 0.85 });
      form.photos.push({ id: Math.random().toString(36).slice(2), dataUrl: jpg.dataUrl, base64: jpg.base64, isLabel: false });
      msg($('sendStatus'), `Préparation des photos ${n + 1}/${Math.min(files.length, room)}…`);
      renderPhotos();
    } catch (err) {
      toast(`Photo ignorée : ${err.message}`, 3500);
    }
  }
  msg($('sendStatus'), '');
});

function renderPhotos() {
  const grid = $('photoGrid');
  grid.innerHTML = '';
  form.photos.forEach((p, i) => {
    const d = document.createElement('div');
    d.className = `ph${p.isLabel ? ' is-label' : ''}`;
    d.innerHTML = `<img src="${p.dataUrl}" alt="">${i === 0 ? '<span class="tag">Couverture</span>' : ''}<button class="x" aria-label="Retirer">✕</button><button class="lbl">${p.isLabel ? '✓ Étiquette' : 'Étiquette ?'}</button>`;
    d.querySelector('.x').addEventListener('click', () => {
      form.photos = form.photos.filter((x) => x.id !== p.id);
      renderPhotos();
    });
    d.querySelector('.lbl').addEventListener('click', () => {
      p.isLabel = !p.isLabel;
      renderPhotos();
    });
    d.querySelector('img').addEventListener('click', () => {
      // Toucher une photo = la mettre en couverture.
      form.photos = [p, ...form.photos.filter((x) => x.id !== p.id)];
      renderPhotos();
    });
    grid.appendChild(d);
  });
  $('addPhotos').querySelector('span').textContent = form.photos.length ? `＋ Ajouter (${form.photos.length}/20)` : '＋ Ajouter des photos';
}

function chip(label, active, onClick, extraHtml = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `chip${active ? ' active' : ''}`;
  b.innerHTML = `${extraHtml}${esc(label)}`;
  b.addEventListener('click', onClick);
  return b;
}

function renderAccountChips() {
  const box = $('accountChips');
  box.innerHTML = '';
  const accs = accountsList();
  if (!accs.length) {
    box.innerHTML = '<p class="hint">Aucun compte déclaré par le PC pour l’instant.</p>';
    return;
  }
  if (!accs.some((a) => a.login === form.account)) form.account = accs.length === 1 ? accs[0].login : '';
  for (const a of accs) {
    box.appendChild(
      chip(`@${a.login}`, form.account === a.login, () => {
        form.account = a.login;
        LS.set('lastAccount', a.login);
        renderAccountChips();
      }, `<span class="dot ${onlineClass(a)}"></span>`),
    );
  }
}

function renderRayonChips() {
  const box = $('rayonChips');
  box.innerHTML = '';
  for (const [value, label] of [['', 'Auto'], ['Femmes', 'Femme'], ['Hommes', 'Homme'], ['Enfants', 'Enfant'], ['Maison', 'Maison']]) {
    box.appendChild(
      chip(label, form.rayon === value, () => {
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
  box.appendChild(chip('Auto', !form.condition, () => ((form.condition = ''), renderConditionChips())));
  for (const c of CONDITIONS) box.appendChild(chip(c.name, form.condition === c.name, () => ((form.condition = c.name), renderConditionChips())));
}

$('price').addEventListener('input', () => {
  const raw = $('price').value.trim();
  const n = parsePrice(raw);
  $('priceCheck').textContent = !raw ? '' : n ? `Prix sur Vinted : ${formatPriceFR(n)}` : 'Prix invalide (ex : 15 ou 12,50)';
});

$('sendBtn').addEventListener('click', async () => {
  const status = $('sendStatus');
  const price = parsePrice($('price').value);
  if (!form.photos.length) return msg(status, 'Ajoute au moins une photo.', 'err');
  if (!price) return msg(status, 'Indique le prix.', 'err');
  if (!form.account) return msg(status, 'Choisis le compte Vinted.', 'err');
  $('sendBtn').disabled = true;
  try {
    msg(status, 'Envoi…');
    const thumb = (await toJpeg(form.photos[0].dataUrl, { maxSide: 160, quality: 0.7 })).dataUrl;
    const hints = {
      rayon: form.rayon,
      brand: $('brand').value.trim(),
      size: $('size').value.trim(),
      condition: form.condition,
      notes: $('notes').value.trim(),
      labelIndexes: form.photos.map((p, i) => (p.isLabel ? i : -1)).filter((i) => i >= 0),
    };
    for (const k of Object.keys(hints)) if (hints[k] === '' || (Array.isArray(hints[k]) && !hints[k].length)) delete hints[k];
    await relay.createJob({
      account: form.account,
      price: String(price),
      hints,
      photos: form.photos.map((p) => ({ base64: p.base64 })),
      thumb,
      createdBy: 'phone',
      onProgress: (d, t) => msg(status, `Envoi des photos ${d}/${t}…`),
    });
    toast(`Envoyé à @${form.account} ✅ Le PC s'en occupe.`);
    openNew(); // prêt pour l'article suivant (compte et rayon conservés)
    void refresh({ quiet: true });
  } catch (err) {
    msg(status, err.message, 'err');
  } finally {
    $('sendBtn').disabled = false;
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
    msg($('setupStatus'), err.message, 'err');
    return;
  }
  renderHello();
  show('homeView');
  void refresh();
  startPolling();
}

start();
