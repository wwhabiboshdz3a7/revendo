/**
 * Revendo — le « robot » du PC :
 *   1. regarde toutes les 30 s s'il y a une annonce envoyée depuis le
 *      téléphone pour LE compte Vinted connecté dans ce profil Chrome ;
 *   2. la réserve (aucun autre PC ne peut la prendre) ;
 *   3. reconnaît l'article sans IA (étiquettes, couleurs, indices) et compose l'annonce ;
 *   4. ouvre Vinted dans une fenêtre dédiée, le content script remplit et
 *      clique « Sauvegarder le brouillon » (jamais « Ajouter ») ;
 *   5. écrit le résultat pour le téléphone et supprime les photos du relais.
 * L'état est gardé dans chrome.storage : un redémarrage du service worker
 * en plein remplissage ne perd rien.
 */
import { base64ToBlob, toJpegTarget } from '../shared/image.js';
import { GitHubRelay, safeLogin } from '../shared/relay.js';
import { analyzePhotos, composeListing } from './recognize.js';
import * as cdp from './cdp.js';
import * as store from './store.js';

const VERSION = chrome.runtime.getManifest().version;
// Large : attente des envois de photos (jusqu'à ~2 min + 90 s) et pages Vinted lentes.
const MAX_FILL_MS = 12 * 60 * 1000;
const SHRINK_ABOVE = 600 * 1024; // au-delà (octets JPEG), la photo est réencodée
const SHRINK_TARGET = { maxSide: 1600, maxBytes: 400 * 1024 };

let pollBusy = false;
let relayCache = { key: '', relay: null };

export function getRelay(settings) {
  const key = JSON.stringify(settings.relay);
  if (relayCache.key !== key) relayCache = { key, relay: new GitHubRelay(settings.relay) };
  return relayCache.relay;
}

function keepAlive() {
  const t = setInterval(() => chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError), 20000);
  return () => clearInterval(t);
}

async function tabExists(tabId) {
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch (_e) {
    return false;
  }
}

/** Taille réelle (octets) des données d'une chaîne base64. */
const dataBytes = (b64) => Math.floor((String(b64 || '').length * 3) / 4);

/**
 * Allège les photos trop lourdes (iPhone : ~900 Ko chacune) avant de les
 * donner à Vinted : réencodage JPEG visé à 400 Ko, 3 photos à la fois. En cas
 * d'échec, la photo d'origine est gardée. Renvoie un NOUVEAU tableau.
 */
export async function shrinkPhotos(photos, { onShrunk } = {}) {
  const out = [...(photos || [])];
  let next = 0;
  const worker = async () => {
    while (next < out.length) {
      const i = next;
      next += 1;
      const p = out[i];
      const before = dataBytes(p?.base64);
      if (before <= SHRINK_ABOVE) continue;
      try {
        const r = await toJpegTarget(base64ToBlob(p.base64, p.mime || 'image/jpeg'), SHRINK_TARGET);
        if (r.base64 && r.bytes < before) {
          out[i] = { ...p, base64: r.base64, mime: 'image/jpeg' };
          onShrunk?.(before, r.bytes);
        }
      } catch (err) {
        console.warn('[Revendo] compression photo', i + 1, err);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, out.length) }, worker));
  return out;
}

/** shrinkPhotos + une ligne de journal si des photos ont été allégées. */
async function shrinkAndLog(photos, label) {
  let count = 0;
  let from = 0;
  let to = 0;
  const out = await shrinkPhotos(photos, {
    onShrunk: (a, b) => {
      count += 1;
      from += a;
      to += b;
    },
  });
  if (count) {
    const ko = (n) => Math.round(n / 1024);
    await store.log('info', `${label} : ${count} photo${count > 1 ? 's' : ''} allégée${count > 1 ? 's' : ''} (${ko(from)} → ${ko(to)} Ko)`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Compte Vinted de ce profil
// ---------------------------------------------------------------------------

const lastDetect = new Map();

/** Interroge Vinted (dans l'onglet, avec la session de l'utilisateur) : qui est connecté ? */
export async function whoAmI(tabId) {
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async () => {
      try {
        const r = await fetch('/api/v2/users/current', { credentials: 'include', headers: { Accept: 'application/json' } });
        if (r.status === 401 || r.status === 403) return { loggedOut: true };
        if (!r.ok) return { error: `HTTP ${r.status}` };
        const body = await r.json();
        const u = body?.user ?? body;
        return u?.id ? { id: String(u.id), login: String(u.login || u.username || '') } : { error: 'réponse inattendue' };
      } catch (e) {
        return { error: String(e?.message || e) };
      }
    },
  });
  return result || { error: 'pas de résultat' };
}

export async function detectAccount(tabId, url, { force = false } = {}) {
  const now = Date.now();
  if (!force && now - (lastDetect.get(tabId) || 0) < 5 * 60 * 1000) return null;
  lastDetect.set(tabId, now);
  let info;
  try {
    info = await whoAmI(tabId);
  } catch (err) {
    return { error: err.message };
  }
  const domain = new URL(url).hostname;
  const prev = await store.getAccount();
  if (info.loggedOut) {
    if (prev) await store.setAccount({ ...prev, loggedOut: true, checkedAt: now });
    return info;
  }
  if (!info.id) return info;
  const acc = { id: info.id, login: info.login || `vinted-${info.id}`, domain, detectedAt: now, loggedOut: false };
  await store.setAccount(acc);
  if (!prev || prev.id !== acc.id || prev.loggedOut) {
    await store.log('info', `Compte Vinted détecté : @${acc.login} (${domain})`);
    await announceAccount(acc).catch((err) => store.log('error', `Enregistrement du compte : ${err.message}`));
  }
  return acc;
}

/** (Ré)enregistre le compte de ce profil dans le relais (bouton du dashboard). */
export async function announceNow() {
  const acc = await store.getAccount();
  if (!acc?.login) throw new Error('Aucun compte Vinted détecté dans ce profil : ouvre vinted.fr connecté.');
  await announceAccount(acc);
}

async function announceAccount(acc) {
  const s = await store.getSettings();
  if (!store.relayConfigured(s)) return;
  await getRelay(s).putAccount({ login: acc.login, userId: acc.id, domain: acc.domain, profile: s.profile.name, ext: VERSION });
  await store.setWorkerState({ lastHeartbeat: Date.now() });
}

// ---------------------------------------------------------------------------
// Boucle de traitement
// ---------------------------------------------------------------------------

export async function pollOnce({ force = false } = {}) {
  if (pollBusy) return { skipped: 'busy' };
  pollBusy = true;
  try {
    const s = await store.getSettings();
    if (!store.relayConfigured(s)) return { skipped: 'relay' };
    if (!s.worker.enabled && !force) return { skipped: 'disabled' };
    const account = await store.getAccount();
    if (!account?.login) return { skipped: 'account' };
    if (account.loggedOut) return { skipped: 'logged-out' };

    const ws = await store.getWorkerState();
    if (ws.current) {
      const age = Date.now() - ws.current.startedAt;
      const alive = ws.current.tabId ? await tabExists(ws.current.tabId) : ws.current.phase === 'recognizing';
      const limit = ws.current.tabId ? MAX_FILL_MS : 6 * 60 * 1000; // lecture des étiquettes : ~1 min, rarement plus
      if (age < limit && alive) return { skipped: 'running' };
      await failCurrent(ws.current, alive ? 'Délai dépassé pendant le remplissage.' : 'Remplissage interrompu (onglet fermé).');
    }

    const relay = getRelay(s);
    if (Date.now() - (ws.lastHeartbeat || 0) > 30 * 60 * 1000) await announceAccount(account);

    // On ne relit l'arborescence que si la branche a bougé depuis notre dernier
    // examen complet (nos propres commits comptent aussi : le téléphone a pu
    // écrire juste avant). Une tête inchangée coûte un simple « 304 ».
    const { sha } = await relay.headSha();
    if (!force && sha === ws.lastScannedSha && !(ws.lastPendingCount > 0)) {
      await store.setWorkerState({ lastPollAt: Date.now(), lastError: '' });
      return { skipped: 'unchanged' };
    }
    const pending = await relay.pendingJobsFor(account.login);
    await store.setWorkerState({ lastPollAt: Date.now(), lastError: '', lastPendingCount: pending.length, lastScannedSha: sha });
    if (!pending.length) return { idle: true };

    const job = pending[0];
    const claimed = await relay.claimJob(job, { login: account.login, ext: VERSION, profile: s.profile.name });
    if (!claimed) return { skipped: 'claimed-elsewhere' };
    await startRelayJob(relay, job, s, account);
    return { started: job.id };
  } catch (err) {
    await store.setWorkerState({ lastError: err.message, lastPollAt: Date.now() });
    if (err.code !== 'rate' && err.code !== 'network') await store.log('error', `Relais : ${err.message}`);
    return { error: err.message };
  } finally {
    pollBusy = false;
  }
}

async function startRelayJob(relay, job, settings, account) {
  const stop = keepAlive();
  await store.setWorkerState({ current: { origin: 'relay', jobId: job.id, jobAccount: job.account, phase: 'recognizing', startedAt: Date.now() } });
  await store.log('info', `Annonce ${job.id} : prise en charge pour @${account.login}`);
  let data = null;
  try {
    const read = await relay.readJob(job);
    data = read.data;
    const originals = read.photos.map((p) => ({ name: p.name, base64: p.base64, mime: 'image/jpeg' }));
    // La lecture des étiquettes se fait sur les photos d'origine (plus nettes) ;
    // seules les versions allégées partent sur Vinted. Les deux en parallèle.
    const shrinking = shrinkAndLog(originals, `Annonce ${job.id}`);
    const hints = { ...(data.hints || {}), price: data.price };
    const { fields, recognition } = await analyzePhotos({ photos: originals, hints, settings });
    const photos = await shrinking;
    const listing = composeListing(fields, settings, { photoCount: photos.length });
    if (hints.description) listing.description = hints.description; // texte déjà relu sur le PC
    await openFillTab({
      origin: 'relay',
      jobId: job.id,
      jobAccount: job.account,
      thumb: data.thumb || '',
      listing: { ...listing, price: data.price, autoSave: settings.worker.autoSave, composeAfterCategory: !fields.category, recognition },
      photos,
      account,
    });
  } catch (err) {
    await store.log('error', `Annonce ${job.id} : ${err.message}`);
    await relay
      .finishJob(job, { state: 'error', message: err.message, thumb: data?.thumb || '', account: job.account, worker: { login: account.login, ext: VERSION } }, { deleteFiles: false })
      .catch(() => null);
    await store.setWorkerState({ current: null });
  } finally {
    stop();
  }
}

/** Remplissage direct depuis le dashboard du PC (pas de relais). */
export async function startManualJob({ listing, photos }) {
  const ws = await store.getWorkerState();
  if (ws.current && (await tabExists(ws.current.tabId || -1))) throw new Error('Un remplissage est déjà en cours, attends la fin.');
  const s = await store.getSettings();
  const account = (await store.getAccount()) || { login: '', domain: 'www.vinted.fr' };
  const jobId = `manuel-${Date.now()}`;
  await store.setWorkerState({ current: { origin: 'manual', jobId, phase: 'recognizing', startedAt: Date.now() } });
  try {
    await openFillTab({
      origin: 'manual',
      jobId,
      listing: { ...listing, autoSave: listing.autoSave ?? s.worker.autoSave, composeAfterCategory: !listing.category },
      photos: await shrinkAndLog(photos, 'Annonce manuelle'),
      account,
    });
  } catch (err) {
    await store.setWorkerState({ current: null });
    throw err;
  }
}

async function openFillTab({ origin, jobId, jobAccount = '', thumb = '', listing, photos, account }) {
  const domain = account.domain || 'www.vinted.fr';
  const win = await chrome.windows.create({ url: `https://${domain}/items/new`, focused: true, type: 'normal', width: 1280, height: 1000 });
  const tab = win.tabs?.[0];
  if (!tab?.id) throw new Error("Impossible d'ouvrir Vinted.");
  chrome.tabs.setZoom(tab.id, 1).catch(() => null);
  await store.setTabJob(tab.id, {
    origin,
    jobId,
    jobAccount,
    thumb,
    listing,
    photos,
    account: { id: account.id || '', login: account.login || '', domain },
    windowId: win.id,
    startedAt: Date.now(),
  });
  await store.setWorkerState({ current: { origin, jobId, jobAccount, phase: 'filling', tabId: tab.id, windowId: win.id, startedAt: Date.now() } });
}

// ---------------------------------------------------------------------------
// Fin de remplissage
// ---------------------------------------------------------------------------

export async function finalizeTab(tabId, result) {
  const ctx = await store.getTabJob(tabId);
  if (!ctx) return;
  await store.clearTabJob(tabId);
  await cdp.detach(tabId);
  const s = await store.getSettings();
  const saved = !!result?.draftSaved;
  const ok = !!result?.ok && (saved || !ctx.listing.autoSave);
  const missing = (result?.fields || []).filter((f) => !f.ok).map((f) => f.label);
  const message = ok
    ? saved
      ? `Brouillon enregistré sur @${ctx.account.login || 'Vinted'}${missing.length ? ` — à compléter : ${missing.join(', ')}` : ''}`
      : 'Formulaire rempli (brouillon à enregistrer à la main).'
    : result?.message || 'Le brouillon n’a pas pu être enregistré.';
  const recognition = ctx.listing.recognition || {};
  const ocrError = recognition.ocr?.error || '';
  const found = { ...(recognition.found || {}) };
  if (ctx.listing.brandFrom === 'vinted') found.brand = 'vinted';
  const status = {
    state: ok ? 'done' : 'error',
    message,
    draftSaved: saved,
    draftConfirmed: !!result?.draftConfirmed,
    account: ctx.jobAccount || safeLogin(ctx.account.login),
    thumb: ctx.thumb,
    summary: {
      title: result?.title || ctx.listing.title,
      category: result?.category || ctx.listing.category,
      brand: ctx.listing.brand,
      size: ctx.listing.size,
      colors: ctx.listing.colors,
      condition: ctx.listing.condition,
      price: ctx.listing.price,
      mode: recognition.mode || '',
      found,
      ocrError,
      photos: { sent: ctx.photos?.length || 0, shown: shownPhotos(result, ctx.photos?.length || 0) },
      seo: ctx.listing.seo?.score ?? null,
      seoTodo: ctx.listing.seo?.todo || [],
    },
    fields: result?.fields || [],
    worker: { login: ctx.account.login, ext: VERSION, profile: s.profile.name },
    finishedAt: new Date().toISOString(),
  };
  if (ctx.origin === 'relay') {
    try {
      await getRelay(s).finishJob({ id: ctx.jobId, account: ctx.jobAccount }, status, { deleteFiles: ok });
    } catch (err) {
      await store.log('error', `Impossible d'écrire le résultat (${err.message}).`);
    }
  }
  await chrome.storage.local.set({ rv_last_result: { ...status, jobId: ctx.jobId, origin: ctx.origin, at: Date.now() } });
  const ws = await store.getWorkerState();
  await store.setWorkerState({ current: null, processed: (ws.processed || 0) + (ok ? 1 : 0) });
  const ocrNote = ocrError ? ` — lecture des étiquettes impossible (${ocrError})` : '';
  await store.log(ok ? 'info' : 'error', `${ctx.origin === 'relay' ? `Annonce ${ctx.jobId}` : 'Annonce manuelle'} : ${message}${ocrNote}`);
  if (ok && saved && s.worker.closeTab) {
    setTimeout(() => {
      chrome.windows.remove(ctx.windowId).catch(() => chrome.tabs.remove(tabId).catch(() => null));
    }, 2500);
  }
  setTimeout(() => void pollOnce(), 4000);
}

/**
 * Photos réellement visibles sur Vinted : compteur renvoyé par le content
 * script, sinon le « x/y » de la ligne « Photos » (résultat gardé avant un
 * rechargement), sinon 0.
 */
export function shownPhotos(result, sent) {
  const n = result?.photos?.shown;
  if (typeof n === 'number' && Number.isFinite(n) && n >= 0) return Math.min(n, sent || n);
  const line = (result?.fields || []).find((f) => f.label === 'Photos');
  const m = /(\d+)\s*\/\s*\d+/.exec(line?.detail || '');
  return m ? Math.min(Number(m[1]), sent || Number(m[1])) : 0;
}

async function failCurrent(current, message) {
  if (current.tabId) {
    const ctx = await store.getTabJob(current.tabId);
    if (ctx) {
      await finalizeTab(current.tabId, ctx.pendingResult || { ok: false, message });
      return;
    }
  }
  if (current.origin === 'relay' && current.jobId) {
    const s = await store.getSettings();
    await getRelay(s)
      .finishJob({ id: current.jobId, account: current.jobAccount }, { state: 'error', message }, { deleteFiles: false })
      .catch(() => null);
  }
  await store.setWorkerState({ current: null });
  await store.log('error', message);
}

export async function onTabRemoved(tabId) {
  const ctx = await store.getTabJob(tabId);
  if (!ctx) return;
  if (ctx.pendingResult) await finalizeTab(tabId, ctx.pendingResult);
  else await finalizeTab(tabId, { ok: false, message: "L'onglet Vinted a été fermé avant la fin." });
}

/** Vinted a quitté /items/new juste après « Sauvegarder le brouillon » : c'est enregistré. */
export async function onTabLeftForm(tabId) {
  const ctx = await store.getTabJob(tabId);
  if (ctx?.pendingResult) await finalizeTab(tabId, { ...ctx.pendingResult, draftConfirmed: true });
}
