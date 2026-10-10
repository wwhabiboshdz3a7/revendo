/**
 * Revendo — réglages, état du robot et journal (chrome.storage.local).
 */

export const DEFAULT_SETTINGS = {
  relay: { owner: 'wwhabiboshdz3a7', repo: 'revendo', branch: 'main', token: '' },
  worker: {
    enabled: true, // traiter automatiquement les annonces envoyées depuis le téléphone
    autoSave: true, // cliquer « Sauvegarder le brouillon » (jamais « Ajouter »)
    closeTab: true, // fermer l'onglet quand le brouillon est enregistré
    ocr: true, // lecture des étiquettes (marque, taille, composition) sur les photos
    defaultCondition: 'Très bon état',
  },
  profile: { name: 'Elias', signature: 'Elias', hashtags: 80 },
  webUrl: '',
};

function deepMerge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' ? { ...base[k], ...v } : v;
  }
  return out;
}

export async function getSettings() {
  const { rv_settings } = await chrome.storage.local.get('rv_settings');
  const s = deepMerge(DEFAULT_SETTINGS, rv_settings || {});
  delete s.ai; // ancienne clé IA (versions ≤ 3.3) : plus utilisée
  return s;
}

export async function saveSettings(patch) {
  const cur = await getSettings();
  const next = deepMerge(cur, patch);
  delete next.ai;
  await chrome.storage.local.set({ rv_settings: next });
  return next;
}

export function relayConfigured(s) {
  return !!(s.relay?.owner && s.relay?.repo && s.relay?.token);
}

export async function getAccount() {
  const { rv_account } = await chrome.storage.local.get('rv_account');
  return rv_account || null;
}

export async function setAccount(acc) {
  await chrome.storage.local.set({ rv_account: acc });
}

export async function getWorkerState() {
  const { rv_worker } = await chrome.storage.local.get('rv_worker');
  return rv_worker || { current: null, lastPollAt: 0, lastError: '', processed: 0, lastHeartbeat: 0 };
}

export async function setWorkerState(patch) {
  const cur = await getWorkerState();
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ rv_worker: next });
  return next;
}

/** Journal (50 dernières lignes) visible dans le dashboard. */
export async function log(level, message, extra = {}) {
  const { rv_log = [] } = await chrome.storage.local.get('rv_log');
  rv_log.unshift({ at: Date.now(), level, message, ...extra });
  await chrome.storage.local.set({ rv_log: rv_log.slice(0, 50) });
  (level === 'error' ? console.warn : console.log)('[Revendo]', message, extra);
}

/** Contexte d'un onglet de remplissage (survit à un redémarrage du service worker). */
export async function setTabJob(tabId, ctx) {
  await chrome.storage.local.set({ [`rv_tab_${tabId}`]: ctx });
}

export async function getTabJob(tabId) {
  const key = `rv_tab_${tabId}`;
  const res = await chrome.storage.local.get(key);
  return res[key] || null;
}

export async function clearTabJob(tabId) {
  await chrome.storage.local.remove(`rv_tab_${tabId}`);
}
