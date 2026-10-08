/**
 * Revendo — service worker (Manifest V3, module).
 * Branche les événements Chrome sur le robot (jobs.js) et sert les messages
 * du content script Vinted et du dashboard.
 */
import * as cdp from './cdp.js';
import * as jobs from './jobs.js';
import { analyzePhotos, composeListing } from './recognize.js';
import * as store from './store.js';

const DASHBOARD = 'dashboard/dashboard.html';
const VINTED_RX = /^https:\/\/(www\.)?vinted\.(fr|com|de|es|it|pt|nl|be|co\.uk|pl|at|lu)\//;

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------

function ensureAlarm() {
  chrome.alarms.get('rv-poll', (a) => {
    if (!a) chrome.alarms.create('rv-poll', { periodInMinutes: 0.5, delayInMinutes: 0.1 });
  });
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  ensureAlarm();
  if (reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL(`${DASHBOARD}#reglages`) });
});
chrome.runtime.onStartup.addListener(ensureAlarm);
ensureAlarm();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'rv-poll') void jobs.pollOnce();
});

chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL(DASHBOARD);
  const [existing] = await chrome.tabs.query({ url: `${url}*` });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
});

// Détection du compte Vinted connecté dans ce profil + fin d'enregistrement
// d'un brouillon quand Vinted quitte la page /items/new.
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url && !/\/items\/new/.test(info.url)) void jobs.onTabLeftForm(tabId);
  if (info.status !== 'complete' || !tab.url || !VINTED_RX.test(tab.url)) return;
  if (/\/(member\/)?(login|signup|session)/.test(new URL(tab.url).pathname)) return;
  void jobs.detectAccount(tabId, tab.url);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void jobs.onTabRemoved(tabId);
});

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

const handlers = {
  // --- content script (onglet de remplissage) ---
  async RV_TAB_JOB(_msg, sender) {
    const ctx = sender.tab?.id ? await store.getTabJob(sender.tab.id) : null;
    if (!ctx || ctx.started) return { job: null };
    const { photos, ...rest } = ctx;
    return { job: { ...rest.listing, origin: rest.origin, jobId: rest.jobId, account: rest.account, photoCount: photos.length } };
  },
  async RV_STARTED(_msg, sender) {
    const ctx = await store.getTabJob(sender.tab.id);
    if (ctx) await store.setTabJob(sender.tab.id, { ...ctx, started: true });
    return { ok: true };
  },
  async RV_SAVING(msg, sender) {
    const ctx = await store.getTabJob(sender.tab.id);
    if (ctx) await store.setTabJob(sender.tab.id, { ...ctx, pendingResult: msg.result, savingAt: Date.now() });
    return { ok: true };
  },
  async RV_TAB_PHOTOS(msg, sender) {
    const ctx = await store.getTabJob(sender.tab.id);
    if (!ctx) return { photos: [] };
    const from = Math.max(0, msg.from | 0);
    return { photos: ctx.photos.slice(from, from + Math.max(1, msg.count | 0)) };
  },
  async RV_CDP(msg, sender) {
    const tabId = sender.tab?.id;
    if (!tabId || !(await store.getTabJob(tabId))) return { ok: false, error: 'onglet non autorisé' };
    if (msg.op === 'attach') await cdp.attach(tabId);
    else if (msg.op === 'detach') await cdp.detach(tabId);
    else if (msg.op === 'click') await cdp.click(tabId, msg.x, msg.y);
    else if (msg.op === 'key') await cdp.key(tabId, msg.key);
    else if (msg.op === 'insert') await cdp.insertText(tabId, msg.text, { perKey: !!msg.perKey });
    return { ok: true };
  },
  async RV_FOCUS(_msg, sender) {
    if (sender.tab?.id) {
      await chrome.tabs.update(sender.tab.id, { active: true });
      await chrome.windows.update(sender.tab.windowId, { focused: true });
    }
    return { ok: true };
  },
  async RV_WHOAMI(_msg, sender) {
    return jobs.whoAmI(sender.tab.id);
  },
  async RV_COMPOSE(msg, sender) {
    const ctx = await store.getTabJob(sender.tab.id);
    if (!ctx) return { ok: false };
    const s = await store.getSettings();
    const listing = composeListing({ ...ctx.listing, title: '' }, s, { categoryName: msg.categoryName || '', photoCount: ctx.photos.length });
    ctx.listing = { ...ctx.listing, title: listing.title, description: listing.description, seo: listing.seo };
    await store.setTabJob(sender.tab.id, ctx);
    return { ok: true, title: listing.title, description: listing.description };
  },
  async RV_TAB_RESULT(msg, sender) {
    await jobs.finalizeTab(sender.tab.id, msg.result || {});
    return { ok: true };
  },

  // --- dashboard ---
  async RV_ANALYZE(msg) {
    const s = await store.getSettings();
    const photos = (msg.photos || []).map((d) => ({ base64: String(d).split(',')[1], mime: 'image/jpeg' }));
    const { fields, recognition } = await analyzePhotos({ photos, hints: msg.hints || {}, settings: s });
    return { ok: true, fields, recognition };
  },
  async RV_RUN_MANUAL(msg) {
    const photos = (msg.photos || []).map((d, i) => ({ name: `${i + 1}.jpg`, base64: String(d).split(',')[1], mime: 'image/jpeg' }));
    await jobs.startManualJob({ listing: msg.listing, photos });
    return { ok: true };
  },
  async RV_POLL_NOW() {
    return jobs.pollOnce({ force: true });
  },
  async RV_DETECT_ACCOUNT() {
    const tabs = await chrome.tabs.query({});
    const vt = tabs.find((t) => t.url && VINTED_RX.test(t.url));
    if (!vt) {
      await chrome.tabs.create({ url: 'https://www.vinted.fr/', active: true });
      return { ok: false, opened: true };
    }
    const acc = await jobs.detectAccount(vt.id, vt.url, { force: true });
    return { ok: !!acc?.id, account: acc };
  },
  async RV_ANNOUNCE() {
    await jobs.announceNow();
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen') return false;
  const handler = handlers[msg.type];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(msg, sender))
    .then((res) => sendResponse(res ?? { ok: true }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true;
});
