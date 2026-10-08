/**
 * Revendo — relais téléphone ⇄ PC stocké dans un dépôt GitHub PRIVÉ.
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
 *   status/<jobId>.json                ← écrit par le PC (processing / done / error)
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

export class GitHubRelay {
  constructor({ owner, repo, branch = 'main', token, fetchImpl, apiBase = 'https://api.github.com' } = {}) {
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
    const text = await res.text();
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

  async treeOfCommit(commitSha) {
    const { data: commit } = await this.api('GET', `/git/commits/${commitSha}`);
    const { data: tree } = await this.api('GET', `/git/trees/${commit.tree.sha}?recursive=1`);
    if (tree.truncated) throw new RelayError('Dépôt trop volumineux : lance « Compacter l\'historique » dans les réglages.');
    const entries = new Map();
    for (const e of tree.tree || []) if (e.type === 'blob') entries.set(e.path, { sha: e.sha, size: e.size });
    return { commitSha, treeSha: commit.tree.sha, entries };
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

  async createBlob(base64) {
    const { data } = await this.api('POST', '/git/blobs', { content: base64, encoding: 'base64' });
    return data.sha;
  }

  /**
   * Commit atomique avec retry. `build(snapshot)` reçoit l'état courant
   * ({ entries: Map(path → {sha}) }) et renvoie la liste des changements :
   *   { path, content }  (texte UTF-8) | { path, sha } (blob existant) | { path, delete: true }
   * Elle peut lever ConflictError pour annuler (ex. job déjà pris).
   */
  async commit(build, message, { attempts = 6 } = {}) {
    let lastErr = null;
    for (let i = 0; i < attempts; i += 1) {
      const { sha: head } = await this.headSha({ useCache: false });
      const snap = await this.treeOfCommit(head);
      const changes = await build(snap);
      if (!changes || !changes.length) return { committed: false, snapshot: snap };
      const tree = [];
      for (const c of changes) {
        if (c.delete) {
          if (snap.entries.has(c.path)) tree.push({ path: c.path, mode: '100644', type: 'blob', sha: null });
        } else if (c.sha) {
          tree.push({ path: c.path, mode: '100644', type: 'blob', sha: c.sha });
        } else {
          tree.push({ path: c.path, mode: '100644', type: 'blob', content: c.content });
        }
      }
      if (!tree.length) return { committed: false, snapshot: snap };
      const { data: newTree } = await this.api('POST', '/git/trees', { base_tree: snap.treeSha, tree });
      const { data: newCommit } = await this.api('POST', '/git/commits', { message, tree: newTree.sha, parents: [head] });
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

  /** Jobs en attente pour un compte (sans fichier de statut), du plus ancien au plus récent. */
  async pendingJobsFor(login) {
    const st = await this.state({ withJobJson: false });
    const key = safeLogin(login);
    return st.jobs
      .filter((j) => j.account === key && j.jobSha && !st.statuses.has(j.id))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async readJob(job) {
    const data = job.data || (job.jobSha ? await this.readJsonBlob(job.jobSha) : null);
    if (!data) throw new RelayError(`Job ${job.id} illisible.`);
    const photos = [];
    for (const p of job.photos) photos.push({ name: p.name, base64: await this.readBlobBase64(p.sha) });
    return { data, photos };
  }

  // -------------------------------------------------------------------------
  // Écritures
  // -------------------------------------------------------------------------

  async putAccount(info) {
    const key = safeLogin(info.login);
    const path = `accounts/${key}.json`;
    const content = JSON.stringify({ ...info, login: info.login, updatedAt: new Date().toISOString() }, null, 2);
    return this.commit(() => [{ path, content }], `compte ${key} en ligne`);
  }

  /**
   * Crée un job : photos = [{ base64 }] (JPEG). Les blobs sont envoyés avant
   * le commit (en parallèle limité), le commit final est atomique.
   */
  async createJob({ account, price, hints = {}, photos = [], thumb = '', createdBy = 'phone', onProgress } = {}) {
    if (!account) throw new RelayError('Compte cible manquant.');
    if (!photos.length) throw new RelayError('Ajoute au moins une photo.');
    const id = newJobId();
    const key = safeLogin(account);
    const shas = new Array(photos.length);
    let done = 0;
    const queue = photos.map((p, i) => async () => {
      shas[i] = await this.createBlob(p.base64);
      done += 1;
      onProgress?.(done, photos.length);
    });
    const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
      while (queue.length) await queue.shift()();
    });
    await Promise.all(workers);
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
    );
    return { id, job };
  }

  /** Prise d'un job : n'aboutit que si personne n'a déjà écrit son statut. */
  async claimJob(job, worker) {
    const path = `status/${job.id}.json`;
    try {
      await this.commit((snap) => {
        if (snap.entries.has(path)) throw new ConflictError('déjà pris');
        if (!snap.entries.has(`jobs/${job.account}/${job.id}/job.json`)) throw new ConflictError('supprimé');
        const st = { id: job.id, account: job.account, state: 'processing', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), worker };
        return [{ path, content: JSON.stringify(st, null, 2) }];
      }, `prise en charge ${job.id}`);
      return true;
    } catch (err) {
      if (err instanceof ConflictError) return false;
      throw err;
    }
  }

  async writeStatus(jobId, status) {
    const path = `status/${jobId}.json`;
    return this.commit(() => [{ path, content: JSON.stringify({ ...status, id: jobId, updatedAt: new Date().toISOString() }, null, 2) }], `statut ${jobId} : ${status.state}`);
  }

  /** Fin de job : statut final + (si succès) suppression des photos, en UN commit. */
  async finishJob(job, status, { deleteFiles = true } = {}) {
    const prefix = `jobs/${job.account}/${job.id}/`;
    return this.commit((snap) => {
      const changes = [{ path: `status/${job.id}.json`, content: JSON.stringify({ ...status, id: job.id, account: job.account, updatedAt: new Date().toISOString() }, null, 2) }];
      if (deleteFiles) for (const p of snap.entries.keys()) if (p.startsWith(prefix)) changes.push({ path: p, delete: true });
      return changes;
    }, `${status.state === 'done' ? 'brouillon créé' : 'échec'} ${job.id}`);
  }

  /** « Réessayer » : supprime le statut d'un job encore présent → il redevient en attente. */
  async retryJob(jobId) {
    return this.commit((snap) => {
      const hasJob = [...snap.entries.keys()].some((p) => p.startsWith('jobs/') && p.includes(`/${jobId}/`));
      if (!hasJob) throw new ConflictError('Photos déjà supprimées : impossible de relancer ce job.');
      return [{ path: `status/${jobId}.json`, delete: true }];
    }, `relance ${jobId}`);
  }

  /** Supprime un job (photos + statut). */
  async deleteJob(jobId) {
    return this.commit((snap) => {
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
