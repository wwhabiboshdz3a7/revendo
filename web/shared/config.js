/**
 * Revendo — « code de connexion » : la config du relais GitHub (+ clé IA
 * éventuelle) empaquetée en une chaîne à coller dans les autres profils
 * Chrome ou à ouvrir sur le téléphone (lien #c=… / QR code).
 * À traiter comme un mot de passe.
 */
import { base64ToUtf8, utf8ToBase64 } from './relay.js';

const PREFIX = 'REV1.';

export const DEFAULT_RELAY = { owner: 'wwhabiboshdz3a7', repo: 'revendo', branch: 'main', token: '' };

export function encodeConnection(cfg) {
  const payload = {
    v: 1,
    gh: { owner: cfg.relay.owner, repo: cfg.relay.repo, branch: cfg.relay.branch || 'main', token: cfg.relay.token },
  };
  if (cfg.ai?.key) payload.ai = { preset: cfg.ai.preset || 'gemini', key: cfg.ai.key, baseUrl: cfg.ai.baseUrl || '', model: cfg.ai.model || '' };
  if (cfg.name) payload.name = cfg.name;
  const b64 = utf8ToBase64(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return PREFIX + b64;
}

export function decodeConnection(code) {
  const raw = String(code || '').trim().replace(/^.*#c=/, '');
  if (!raw.startsWith(PREFIX)) throw new Error('Code de connexion invalide (il doit commencer par REV1.).');
  let b64 = raw.slice(PREFIX.length).replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  let payload;
  try {
    payload = JSON.parse(base64ToUtf8(b64));
  } catch (_e) {
    throw new Error('Code de connexion abîmé (copie-le en entier).');
  }
  if (!payload?.gh?.owner || !payload.gh.repo || !payload.gh.token) throw new Error('Code de connexion incomplet.');
  return {
    relay: { owner: payload.gh.owner, repo: payload.gh.repo, branch: payload.gh.branch || 'main', token: payload.gh.token },
    ai: payload.ai ? { preset: payload.ai.preset || 'gemini', key: payload.ai.key || '', baseUrl: payload.ai.baseUrl || '', model: payload.ai.model || '' } : null,
    name: payload.name || '',
  };
}

export function phoneLink(webUrl, code) {
  const base = String(webUrl || '').trim().replace(/#.*$/, '').replace(/\/?$/, '/');
  return `${base}#c=${code}`;
}
