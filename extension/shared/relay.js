/**
 * Revendo — relais téléphone ⇄ PC stocké dans un dépôt GitHub (privé ou
 * public : les photos n'y restent que le temps du traitement).
 *
 * Chaque écriture est UN commit atomique (API Git Data : blobs → tree →
 * commit → mise à jour de la branche en fast-forward). Si un autre appareil
 * a commité entre-temps, GitHub refuse la mise à jour (422) et on recommence
 * à partir de la nouvelle tête : c'est un « compare-and-swap » qui garantit
 * qu'un job n'est jamais pris par deux PC à la fois.
 *
 * Arborescence de la branche :
 *   accounts/<login>.json              ← déclaré par l'extension de chaque profil Chrome
 *   jobs/<login>/<jobId>/job.json      ← créé par le téléphone (prix, indices, miniature)
 *   jobs/<login>/<jobId>/01.jpg …      ← photos
 *   status/<jobId>.json                ← écrit par le PC (processing / done / error / retry)
 *   locks/robot.json                   ← verrou : UN seul profil remplit Vinted à la fois
 *
 * Verrou du robot : plusieurs profils Chrome (un par compte Vinted) tournent
 * sur le même PC. Quand deux remplissaient Vinted en même temps, les fenêtres
 * se volaient le focus et le processeur (lecture d'étiquettes), et Vinted
 * refusait les photos ou ne chargeait pas le formulaire. Le verrou est pris
 * dans le MÊME commit que la réservation du job (atomique), libéré dans le
 * commit de fin, et expire seul si un profil plante.
 *
 * Fonctionne dans un navigateur, une page d'extension, un service worker et Node.
 */

export class RelayError extends Error {
  constructor(message, { code = 'error', status = 0 } = {}) {
    super(message);
    this.name = 'RelayError';
    this.code = code;
    this.status = status;
  }
}

export class ConflictError extends RelayError {
  constructor(message) {
    super(message, { code: 'conflict' });
    this.name = 'ConflictError';
  }
}

/** Le robot est occupé par un autre profil (verrou actif). */
export class LockedError extends ConflictError {
  constructor(lock) {
    super(`robot occupé par @${lock?.holder || '?'}`);
    this.name = 'LockedError';
    this.lock = lock;
  }
}

export const LOCK_PATH = 'locks/robot.json';
/**
 * Durée du verrou : renouvelé à l'ouverture de Vinted et à chaque nouvel essai
 * de page. Si le profil qui le tient plante (Chrome fermé), les autres
 * reprennent la main au plus tard après ce délai.
 */
export const LOCK_TTL_MS = 15 * 60 * 1000;

/**
 * Verrou rendu alors qu'un autre profil attendait : il lui reste réservé ce
 * temps-là (il relit la file toutes les 30 s), pour qu'un profil qui enchaîne
 * ses annonces ne reprenne pas le verrou à chaque fois (famine).
 */
export const LOCK_HANDOFF_MS = 75 * 1000;
/** Un profil en attente qui ne s'est pas manifesté depuis ce délai ne compte plus (profil fermé). */
export const WAITER_TTL_MS = 3 * 60 * 1000;

const iso = (t) => new Date(t).toISOString();

/** Verrou encore valable et tenu — ou réservé — par quelqu'un d'autre ? */
export function lockedByOther(lock, me, now = Date.now()) {
  if (!lock || !(Date.parse(lock.until || 0) > now)) return false;
  if (lock.holder) return lock.holder !== me;
  return !!lock.reservedFor && lock.reservedFor !== me;
}

/** Entrée de la file : { since: attend depuis, seen: dernier signe de vie } (ancienne forme : une date). */
const waiterTimes = (v) => (typeof v === 'string' ? { since: v, seen: v } : { since: v?.since || '', seen: v?.seen || v?.since || '' });

/**
 * Profils en attente encore vivants (signe de vie de moins de 3 min), de celui
 * qui attend depuis le plus longtemps au plus récent : [[login, { since, seen }]].
 */
export function liveWaiters(lock, now = Date.now(), exclude = []) {
  return Object.entries(lock?.waiters || {})
    .map(([login, v]) => [login, waiterTimes(v)])
    .filter(([login, t]) => login && !exclude.includes(login) && now - Date.parse(t.seen || 0) < WAITER_TTL_MS)
    .sort((a, b) => Date.parse(a[1].since) - Date.parse(b[1].since));
}

/** Verrou rendu : supprimé, ou réservé au profil qui attend depuis le plus longtemps. */
function releasedLock(lock, now) {
  const waiters = liveWaiters(lock, now, [lock?.holder]);
  if (!waiters.length) return { path: LOCK_PATH, delete: true };
  const [[next], ...rest] = waiters;
  const handoff = { holder: '', reservedFor: next, jobId: '', at: iso(now), until: iso(now + LOCK_HANDOFF_MS), waiters: Object.fromEntries(rest) };
  return { path: LOCK_PATH, content: JSON.stringify(handoff, null, 2) };
}

/** Statut « nouvel essai automatique » dont l'heure est venue : le job redevient en attente. */
export function retryDue(status, now = Date.now()) {
  return status?.state === 'retry' && Date.parse(status.retryAt || 0) <= now;
}

/**
 * Statut « en cours » abandonné par ce profil : le PC a planté, ou le statut
 * final n'a jamais pu être écrit (réseau coupé au mauvais moment). Plus vieux
 * que la durée du verrou et plus couvert par un verrou valable → à reprendre.
 * (Le robot ne regarde la file que lorsqu'il ne remplit rien lui-même.)
 */
export function staleProcessing(status, lock, me, now = Date.now(), staleMs = LOCK_TTL_MS) {
  if (status?.state !== 'processing' || !me || status.worker?.login !== me) return false;
  if (now - Date.parse(status.updatedAt || status.startedAt || 0) <= staleMs) return false;
  return !(lock && lock.jobId === status.id && Date.parse(lock.until || 0) > now);
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function utf8ToBase64(str) {
  const bytes = enc.encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function base64ToUtf8(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return dec.decode(bytes);
}

export function safeLogin(login) {
  return String(login || '')
    .trim()
    .replace(/[^a-zA-Z0-9_.-]/g, '_')
    .slice(0, 60);
}

/** Identifiant triable : 20261001-153012-k3f9 (UTC). */
export function newJobId(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}-${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}`;
  const rnd = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
  return `${stamp}-${rnd}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Applique `fn` à chaque élément avec au plus `limit` appels simultanés.
 * Les résultats gardent l'ordre des éléments. À la première erreur, plus
 * aucun nouvel appel n'est lancé et l'erreur est propagée.
 */
export async function mapLimit(items, limit, fn) {
  const list = [...(items || [])];
  const out = new Array(list.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < list.length) {
      const i = next;
      next += 1;
      try {
        out[i] = await fn(list[i], i);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, list.length)) }, worker));
  return out;
}

/** Erreur passagère (réseau coupé, GitHub 5xx) : un nouvel essai a des chances de passer. */
export function isTransient(err) {
  return err instanceof RelayError && (err.code === 'network' || err.status >= 500);
}

export class GitHubRelay {
  constructor({ owner, repo, branch = 'main', token, fetchImpl, apiBase = 'https://api.github.com', retryDelayMs = 800 } = {}) {
    if (!owner || !repo || !token) throw new RelayError('Relais incomplet (propriétaire, dépôt ou token manquant).', { code: 'config' });
    this.owner = owner.trim();
    this.repo = repo.trim();
    this.branch = (branch || 'main').trim();
    this.token = token.trim();
    this.apiBase = apiBase.replace(/\/$/, '');
    this.fetch = fetchImpl || ((...a) => fetch(...a));
    this.refEtag = null;
    this.refSha = null;
    this.blobCache = new Map(); // sha → texte (fichiers JSON)
    this.treeOf = new Map(); // sha d'un commit → sha de son arbre (immuable)
    this.retryDelayMs = retryDelayMs; // attente avant le 1er nouvel essai d'un envoi de photo
  }

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  async api(method, path, body, { headers = {}, allow = [] } = {}) {
    const url = `${this.apiBase}/repos/${this.owner}/${this.repo}${path}`;
    let res;
    try {
      res = await this.fetch(url, {
        method,
        cache: 'no-store',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new RelayError(`Réseau indisponible (${err?.message || err}).`, { code: 'network' });
    }
    if (res.status === 304 || allow.includes(res.status)) return { status: res.status, res, data: null };
    let data = null;
    let text = '';
    try {
      text = await res.text();
    } catch (err) {
      throw new RelayError(`Réseau indisponible (${err?.message || err}).`, { code: 'network', status: res.status >= 500 ? res.status : 0 });
    }
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_e) {
      data = { message: text };
    }
    if (res.ok) return { status: res.status, res, data };
    const msg = data?.message || `HTTP ${res.status}`;
    if (res.status === 401) throw new RelayError('Token GitHub refusé (expiré ou mal copié).', { code: 'auth', status: 401 });
    if (res.status === 403 || res.status === 429) {
      const rate = /rate limit/i.test(msg) || res.headers?.get?.('x-ratelimit-remaining') === '0';
      throw new RelayError(
        rate ? 'Limite de requêtes GitHub atteinte, nouvel essai dans quelques minutes.' : `Accès refusé par GitHub : ${msg}. Le token doit avoir « Contents : Read and write » sur ce dépôt.`,
        { code: rate ? 'rate' : 'forbidden', status: res.status },
      );
    }
    if (res.status === 404) throw new RelayError(`Introuvable sur GitHub (${path}) : dépôt, branche ou droits du token ?`, { code: 'notfound', status: 404 });
    if (res.status === 409 && /empty/i.test(msg)) throw new RelayError('Dépôt vide.', { code: 'empty', status: 409 });
    if (res.status === 422 && /fast forward|fast-forward/i.test(msg)) throw new ConflictError('Conflit de mise à jour (un autre appareil a écrit en même temps).');
    throw new RelayError(`GitHub : ${msg}`, { code: 'http', status: res.status });
  }

  // -------------------------------------------------------------------------
  // Bas niveau Git
  // -------------------------------------------------------------------------

  /** Tête de branche. Utilise un ETag : un « 304 » ne consomme pas de quota. */
  async headSha({ useCache = true } = {}) {
    const headers = useCache && this.refEtag ? { 'If-None-Match': this.refEtag } : {};
    const { status, res, data } = await this.api('GET', `/git/ref/heads/${encodeURIComponent(this.branch)}`, null, { headers });
    if (status === 304 && this.refSha) return { sha: this.refSha, changed: false };
    const sha = data?.object?.sha;
    if (!sha) throw new RelayError('Réponse GitHub inattendue (branche).');
    this.refEtag = res.headers?.get?.('etag') || null;
    const changed = sha !== this.refSha;
    this.refSha = sha;
    return { sha, changed };
  }

  /** Sha de l'arbre d'un commit (1 requête, puis mis en cache : un commit ne change jamais). */
  async treeShaOf(commitSha) {
    if (this.treeOf.has(commitSha)) return this.treeOf.get(commitSha);
    const { data: commit } = await this.api('GET', `/git/commits/${commitSha}`);
    const treeSha = commit?.tree?.sha;
    if (!treeSha) throw new RelayError('Réponse GitHub inattendue (commit).');
    this.rememberTree(commitSha, treeSha);
    return treeSha;
  }

  rememberTree(commitSha, treeSha) {
    this.treeOf.set(commitSha, treeSha);
    if (this.treeOf.size > 200) this.treeOf.delete(this.treeOf.keys().next().value);
  }

  async treeOfCommit(commitSha) {
    const treeSha = await this.treeShaOf(commitSha);
    const { data: tree } = await this.api('GET', `/git/trees/${treeSha}?recursive=1`);
    if (tree.truncated) throw new RelayError('Dépôt trop volumineux : lance « Compacter l\'historique » dans les réglages.');
    const entries = new Map();
    for (const e of tree.tree || []) if (e.type === 'blob') entries.set(e.path, { sha: e.sha, size: e.size });
    return { commitSha, treeSha, entries };
  }

  async readBlobBase64(sha) {
    const { data } = await this.api('GET', `/git/blobs/${sha}`);
    return String(data?.content || '').replace(/\s/g, '');
  }

  async readJsonBlob(sha) {
    if (this.blobCache.has(sha)) return JSON.parse(this.blobCache.get(sha));
    const text = base64ToUtf8(await this.readBlobBase64(sha));
    this.blobCache.set(sha, text);
    if (this.blobCache.size > 500) this.blobCache.delete(this.blobCache.keys().next().value);
    return JSON.parse(text);
  }

  /**
   * Envoie une photo (base64) comme blob Git et renvoie son sha. Le téléphone
   * s'en sert pour envoyer chaque photo dès qu'elle est prête, avant même le
   * clic « Envoyer ». Deux nouveaux essais (attente croissante) si le réseau
   * coupe ou si GitHub répond 5xx ; les autres erreurs remontent tout de suite.
   */
  async uploadBlob(base64, { retries = 2 } = {}) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const { data } = await this.api('POST', '/git/blobs', { content: base64, encoding: 'base64' });
        if (!data?.sha) throw new RelayError('Réponse GitHub inattendue (photo).');
        return data.sha;
      } catch (err) {
        if (!isTransient(err) || attempt >= retries) throw err;
        await sleep(this.retryDelayMs * 2 ** attempt * (1 + Math.random() * 0.3));
      }
    }
  }

  /** Ancien nom de uploadBlob (gardé pour compatibilité). */
  createBlob(base64) {
    return this.uploadBlob(base64);
  }

  /**
   * Commit atomique avec retry. `build(snapshot)` reçoit l'état courant
   * ({ entries: Map(path → {sha}) }) et renvoie la liste des changements :
   *   { path, content }  (texte UTF-8) | { path, sha } (blob existant) | { path, delete: true }
   * Elle peut lever ConflictError pour annuler (ex. job déjà pris).
   * `needSnapshot: false` : `build` n'a pas besoin de l'arborescence (simple
   * ajout de fichiers) → on évite la lecture récursive de l'arbre, seul le sha
   * de l'arbre de la tête est lu (snapshot.entries vaut alors null et une
   * suppression est envoyée telle quelle : le chemin doit exister).
   */
  async commit(build, message, { attempts = 6, needSnapshot = true } = {}) {
    let lastErr = null;
    for (let i = 0; i < attempts; i += 1) {
      const { sha: head } = await this.headSha({ useCache: false });
      const snap = needSnapshot ? await this.treeOfCommit(head) : { commitSha: head, treeSha: await this.treeShaOf(head), entries: null };
      const changes = await build(snap);
      if (!changes || !changes.length) return { committed: false, snapshot: snap };
      const tree = [];
      for (const c of changes) {
        if (c.delete) {
          if (!snap.entries || snap.entries.has(c.path)) tree.push({ path: c.path, mode: '100644', type: 'blob', sha: null });
        } else if (c.sha) {
          tree.push({ path: c.path, mode: '100644', type: 'blob', sha: c.sha });
        } else {
          tree.push({ path: c.path, mode: '100644', type: 'blob', content: c.content });
        }
      }
      if (!tree.length) return { committed: false, snapshot: snap };
      const { data: newTree } = await this.api('POST', '/git/trees', { base_tree: snap.treeSha, tree });
      const { data: newCommit } = await this.api('POST', '/git/commits', { message, tree: newTree.sha, parents: [head] });
      this.rememberTree(newCommit.sha, newTree.sha);
      try {
        await this.api('PATCH', `/git/refs/heads/${encodeURIComponent(this.branch)}`, { sha: newCommit.sha, force: false });
        this.refSha = newCommit.sha;
        this.refEtag = null;
        return { committed: true, commitSha: newCommit.sha };
      } catch (err) {
        if (!(err instanceof ConflictError)) throw err;
        lastErr = err;
        await sleep(300 + Math.random() * 700 * (i + 1));
      }
    }
    throw lastErr || new RelayError('Impossible d\'écrire sur GitHub après plusieurs essais.');
  }

  // -------------------------------------------------------------------------
  // Diagnostic / initialisation
  // -------------------------------------------------------------------------

  async repoInfo() {
    const url = `${this.apiBase}/repos/${this.owner}/${this.repo}`;
    const res = await this.fetch(url, {
      cache: 'no-store',
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.token}` },
    });
    if (res.status === 401) throw new RelayError('Token GitHub refusé.', { code: 'auth', status: 401 });
    if (res.status === 404) throw new RelayError(`Dépôt ${this.owner}/${this.repo} introuvable (ou le token n'y a pas accès).`, { code: 'notfound', status: 404 });
    if (!res.ok) throw new RelayError(`GitHub HTTP ${res.status}`, { status: res.status });
    const d = await res.json();
    return { private: !!d.private, sizeKb: d.size || 0, defaultBranch: d.default_branch, canPush: d.permissions ? !!d.permissions.push : true };
  }

  /** Crée la branche (ou le premier commit d'un dépôt vide) si besoin. */
  async ensureReady() {
    const info = await this.repoInfo();
    try {
      await this.headSha({ useCache: false });
      return info;
    } catch (err) {
      if (err.code === 'empty') {
        await this.fetch(`${this.apiBase}/repos/${this.owner}/${this.repo}/contents/README.md`, {
          method: 'PUT',
          cache: 'no-store',
          headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: 'Revendo : initialisation', content: utf8ToBase64('# Revendo — données\n'), branch: this.branch }),
        });
        await this.headSha({ useCache: false });
        return info;
      }
      if (err.code === 'notfound') {
        // Branche absente : on la crée depuis la branche par défaut.
        const { data } = await this.api('GET', `/git/ref/heads/${encodeURIComponent(info.defaultBranch)}`);
        await this.api('POST', '/git/refs', { ref: `refs/heads/${this.branch}`, sha: data.object.sha });
        await this.headSha({ useCache: false });
        return info;
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Lecture de l'état
  // -------------------------------------------------------------------------

  /** Lit tout l'état (comptes, jobs, statuts). Les JSON sont mis en cache par sha. */
  async state({ withJobJson = true } = {}) {
    const { sha } = await this.headSha();
    // Branche inchangée depuis la dernière lecture : on réutilise le résultat (0 requête de plus).
    if (this.stateCache && this.stateCache.headSha === sha && (this.stateCache.withJobJson || !withJobJson)) return this.stateCache.value;
    const snap = await this.treeOfCommit(sha);
    const accounts = [];
    const jobs = new Map();
    const statuses = new Map();
    const reads = [];
    for (const [path, { sha: blobSha }] of snap.entries) {
      let m;
      if ((m = /^accounts\/([^/]+)\.json$/.exec(path))) {
        reads.push(this.readJsonBlob(blobSha).then((a) => accounts.push({ ...a, login: a.login || m[1], key: m[1] })).catch(() => null));
      } else if ((m = /^jobs\/([^/]+)\/([^/]+)\/(.+)$/.exec(path))) {
        const [, account, id, file] = m;
        if (!jobs.has(id)) jobs.set(id, { id, account, photos: [], jobSha: null, data: null });
        const j = jobs.get(id);
        if (file === 'job.json') j.jobSha = blobSha;
        else if (/\.(jpe?g|png|webp)$/i.test(file)) j.photos.push({ path, sha: blobSha, name: file });
      } else if ((m = /^status\/([^/]+)\.json$/.exec(path))) {
        reads.push(this.readJsonBlob(blobSha).then((s) => statuses.set(m[1], s)).catch(() => null));
      }
    }
    if (withJobJson) {
      for (const j of jobs.values()) {
        if (j.jobSha) reads.push(this.readJsonBlob(j.jobSha).then((d) => (j.data = d)).catch(() => null));
      }
    }
    await Promise.all(reads);
    for (const j of jobs.values()) j.photos.sort((a, b) => a.name.localeCompare(b.name));
    const value = { headSha: sha, accounts, jobs: [...jobs.values()], statuses, snapshot: snap };
    this.stateCache = { headSha: sha, withJobJson, value };
    return value;
  }

  /**
   * Jobs en attente pour un compte, du plus ancien au plus récent : sans
   * statut, ou en « nouvel essai automatique » dont l'heure est venue.
   */
  async pendingJobsFor(login, { now = Date.now() } = {}) {
    return (await this.queueFor(login, { now })).pending;
  }

  /**
   * File d'un compte : jobs en attente (cf. pendingJobsFor) + heure du prochain
   * nouvel essai automatique pas encore dû (ms, 0 si aucun) — le robot doit
   * relire la file à cette heure-là même si la branche n'a pas bougé.
   */
  async queueFor(login, { now = Date.now() } = {}) {
    const st = await this.state({ withJobJson: false });
    const key = safeLogin(login);
    const mine = st.jobs.filter((j) => j.account === key && j.jobSha);
    const lock = mine.some((j) => st.statuses.get(j.id)?.state === 'processing') ? await this.readLock(st.snapshot) : null;
    const due = (s) => !s || retryDue(s, now) || staleProcessing(s, lock, login, now);
    const pending = mine
      .filter((j) => due(st.statuses.get(j.id)))
      .map((j) => ({ ...j, attempts: st.statuses.get(j.id)?.attempts || 0 }))
      .sort((a, b) => a.id.localeCompare(b.id));
    let nextRetryAt = 0;
    for (const j of mine) {
      const s = st.statuses.get(j.id);
      if (due(s)) continue;
      // Nouvel essai prévu, ou « en cours » de ce profil qui deviendra « abandonné » à cette heure-là.
      const t = s?.state === 'retry' ? Date.parse(s.retryAt || 0) : s?.state === 'processing' && s.worker?.login === login ? Date.parse(s.updatedAt || s.startedAt || 0) + LOCK_TTL_MS + 1000 : 0;
      if (t && (!nextRetryAt || t < nextRetryAt)) nextRetryAt = t;
    }
    return { pending, nextRetryAt };
  }

  /**
   * Verrou du robot dans un instantané : null s'il est absent ou corrompu.
   * Une erreur de LECTURE (réseau, GitHub 5xx) remonte : conclure « pas de
   * verrou » laisserait un second profil remplir Vinted en même temps.
   */
  async readLock(snap) {
    const e = snap?.entries?.get(LOCK_PATH);
    if (!e) return null;
    try {
      return await this.readJsonBlob(e.sha);
    } catch (err) {
      if (err instanceof SyntaxError) return null;
      throw err;
    }
  }

  /** Verrou actuel (lecture seule : affichage, attente). */
  async currentLock() {
    const st = await this.state({ withJobJson: false });
    return this.readLock(st.snapshot);
  }

  async readJob(job) {
    const data = job.data || (job.jobSha ? await this.readJsonBlob(job.jobSha) : null);
    if (!data) throw new RelayError(`Job ${job.id} illisible.`);
    // 4 photos téléchargées à la fois, dans l'ordre d'origine (01.jpg, 02.jpg…).
    const photos = await mapLimit(job.photos, 4, async (p) => ({ name: p.name, base64: await this.readBlobBase64(p.sha) }));
    return { data, photos };
  }

  // -------------------------------------------------------------------------
  // Écritures
  // -------------------------------------------------------------------------

  async putAccount(info) {
    const key = safeLogin(info.login);
    const path = `accounts/${key}.json`;
    const content = JSON.stringify({ ...info, login: info.login, updatedAt: new Date().toISOString() }, null, 2);
    return this.commit(() => [{ path, content }], `compte ${key} en ligne`, { needSnapshot: false });
  }

  /**
   * Crée un job. photos = [{ sha }] (blob déjà envoyé avec uploadBlob, cas du
   * téléphone qui envoie chaque photo dès qu'elle est prête) ou [{ base64 }]
   * (JPEG envoyé ici, 4 à la fois). Puis UN commit atomique, sans relire
   * l'arborescence. onProgress(envoyées, total) suit l'envoi des photos.
   */
  async createJob({ account, price, hints = {}, photos = [], thumb = '', createdBy = 'phone', onProgress } = {}) {
    if (!account) throw new RelayError('Compte cible manquant.');
    if (!photos.length) throw new RelayError('Ajoute au moins une photo.');
    const id = newJobId();
    const key = safeLogin(account);
    let done = photos.filter((p) => p?.sha).length;
    const shas = await mapLimit(photos, 4, async (p) => {
      if (p?.sha) return p.sha;
      if (!p?.base64) throw new RelayError('Photo vide : reprends-la.');
      const sha = await this.uploadBlob(p.base64);
      done += 1;
      onProgress?.(done, photos.length);
      return sha;
    });
    const names = shas.map((_, i) => `${String(i + 1).padStart(2, '0')}.jpg`);
    const job = {
      id,
      account,
      price,
      hints,
      photos: names,
      thumb,
      createdBy,
      createdAt: new Date().toISOString(),
      v: 1,
    };
    await this.commit(
      () => [
        ...shas.map((sha, i) => ({ path: `jobs/${key}/${id}/${names[i]}`, sha })),
        { path: `jobs/${key}/${id}/job.json`, content: JSON.stringify(job, null, 2) },
      ],
      `nouvelle annonce pour ${key} (${photos.length} photo${photos.length > 1 ? 's' : ''})`,
      { needSnapshot: false },
    );
    return { id, job };
  }

  /**
   * Prise d'un job : n'aboutit que si personne n'a déjà écrit son statut (ou
   * si c'est un « nouvel essai automatique » arrivé à échéance, ou un « en
   * cours » abandonné par ce même profil) et, avec exclusive, si le robot
   * n'est ni occupé ni réservé par un autre profil — le verrou est alors pris
   * dans le même commit. Refusé pour cause de verrou, le profil s'inscrit
   * dans la file d'attente du verrou (passage de relais équitable).
   * Renvoie { ok, reason, lock, attempts }.
   */
  async claimJob(job, worker, { exclusive = true, ttlMs = LOCK_TTL_MS, now = () => Date.now() } = {}) {
    const path = `status/${job.id}.json`;
    let attempts = 0;
    let taken = null;
    try {
      await this.commit(async (snap) => {
        // Nouveau passage après un conflit d'écriture : on repart de zéro.
        attempts = 0;
        taken = null;
        if (!snap.entries.has(`jobs/${job.account}/${job.id}/job.json`)) throw new ConflictError('supprimé');
        const lock = exclusive || snap.entries.has(path) ? await this.readLock(snap) : null;
        if (snap.entries.has(path)) {
          const prev = await this.readJsonBlob(snap.entries.get(path).sha).catch(() => null);
          if (retryDue(prev, now())) attempts = prev.attempts || 0;
          else if (staleProcessing(prev, lock, worker.login, now())) attempts = (prev.attempts || 0) + 1;
          else throw new ConflictError('déjà pris');
        }
        const at = iso(now());
        const changes = [];
        if (exclusive) {
          if (lockedByOther(lock, worker.login, now())) throw new LockedError(lock);
          const waiters = Object.fromEntries(liveWaiters(lock, now(), [worker.login]));
          taken = { holder: worker.login, profile: worker.profile || '', jobId: job.id, at, until: iso(now() + ttlMs), waiters };
          changes.push({ path: LOCK_PATH, content: JSON.stringify(taken, null, 2) });
        }
        const st = { id: job.id, account: job.account, state: 'processing', attempts, startedAt: at, updatedAt: at, worker };
        changes.push({ path, content: JSON.stringify(st, null, 2) });
        return changes;
      }, `prise en charge ${job.id}`);
      return { ok: true, reason: '', lock: taken, attempts };
    } catch (err) {
      if (err instanceof LockedError) {
        await this.joinLockQueue(worker.login, { now }).catch(() => null);
        return { ok: false, reason: 'verrou', lock: err.lock, attempts };
      }
      if (err instanceof ConflictError) return { ok: false, reason: err.message, lock: null, attempts };
      throw err;
    }
  }

  /**
   * Inscrit `login` dans la file d'attente du verrou, ou y renouvelle son
   * signe de vie (au plus un commit par minute et par profil) : à la fin du
   * remplissage en cours, le verrou est réservé à celui qui attend depuis le
   * plus longtemps parmi les profils encore vivants.
   */
  async joinLockQueue(login, { now = () => Date.now() } = {}) {
    return this.commit(async (snap) => {
      const lock = await this.readLock(snap);
      if (!lockedByOther(lock, login, now())) return []; // libre entre-temps : le prochain tour le prendra
      const cur = lock.waiters?.[login] ? waiterTimes(lock.waiters[login]) : null;
      if (cur && now() - Date.parse(cur.seen) < 60000) return [];
      const alive = cur && now() - Date.parse(cur.seen) < WAITER_TTL_MS;
      const waiters = { ...Object.fromEntries(liveWaiters(lock, now(), [login])), [login]: { since: alive ? cur.since : iso(now()), seen: iso(now()) } };
      return [{ path: LOCK_PATH, content: JSON.stringify({ ...lock, waiters }, null, 2) }];
    }, `en attente du robot : ${login}`);
  }

  /**
   * Verrou seul, sans job du relais (remplissage lancé à la main sur le PC).
   * Renvoie { ok, lock }.
   */
  async acquireLock(worker, jobId, { ttlMs = LOCK_TTL_MS, now = () => Date.now() } = {}) {
    let taken = null;
    try {
      await this.commit(async (snap) => {
        const lock = await this.readLock(snap);
        if (lockedByOther(lock, worker.login, now())) throw new LockedError(lock);
        taken = { holder: worker.login, profile: worker.profile || '', jobId, at: iso(now()), until: iso(now() + ttlMs), waiters: Object.fromEntries(liveWaiters(lock, now(), [worker.login])) };
        return [{ path: LOCK_PATH, content: JSON.stringify(taken, null, 2) }];
      }, `robot pris : ${jobId}`);
      return { ok: true, lock: taken };
    } catch (err) {
      if (err instanceof LockedError) return { ok: false, lock: err.lock };
      throw err;
    }
  }

  /**
   * Prolonge le verrou tenu par `holder` pour `jobId` (début du remplissage,
   * nouvel essai de page) et date le statut « en cours » du même commit : le
   * téléphone voit que le PC travaille toujours.
   */
  async renewLock(jobId, holder, { ttlMs = LOCK_TTL_MS, now = () => Date.now() } = {}) {
    return this.commit(async (snap) => {
      const lock = await this.readLock(snap);
      if (!lock || lock.holder !== holder || lock.jobId !== jobId) return [];
      const changes = [{ path: LOCK_PATH, content: JSON.stringify({ ...lock, until: iso(now() + ttlMs) }, null, 2) }];
      const e = snap.entries.get(`status/${jobId}.json`);
      const st = e ? await this.readJsonBlob(e.sha).catch(() => null) : null;
      if (st?.state === 'processing') changes.push({ path: `status/${jobId}.json`, content: JSON.stringify({ ...st, updatedAt: iso(now()) }, null, 2) });
      return changes;
    }, `verrou prolongé ${jobId}`);
  }

  async writeStatus(jobId, status) {
    const path = `status/${jobId}.json`;
    return this.commit(
      () => [{ path, content: JSON.stringify({ ...status, id: jobId, updatedAt: new Date().toISOString() }, null, 2) }],
      `statut ${jobId} : ${status.state}`,
      { needSnapshot: false },
    );
  }

  /** `fn` réessayé (attente croissante) tant que l'erreur est passagère : réseau coupé, GitHub 5xx. */
  async persist(fn, { retries = 3 } = {}) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await fn();
      } catch (err) {
        if (!isTransient(err) || attempt >= retries) throw err;
        await sleep(this.retryDelayMs * 2 ** attempt * (1 + Math.random() * 0.3));
      }
    }
  }

  /**
   * Fin de job : statut final + (si succès) suppression des photos + verrou
   * rendu (ou réservé au profil qui attend) s'il porte sur ce job, en UN
   * commit, réessayé si le réseau coupe. status.state 'retry' : le job
   * redeviendra en attente à status.retryAt (nouvel essai automatique).
   * Annonce supprimée entre-temps : pas de statut fantôme (sauf brouillon créé).
   * onlyIfProcessing : n'écrit rien si le statut n'est plus « en cours »
   * (un autre chemin a déjà conclu : ne pas écraser un « brouillon créé »).
   */
  async finishJob(job, status, { deleteFiles = true, onlyIfProcessing = false, now = () => Date.now() } = {}) {
    const prefix = `jobs/${job.account}/${job.id}/`;
    const path = `status/${job.id}.json`;
    const word = { done: 'brouillon créé', retry: 'nouvel essai prévu' }[status.state] || 'échec';
    return this.persist(() =>
      this.commit(async (snap) => {
        if (onlyIfProcessing) {
          const e = snap.entries.get(path);
          const prev = e ? await this.readJsonBlob(e.sha) : null;
          if (prev?.state !== 'processing') return [];
        }
        const changes = [];
        if (snap.entries.has(`${prefix}job.json`) || status.state === 'done') {
          changes.push({ path, content: JSON.stringify({ ...status, id: job.id, account: job.account, updatedAt: iso(now()) }, null, 2) });
        }
        if (deleteFiles) for (const p of snap.entries.keys()) if (p.startsWith(prefix)) changes.push({ path: p, delete: true });
        const lock = await this.readLock(snap);
        if (lock?.holder && lock.jobId === job.id) changes.push(releasedLock(lock, now()));
        return changes;
      }, `${word} ${job.id}`),
    );
  }

  /** Rend le verrou tenu par `holder` (quel que soit le job) : remplissage manuel fini, plantage rattrapé. */
  async releaseLock(holder, { now = () => Date.now() } = {}) {
    return this.persist(() =>
      this.commit(async (snap) => {
        const lock = await this.readLock(snap);
        return lock && lock.holder === holder ? [releasedLock(lock, now())] : [];
      }, 'verrou libéré'),
    );
  }

  /**
   * « Réessayer » : supprime le statut d'un job encore présent → il redevient
   * en attente. Refusé pendant un remplissage en cours (verrou valable sur ce job).
   */
  async retryJob(jobId, { now = () => Date.now() } = {}) {
    return this.commit(async (snap) => {
      const hasJob = [...snap.entries.keys()].some((p) => p.startsWith('jobs/') && p.includes(`/${jobId}/`));
      if (!hasJob) throw new ConflictError('Photos déjà supprimées : impossible de relancer ce job.');
      const e = snap.entries.get(`status/${jobId}.json`);
      if (e) {
        const st = await this.readJsonBlob(e.sha).catch(() => null);
        const lock = st?.state === 'processing' ? await this.readLock(snap) : null;
        if (lock?.jobId === jobId && Date.parse(lock.until || 0) > now()) throw new ConflictError('Le PC remplit cette annonce en ce moment : attends la fin.');
      }
      return [{ path: `status/${jobId}.json`, delete: true }];
    }, `relance ${jobId}`);
  }

  /**
   * Supprime un job (photos + statut). Le verrou n'est PAS touché : si un
   * profil remplit encore ce job, c'est lui qui le rendra en finissant (sinon
   * un second profil démarrerait pendant que le premier remplit toujours).
   */
  async deleteJob(jobId) {
    return this.commit(async (snap) => {
      const changes = [];
      for (const p of snap.entries.keys()) {
        if ((p.startsWith('jobs/') && p.includes(`/${jobId}/`)) || p === `status/${jobId}.json`) changes.push({ path: p, delete: true });
      }
      return changes;
    }, `suppression ${jobId}`);
  }

  /** Efface les statuts terminés plus vieux que `days` jours. */
  async pruneStatuses(days = 30) {
    const limit = Date.now() - days * 86400000;
    const st = await this.state({ withJobJson: false });
    const old = [...st.statuses.entries()].filter(([, s]) => s.state === 'done' && Date.parse(s.updatedAt || 0) < limit).map(([id]) => id);
    if (!old.length) return 0;
    await this.commit(() => old.map((id) => ({ path: `status/${id}.json`, delete: true })), `ménage (${old.length} anciens statuts)`);
    return old.length;
  }

  /**
   * Repart d'un historique vierge (les photos supprimées restent sinon dans
   * l'historique Git et le dépôt grossit). Réécrit la branche : à lancer
   * quand aucun envoi n'est en cours.
   */
  async compactHistory() {
    const { sha } = await this.headSha({ useCache: false });
    const { data: commit } = await this.api('GET', `/git/commits/${sha}`);
    const { data: fresh } = await this.api('POST', '/git/commits', { message: 'Revendo : historique compacté', tree: commit.tree.sha, parents: [] });
    await this.api('PATCH', `/git/refs/heads/${encodeURIComponent(this.branch)}`, { sha: fresh.sha, force: true });
    this.refSha = fresh.sha;
    this.refEtag = null;
    return fresh.sha;
  }
}
