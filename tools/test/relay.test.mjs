/**
 * Revendo — tests du relais GitHub (shared/relay.js) : envoi des photos en
 * avance (uploadBlob + nouveaux essais), création d'annonce en UN commit sans
 * relire l'arborescence, lecture parallèle des photos dans l'ordre.
 * L'API Git Data de GitHub est simulée en mémoire (aucun réseau).
 * Lancement : node --test tools/test/*.test.mjs
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { ConflictError, GitHubRelay, LOCK_PATH, RelayError, isTransient, liveWaiters, lockedByOther, mapLimit, retryDue, staleProcessing, utf8ToBase64 } from '../../extension/shared/relay.js';

// ---------------------------------------------------------------------------
// Faux GitHub (blobs, arbres plats, commits, une branche)
// ---------------------------------------------------------------------------

const sha1 = (s) => createHash('sha1').update(s).digest('hex');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeGitHub({ files = {}, blobDelay = 0, blobFailures = [], patchConflicts = 0, readDelay = () => 0, failOnce = [] } = {}) {
  const blobs = new Map(); // sha → base64
  const trees = new Map(); // sha → Map(path → sha)
  const commits = new Map(); // sha → { tree, parents, message }
  const calls = [];
  const failures = [...blobFailures]; // 'network' | code HTTP, consommés un par un
  let conflicts = patchConflicts;
  let active = 0;
  let maxActive = 0;

  const putBlob = (b64) => {
    const sha = sha1(`blob:${b64}`);
    blobs.set(sha, b64);
    return sha;
  };
  const putTree = (map) => {
    const sha = sha1(`tree:${JSON.stringify([...map].sort())}`);
    trees.set(sha, map);
    return sha;
  };
  const putCommit = (tree, parents, message) => {
    const sha = sha1(`commit:${tree}:${parents.join(',')}:${message}:${commits.size}`);
    commits.set(sha, { tree, parents, message });
    return sha;
  };
  const init = new Map(Object.entries(files).map(([p, text]) => [p, putBlob(utf8ToBase64(text))]));
  let ref = putCommit(putTree(init), [], 'init');

  const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

  async function fetchImpl(url, opts = {}) {
    const method = opts.method || 'GET';
    const path = new URL(url).pathname.replace(/^\/repos\/o\/r/, '');
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ method, path, body });
    // Pannes ponctuelles : { method, re, status } consommée à la première requête qui correspond.
    const fi = failOnce.findIndex((f) => f.method === method && f.re.test(path));
    if (fi >= 0) {
      const [f] = failOnce.splice(fi, 1);
      if (f.status === 'network') throw new TypeError('Failed to fetch');
      return json(f.status, { message: `erreur ${f.status}` });
    }
    let m;
    if (method === 'GET' && path === '/git/ref/heads/main') return json(200, { object: { sha: ref } });
    if (method === 'GET' && (m = /^\/git\/commits\/(\w+)$/.exec(path))) return json(200, { sha: m[1], tree: { sha: commits.get(m[1]).tree } });
    if (method === 'GET' && (m = /^\/git\/trees\/(\w+)$/.exec(path))) {
      const tree = [...trees.get(m[1])].map(([p, s]) => ({ path: p, type: 'blob', sha: s, size: blobs.get(s).length }));
      return json(200, { sha: m[1], tree, truncated: false });
    }
    if (method === 'GET' && (m = /^\/git\/blobs\/(\w+)$/.exec(path))) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await wait(readDelay(m[1]));
      active -= 1;
      return json(200, { sha: m[1], content: blobs.get(m[1]), encoding: 'base64' });
    }
    if (method === 'POST' && path === '/git/blobs') {
      const f = failures.shift();
      if (f === 'network') throw new TypeError('Failed to fetch');
      if (f) return json(f, { message: `erreur ${f}` });
      active += 1;
      maxActive = Math.max(maxActive, active);
      await wait(blobDelay);
      active -= 1;
      return json(201, { sha: putBlob(body.content) });
    }
    if (method === 'POST' && path === '/git/trees') {
      const map = new Map(trees.get(body.base_tree));
      for (const e of body.tree) {
        if (e.sha === null) map.delete(e.path);
        else map.set(e.path, e.sha || putBlob(utf8ToBase64(e.content)));
      }
      return json(201, { sha: putTree(map) });
    }
    if (method === 'POST' && path === '/git/commits') return json(201, { sha: putCommit(body.tree, body.parents, body.message) });
    if (method === 'PATCH' && path === '/git/refs/heads/main') {
      if (conflicts > 0) {
        conflicts -= 1;
        ref = putCommit(commits.get(ref).tree, [ref], 'écriture concurrente');
        return json(422, { message: 'Update is not a fast forward' });
      }
      if (!body.force && !commits.get(body.sha).parents.includes(ref)) return json(422, { message: 'Update is not a fast forward' });
      ref = body.sha;
      return json(200, { object: { sha: ref } });
    }
    return json(404, { message: 'Not Found' });
  }

  return {
    fetchImpl,
    calls,
    blobs,
    get maxActive() {
      return maxActive;
    },
    /** Fichiers de la tête de branche : Map(path → base64). */
    head() {
      const map = trees.get(commits.get(ref).tree);
      return new Map([...map].map(([p, s]) => [p, blobs.get(s)]));
    },
    failNext(method, re, status) {
      failOnce.push({ method, re, status });
    },
    count(method, re) {
      return calls.filter((c) => c.method === method && re.test(c.path)).length;
    },
  };
}

const makeRelay = (gh) => new GitHubRelay({ owner: 'o', repo: 'r', branch: 'main', token: 't', fetchImpl: gh.fetchImpl, retryDelayMs: 1 });
const photo = (n) => Buffer.from(`JPEG-${n}-${'x'.repeat(50 + n)}`).toString('base64');

// ---------------------------------------------------------------------------
// mapLimit
// ---------------------------------------------------------------------------

test('mapLimit garde l’ordre et respecte la limite', async () => {
  let active = 0;
  let max = 0;
  const out = await mapLimit([30, 5, 20, 1, 10, 2], 2, async (ms, i) => {
    active += 1;
    max = Math.max(max, active);
    await wait(ms);
    active -= 1;
    return i * 10;
  });
  assert.deepEqual(out, [0, 10, 20, 30, 40, 50]);
  assert.equal(max, 2);
  assert.deepEqual(await mapLimit([], 4, async () => 1), []);
});

test('mapLimit s’arrête à la première erreur', async () => {
  const seen = [];
  await assert.rejects(
    mapLimit([1, 2, 3, 4, 5, 6], 1, async (n) => {
      seen.push(n);
      if (n === 2) throw new Error('boum');
    }),
    /boum/,
  );
  assert.deepEqual(seen, [1, 2]);
});

test('isTransient : réseau et 5xx seulement', () => {
  assert.equal(isTransient(new RelayError('x', { code: 'network' })), true);
  assert.equal(isTransient(new RelayError('x', { code: 'http', status: 502 })), true);
  assert.equal(isTransient(new RelayError('x', { code: 'http', status: 422 })), false);
  assert.equal(isTransient(new RelayError('x', { code: 'auth', status: 401 })), false);
  assert.equal(isTransient(new Error('x')), false);
});

// ---------------------------------------------------------------------------
// uploadBlob
// ---------------------------------------------------------------------------

test('uploadBlob renvoie le sha et réessaie sur 502 puis coupure réseau', async () => {
  const gh = fakeGitHub({ blobFailures: [502, 'network'] });
  const relay = makeRelay(gh);
  const sha = await relay.uploadBlob(photo(1));
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.equal(gh.blobs.get(sha), photo(1));
  assert.equal(gh.count('POST', /^\/git\/blobs$/), 3);
});

test('uploadBlob abandonne après 2 nouveaux essais', async () => {
  const gh = fakeGitHub({ blobFailures: [503, 503, 503, 503] });
  await assert.rejects(makeRelay(gh).uploadBlob(photo(1)), (err) => err instanceof RelayError && err.status === 503);
  assert.equal(gh.count('POST', /^\/git\/blobs$/), 3);
});

test('uploadBlob ne réessaie pas une erreur définitive (422, 401)', async () => {
  const gh = fakeGitHub({ blobFailures: [422] });
  await assert.rejects(makeRelay(gh).uploadBlob(photo(1)), /GitHub : erreur 422/);
  assert.equal(gh.count('POST', /^\/git\/blobs$/), 1);
  const gh2 = fakeGitHub({ blobFailures: [401] });
  await assert.rejects(makeRelay(gh2).uploadBlob(photo(1)), (err) => err.code === 'auth');
  assert.equal(gh2.count('POST', /^\/git\/blobs$/), 1);
});

test('createBlob reste un alias de uploadBlob', async () => {
  const gh = fakeGitHub();
  const relay = makeRelay(gh);
  assert.equal(await relay.createBlob(photo(2)), await relay.uploadBlob(photo(2)));
});

// ---------------------------------------------------------------------------
// createJob
// ---------------------------------------------------------------------------

test('createJob avec des photos déjà envoyées : 1 arbre + 1 commit + 1 PATCH, sans lecture récursive', async () => {
  const gh = fakeGitHub({ files: { 'accounts/lauraaix.json': '{"login":"lauraaix"}' } });
  const relay = makeRelay(gh);
  const shas = [];
  for (const n of [1, 2, 3]) shas.push(await relay.uploadBlob(photo(n)));
  gh.calls.length = 0;
  const progress = [];
  const { id, job } = await relay.createJob({
    account: 'lauraaix',
    price: '18',
    hints: { rayon: 'Femmes' },
    photos: shas.map((sha) => ({ sha })),
    thumb: 'data:image/jpeg;base64,AAAA',
    onProgress: (d, t) => progress.push(`${d}/${t}`),
  });
  assert.equal(gh.count('POST', /^\/git\/blobs$/), 0);
  assert.equal(gh.count('GET', /^\/git\/trees\//), 0);
  assert.equal(gh.count('POST', /^\/git\/trees$/), 1);
  assert.equal(gh.count('POST', /^\/git\/commits$/), 1);
  assert.equal(gh.count('PATCH', /^\/git\/refs\/heads\/main$/), 1);
  assert.deepEqual(progress, []);
  const treeBody = gh.calls.find((c) => c.method === 'POST' && c.path === '/git/trees').body;
  assert.deepEqual(
    treeBody.tree.filter((e) => e.sha).map((e) => [e.path, e.sha]),
    shas.map((sha, i) => [`jobs/lauraaix/${id}/0${i + 1}.jpg`, sha]),
  );
  const head = gh.head();
  assert.ok(head.has('accounts/lauraaix.json'), 'les fichiers existants sont gardés');
  assert.equal(head.get(`jobs/lauraaix/${id}/02.jpg`), photo(2));
  const saved = JSON.parse(Buffer.from(head.get(`jobs/lauraaix/${id}/job.json`), 'base64').toString('utf8'));
  assert.deepEqual(saved.photos, ['01.jpg', '02.jpg', '03.jpg']);
  assert.equal(saved.price, '18');
  assert.deepEqual(job.hints, { rayon: 'Femmes' });
});

test('createJob avec des photos base64 : envoi 4 à la fois, ordre gardé, progression', async () => {
  const gh = fakeGitHub({ blobDelay: 15 });
  const relay = makeRelay(gh);
  const photos = [1, 2, 3, 4, 5, 6, 7].map((n) => ({ base64: photo(n) }));
  const progress = [];
  const { id } = await relay.createJob({ account: 'elias..djb', price: '9.5', photos, onProgress: (d, t) => progress.push([d, t]) });
  assert.equal(gh.maxActive, 4);
  assert.equal(gh.count('POST', /^\/git\/blobs$/), 7);
  assert.deepEqual(progress.map(([d]) => d), [1, 2, 3, 4, 5, 6, 7]);
  assert.ok(progress.every(([, t]) => t === 7));
  const head = gh.head();
  for (let i = 1; i <= 7; i += 1) assert.equal(head.get(`jobs/elias..djb/${id}/0${i}.jpg`), photo(i));
});

test('createJob mélange { sha } et { base64 }', async () => {
  const gh = fakeGitHub();
  const relay = makeRelay(gh);
  const first = await relay.uploadBlob(photo(1));
  gh.calls.length = 0;
  const progress = [];
  const { id } = await relay.createJob({ account: 'khobendkho17', price: '20', photos: [{ sha: first }, { base64: photo(2) }], onProgress: (d, t) => progress.push(`${d}/${t}`) });
  assert.equal(gh.count('POST', /^\/git\/blobs$/), 1);
  assert.deepEqual(progress, ['2/2']);
  const head = gh.head();
  assert.equal(head.get(`jobs/khobendkho17/${id}/01.jpg`), photo(1));
  assert.equal(head.get(`jobs/khobendkho17/${id}/02.jpg`), photo(2));
});

test('createJob refuse une photo vide ou une liste vide', async () => {
  const relay = makeRelay(fakeGitHub());
  await assert.rejects(relay.createJob({ account: 'a', price: '1', photos: [] }), /au moins une photo/);
  await assert.rejects(relay.createJob({ account: 'a', price: '1', photos: [{}] }), /Photo vide/);
  await assert.rejects(relay.createJob({ price: '1', photos: [{ sha: 'x' }] }), /Compte cible/);
});

test('commit sans instantané : repart de la nouvelle tête après un conflit', async () => {
  const gh = fakeGitHub({ patchConflicts: 1 });
  const relay = makeRelay(gh);
  await relay.putAccount({ login: 'lauraaix', ext: '3.3.0' });
  assert.equal(gh.count('PATCH', /refs/), 2);
  assert.equal(gh.count('GET', /^\/git\/trees\//), 0);
  const acc = JSON.parse(Buffer.from(gh.head().get('accounts/lauraaix.json'), 'base64').toString('utf8'));
  assert.equal(acc.login, 'lauraaix');
});

test('le sha d’arbre de nos propres commits est mémorisé (pas de GET du commit)', async () => {
  const gh = fakeGitHub();
  const relay = makeRelay(gh);
  await relay.writeStatus('20261008-100000-abcd', { state: 'processing' });
  gh.calls.length = 0;
  await relay.writeStatus('20261008-100000-abcd', { state: 'done' });
  assert.equal(gh.count('GET', /^\/git\/commits\//), 0);
  assert.equal(gh.count('GET', /^\/git\/ref\//), 1);
  const st = await relay.state();
  assert.equal(st.statuses.get('20261008-100000-abcd').state, 'done');
});

test('les écritures qui lisent l’arborescence fonctionnent toujours (claim, finish, retry, delete)', async () => {
  const gh = fakeGitHub();
  const relay = makeRelay(gh);
  const { id } = await relay.createJob({ account: 'lauraaix', price: '18', photos: [{ base64: photo(1) }, { base64: photo(2) }] });
  const [job] = await relay.pendingJobsFor('lauraaix');
  assert.equal(job.id, id);
  assert.equal((await relay.claimJob(job, { login: 'lauraaix' })).ok, true);
  const again = await relay.claimJob(job, { login: 'lauraaix' });
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'déjà pris');
  await assert.rejects(relay.commit(() => { throw new ConflictError('stop'); }, 'x'), ConflictError);
  await relay.finishJob(job, { state: 'error', message: 'test' }, { deleteFiles: false });
  await relay.retryJob(id);
  assert.equal((await relay.pendingJobsFor('lauraaix')).length, 1);
  await relay.deleteJob(id);
  const st = await relay.state();
  assert.equal(st.jobs.length, 0);
  assert.equal(st.statuses.size, 0);
});

// ---------------------------------------------------------------------------
// Verrou du robot (un seul profil remplit Vinted à la fois) et nouvel essai automatique
// ---------------------------------------------------------------------------

const readHeadJson = (gh, p) => {
  const b64 = gh.head().get(p);
  return b64 ? JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) : null;
};

test('lockedByOther / retryDue', () => {
  const now = Date.parse('2026-10-10T10:00:00Z');
  assert.equal(lockedByOther(null, 'a', now), false);
  assert.equal(lockedByOther({ holder: 'a', until: '2026-10-10T10:05:00Z' }, 'a', now), false);
  assert.equal(lockedByOther({ holder: 'b', until: '2026-10-10T10:05:00Z' }, 'a', now), true);
  assert.equal(lockedByOther({ holder: 'b', until: '2026-10-10T09:59:59Z' }, 'a', now), false);
  assert.equal(lockedByOther({ holder: 'b' }, 'a', now), false);
  assert.equal(retryDue({ state: 'retry', retryAt: '2026-10-10T09:59:00Z' }, now), true);
  assert.equal(retryDue({ state: 'retry', retryAt: '2026-10-10T10:01:00Z' }, now), false);
  assert.equal(retryDue({ state: 'error' }, now), false);
  assert.equal(retryDue(null, now), false);
});

test('verrou : pris avec le job en UN commit, refusé aux autres profils, libéré à la fin', async () => {
  const gh = fakeGitHub();
  const relay = makeRelay(gh);
  await relay.createJob({ account: 'lauraaix', price: '18', photos: [{ base64: photo(1) }] });
  await relay.createJob({ account: 'tms13', price: '9', photos: [{ base64: photo(2) }] });
  const [a] = await relay.pendingJobsFor('lauraaix');
  const [b] = await relay.pendingJobsFor('tms13');
  const patches = gh.count('PATCH', /refs/);
  const claimA = await relay.claimJob(a, { login: 'lauraaix', profile: 'Profil 1' });
  assert.equal(claimA.ok, true);
  assert.equal(gh.count('PATCH', /refs/), patches + 1, 'statut + verrou dans un seul commit');
  assert.equal(claimA.lock.holder, 'lauraaix');
  assert.equal(claimA.lock.jobId, a.id);
  assert.equal(readHeadJson(gh, LOCK_PATH).holder, 'lauraaix');
  assert.equal(readHeadJson(gh, `status/${a.id}.json`).state, 'processing');

  const claimB = await relay.claimJob(b, { login: 'tms13' });
  assert.equal(claimB.ok, false);
  assert.equal(claimB.reason, 'verrou');
  assert.equal(claimB.lock.holder, 'lauraaix');
  assert.equal(gh.head().has(`status/${b.id}.json`), false, 'le job de tms13 reste en attente');
  assert.equal((await relay.currentLock()).jobId, a.id);

  assert.ok(readHeadJson(gh, LOCK_PATH).waiters.tms13, 'tms13 inscrit dans la file du verrou');
  await relay.finishJob(a, { state: 'done', message: 'ok' });
  assert.equal(readHeadJson(gh, LOCK_PATH).holder, '', 'verrou rendu…');
  assert.equal(readHeadJson(gh, LOCK_PATH).reservedFor, 'tms13', '…et réservé à celui qui attendait');
  assert.equal((await relay.claimJob(b, { login: 'tms13' })).ok, true);
  assert.equal(readHeadJson(gh, LOCK_PATH).holder, 'tms13');
  await relay.finishJob(b, { state: 'done', message: 'ok' });
  assert.equal(gh.head().has(LOCK_PATH), false, 'personne n’attend : verrou supprimé');
});

test('verrou : expiré (profil planté) → repris par un autre profil ; sans exclusive, ignoré', async () => {
  const gh = fakeGitHub();
  const relay = makeRelay(gh);
  await relay.createJob({ account: 'lauraaix', price: '18', photos: [{ base64: photo(1) }] });
  await relay.createJob({ account: 'tms13', price: '9', photos: [{ base64: photo(2) }] });
  const [a] = await relay.pendingJobsFor('lauraaix');
  const [b] = await relay.pendingJobsFor('tms13');
  const t0 = Date.parse('2026-10-10T10:00:00Z');
  assert.equal((await relay.claimJob(a, { login: 'lauraaix' }, { now: () => t0, ttlMs: 60000 })).ok, true);
  assert.equal((await relay.claimJob(b, { login: 'tms13' }, { now: () => t0 + 30000 })).reason, 'verrou');
  const late = await relay.claimJob(b, { login: 'tms13' }, { now: () => t0 + 61000 });
  assert.equal(late.ok, true);
  assert.equal(readHeadJson(gh, LOCK_PATH).holder, 'tms13');
  // Le profil planté qui termine malgré tout ne libère PAS le verrou d'un autre job.
  await relay.finishJob(a, { state: 'error', message: 'x' }, { deleteFiles: false });
  assert.equal(readHeadJson(gh, LOCK_PATH).holder, 'tms13');
  // releaseLock ne touche qu'au verrou de son détenteur.
  await relay.releaseLock('lauraaix');
  assert.equal(gh.head().has(LOCK_PATH), true);
  await relay.releaseLock('tms13');
  assert.equal(gh.head().has(LOCK_PATH), false);
});

test('renewLock prolonge seulement son propre verrou', async () => {
  const gh = fakeGitHub();
  const relay = makeRelay(gh);
  await relay.createJob({ account: 'lauraaix', price: '18', photos: [{ base64: photo(1) }] });
  const [a] = await relay.pendingJobsFor('lauraaix');
  const t0 = Date.parse('2026-10-10T10:00:00Z');
  await relay.claimJob(a, { login: 'lauraaix' }, { now: () => t0, ttlMs: 60000 });
  await relay.renewLock(a.id, 'lauraaix', { now: () => t0 + 50000, ttlMs: 60000 });
  assert.equal(readHeadJson(gh, LOCK_PATH).until, new Date(t0 + 110000).toISOString());
  await relay.renewLock(a.id, 'tms13', { now: () => t0 + 90000, ttlMs: 60000 });
  await relay.renewLock('autre-job', 'lauraaix', { now: () => t0 + 90000, ttlMs: 60000 });
  assert.equal(readHeadJson(gh, LOCK_PATH).until, new Date(t0 + 110000).toISOString());
});

test('nouvel essai automatique : statut retry → en attente à l’échéance, tentatives comptées, verrou libéré', async () => {
  const gh = fakeGitHub();
  const relay = makeRelay(gh);
  await relay.createJob({ account: 'lauraaix', price: '18', photos: [{ base64: photo(1) }] });
  const [a] = await relay.pendingJobsFor('lauraaix');
  assert.equal(a.attempts, 0);
  await relay.claimJob(a, { login: 'lauraaix' });
  const t = Date.now();
  await relay.finishJob(a, { state: 'retry', attempts: 1, retryAt: new Date(t + 180000).toISOString(), message: 'Nouvel essai automatique dans 3 min' }, { deleteFiles: false });
  assert.equal(gh.head().has(LOCK_PATH), false, 'le verrou est rendu pendant l’attente');
  assert.match(gh.calls.filter((c) => c.method === 'POST' && c.path === '/git/commits').pop().body.message, /nouvel essai prévu/);
  assert.equal((await relay.pendingJobsFor('lauraaix', { now: t })).length, 0, 'pas avant l’échéance');
  assert.equal((await relay.claimJob(a, { login: 'lauraaix' }, { now: () => t })).reason, 'déjà pris');
  const [again] = await relay.pendingJobsFor('lauraaix', { now: t + 181000 });
  assert.equal(again.id, a.id);
  assert.equal(again.attempts, 1);
  const claim = await relay.claimJob(again, { login: 'lauraaix' }, { now: () => t + 181000 });
  assert.equal(claim.ok, true);
  assert.equal(claim.attempts, 1);
  assert.equal(readHeadJson(gh, `status/${a.id}.json`).attempts, 1);
  // Deux profils qui voient le même job dû : un seul le prend.
  const other = await relay.claimJob(again, { login: 'lauraaix' }, { now: () => t + 181000 });
  assert.equal(other.ok, false);
});

test('annonce supprimée en plein remplissage : verrou gardé par celui qui remplit, pas de statut fantôme', async () => {
  const gh = fakeGitHub();
  const relay = makeRelay(gh);
  const { id } = await relay.createJob({ account: 'lauraaix', price: '18', photos: [{ base64: photo(1) }] });
  await relay.createJob({ account: 'tms13', price: '9', photos: [{ base64: photo(2) }] });
  const [a] = await relay.pendingJobsFor('lauraaix');
  const [b] = await relay.pendingJobsFor('tms13');
  await relay.claimJob(a, { login: 'lauraaix' });
  await relay.deleteJob(id);
  assert.equal(readHeadJson(gh, LOCK_PATH).holder, 'lauraaix', 'lauraaix remplit encore : le verrou reste');
  assert.equal((await relay.claimJob(b, { login: 'tms13' })).reason, 'verrou');
  assert.equal((await relay.claimJob(a, { login: 'lauraaix' })).reason, 'supprimé');
  await relay.finishJob(a, { state: 'retry', attempts: 1, retryAt: new Date().toISOString(), message: 'x' }, { deleteFiles: false });
  assert.equal(gh.head().has(`status/${id}.json`), false, 'pas de « nouvel essai » fantôme');
  assert.equal(readHeadJson(gh, LOCK_PATH).reservedFor, 'tms13');
});

test('verrou illisible (GitHub 502) : la prise échoue au lieu de conclure « libre »', async () => {
  const gh = fakeGitHub();
  const relay = makeRelay(gh);
  await relay.createJob({ account: 'lauraaix', price: '18', photos: [{ base64: photo(1) }] });
  await relay.createJob({ account: 'tms13', price: '9', photos: [{ base64: photo(2) }] });
  const [a] = await relay.pendingJobsFor('lauraaix');
  const [b] = await relay.pendingJobsFor('tms13');
  await relay.claimJob(a, { login: 'lauraaix' });
  await relay.renewLock(a.id, 'lauraaix'); // nouveau blob de verrou, absent du cache des autres
  const other = makeRelay(gh); // autre profil : cache vide
  const lockSha = sha1(`blob:${gh.head().get(LOCK_PATH)}`);
  gh.failNext('GET', new RegExp(`/git/blobs/${lockSha}`), 502);
  await assert.rejects(other.claimJob(b, { login: 'tms13' }));
  assert.equal(readHeadJson(gh, LOCK_PATH).holder, 'lauraaix');
  assert.equal(gh.head().has(`status/${b.id}.json`), false);
});

test('passage de relais équitable : un profil qui enchaîne ne reprend pas le verrou devant celui qui attend', async () => {
  const gh = fakeGitHub();
  const relay = makeRelay(gh);
  for (const n of [1, 2, 3]) await relay.createJob({ account: 'lauraaix', price: '18', photos: [{ base64: photo(n) }] });
  await relay.createJob({ account: 'tms13', price: '9', photos: [{ base64: photo(9) }] });
  const order = [];
  const step = async (login) => {
    const [j] = await relay.pendingJobsFor(login);
    if (!j) return false;
    const c = await relay.claimJob(j, { login });
    if (!c.ok) return false;
    order.push(login);
    await relay.finishJob(j, { state: 'done', message: 'ok' });
    return true;
  };
  await step('lauraaix');
  await relay.claimJob((await relay.pendingJobsFor('tms13'))[0], { login: 'tms13' }); // refusé ? non : libre
  order.push('tms13');
  // tms13 tient le verrou ; lauraaix refusée → inscrite dans la file
  const [l2] = await relay.pendingJobsFor('lauraaix');
  assert.equal((await relay.claimJob(l2, { login: 'lauraaix' })).reason, 'verrou');
  await relay.finishJob((await relay.state()).jobs.find((j) => j.account === 'tms13'), { state: 'done', message: 'ok' });
  assert.equal(readHeadJson(gh, LOCK_PATH).reservedFor, 'lauraaix');
  assert.equal(await step('lauraaix'), true);
  assert.deepEqual(order, ['lauraaix', 'tms13', 'lauraaix']);

  // Cas de la famine : A enchaîne, B attend → à la fin de A, le verrou va à B, pas à A.
  const gh2 = fakeGitHub();
  const r2 = makeRelay(gh2);
  for (const n of [1, 2]) await r2.createJob({ account: 'a', price: '1', photos: [{ base64: photo(n) }] });
  await r2.createJob({ account: 'b', price: '1', photos: [{ base64: photo(5) }] });
  const [a1] = await r2.pendingJobsFor('a');
  await r2.claimJob(a1, { login: 'a' });
  const [b1] = await r2.pendingJobsFor('b');
  assert.equal((await r2.claimJob(b1, { login: 'b' })).reason, 'verrou');
  await r2.finishJob(a1, { state: 'done', message: 'ok' });
  const [a2] = await r2.pendingJobsFor('a');
  assert.equal((await r2.claimJob(a2, { login: 'a' })).reason, 'verrou', 'A doit laisser passer B');
  assert.equal((await r2.claimJob(b1, { login: 'b' })).ok, true);
  assert.ok(readHeadJson(gh2, LOCK_PATH).waiters.a, 'A attend à son tour');
});

test('file du verrou : profil en attente disparu (plus de 3 min) ignoré ; réservation expirée reprise par n’importe qui', async () => {
  const t0 = Date.parse('2026-10-10T10:00:00Z');
  const lock = { holder: 'a', jobId: 'x', until: new Date(t0 + 60000).toISOString(), waiters: { b: new Date(t0 - 200000).toISOString(), c: new Date(t0 - 10000).toISOString() } };
  assert.deepEqual(liveWaiters(lock, t0).map(([l]) => l), ['c']);
  // Forme { since, seen } : l'ancienneté compte pour l'ordre, le signe de vie pour la présence.
  const lock2 = { holder: 'a', waiters: { b: { since: new Date(t0 - 400000).toISOString(), seen: new Date(t0 - 20000).toISOString() }, c: { since: new Date(t0 - 50000).toISOString(), seen: new Date(t0 - 5000).toISOString() } } };
  assert.deepEqual(liveWaiters(lock2, t0).map(([l]) => l), ['b', 'c']);
  const reserved = { holder: '', reservedFor: 'b', until: new Date(t0 + 75000).toISOString() };
  assert.equal(lockedByOther(reserved, 'b', t0), false);
  assert.equal(lockedByOther(reserved, 'a', t0), true);
  assert.equal(lockedByOther(reserved, 'a', t0 + 76000), false);
});

test('profil qui attend plus de 3 min (remplissage long) : toujours prioritaire grâce à ses signes de vie', async () => {
  const gh = fakeGitHub();
  const relay = makeRelay(gh);
  await relay.createJob({ account: 'a', price: '1', photos: [{ base64: photo(1) }] });
  await relay.createJob({ account: 'a', price: '1', photos: [{ base64: photo(2) }] });
  await relay.createJob({ account: 'b', price: '1', photos: [{ base64: photo(3) }] });
  const t0 = Date.parse('2026-10-10T10:00:00Z');
  const [a1] = await relay.pendingJobsFor('a', { now: t0 });
  await relay.claimJob(a1, { login: 'a' }, { now: () => t0 });
  const [b1] = await relay.pendingJobsFor('b', { now: t0 });
  // B relit toutes les 30 s pendant 5 min (remplissage de A très long).
  for (let t = 6000; t <= 300000; t += 30000) assert.equal((await relay.claimJob(b1, { login: 'b' }, { now: () => t0 + t })).reason, 'verrou');
  const w = readHeadJson(gh, LOCK_PATH).waiters.b;
  assert.equal(w.since, new Date(t0 + 6000).toISOString(), 'attend depuis sa 1re demande');
  assert.ok(Date.parse(w.seen) >= t0 + 240000, 'signe de vie récent');
  await relay.finishJob(a1, { state: 'done', message: 'ok' }, { now: () => t0 + 310000 });
  assert.equal(readHeadJson(gh, LOCK_PATH).reservedFor, 'b');
  const [a2] = await relay.pendingJobsFor('a', { now: t0 + 314000 });
  assert.equal((await relay.claimJob(a2, { login: 'a' }, { now: () => t0 + 314000 })).reason, 'verrou');
  assert.equal((await relay.claimJob(b1, { login: 'b' }, { now: () => t0 + 330000 })).ok, true);
});

test('« en cours » abandonné (statut final jamais écrit) : repris par le même profil après la durée du verrou', async () => {
  const gh = fakeGitHub();
  const relay = makeRelay(gh);
  await relay.createJob({ account: 'lauraaix', price: '18', photos: [{ base64: photo(1) }] });
  const [a] = await relay.pendingJobsFor('lauraaix');
  const t0 = Date.now();
  await relay.claimJob(a, { login: 'lauraaix' }, { now: () => t0, ttlMs: 60000 });
  assert.equal((await relay.pendingJobsFor('lauraaix', { now: t0 + 5 * 60000 })).length, 0, 'encore couvert');
  const later = t0 + 16 * 60000;
  const [again] = await relay.pendingJobsFor('lauraaix', { now: later });
  assert.equal(again.id, a.id);
  const c = await relay.claimJob(again, { login: 'lauraaix' }, { now: () => later });
  assert.equal(c.ok, true);
  assert.equal(c.attempts, 1, 'l’essai perdu compte');
  assert.equal(staleProcessing({ id: 'x', state: 'processing', worker: { login: 'autre' }, updatedAt: new Date(t0).toISOString() }, null, 'lauraaix', later), false, 'jamais le job d’un autre profil');
});

test('finishJob : réessayé si le réseau coupe ; onlyIfProcessing n’écrase pas un « brouillon créé »', async () => {
  const gh = fakeGitHub();
  const relay = makeRelay(gh);
  await relay.createJob({ account: 'lauraaix', price: '18', photos: [{ base64: photo(1) }] });
  const [a] = await relay.pendingJobsFor('lauraaix');
  await relay.claimJob(a, { login: 'lauraaix' });
  gh.failNext('POST', /^\/git\/trees$/, 'network');
  gh.failNext('PATCH', /refs/, 502);
  await relay.finishJob(a, { state: 'done', message: 'ok' });
  assert.equal(readHeadJson(gh, `status/${a.id}.json`).state, 'done');
  assert.equal(gh.head().has(LOCK_PATH), false);
  await relay.finishJob(a, { state: 'retry', attempts: 1, retryAt: new Date().toISOString(), message: 'x' }, { deleteFiles: false, onlyIfProcessing: true });
  assert.equal(readHeadJson(gh, `status/${a.id}.json`).state, 'done');
});

test('renewLock date aussi le statut « en cours » ; Réessayer refusé pendant un remplissage', async () => {
  const gh = fakeGitHub();
  const relay = makeRelay(gh);
  const { id } = await relay.createJob({ account: 'lauraaix', price: '18', photos: [{ base64: photo(1) }] });
  const [a] = await relay.pendingJobsFor('lauraaix');
  const t0 = Date.now();
  await relay.claimJob(a, { login: 'lauraaix' }, { now: () => t0 });
  await relay.renewLock(a.id, 'lauraaix', { now: () => t0 + 600000 });
  assert.equal(readHeadJson(gh, `status/${id}.json`).updatedAt, new Date(t0 + 600000).toISOString());
  await assert.rejects(relay.retryJob(id), /remplit cette annonce/);
  await relay.finishJob(a, { state: 'error', message: 'x' }, { deleteFiles: false });
  await relay.retryJob(id);
  assert.equal(gh.head().has(`status/${id}.json`), false);
});

test('acquireLock / releaseLock : remplissage manuel exclusif aussi', async () => {
  const gh = fakeGitHub();
  const relay = makeRelay(gh);
  assert.equal((await relay.acquireLock({ login: 'a' }, 'manuel-1')).ok, true);
  const refused = await relay.acquireLock({ login: 'b' }, 'manuel-2');
  assert.equal(refused.ok, false);
  assert.equal(refused.lock.holder, 'a');
  await relay.releaseLock('b');
  assert.equal(readHeadJson(gh, LOCK_PATH).holder, 'a');
  await relay.releaseLock('a');
  assert.equal(gh.head().has(LOCK_PATH), false);
});

// ---------------------------------------------------------------------------
// readJob
// ---------------------------------------------------------------------------

test('readJob lit les photos 4 par 4 dans l’ordre', async () => {
  const delays = new Map();
  const gh = fakeGitHub({ readDelay: (sha) => delays.get(sha) || 0 });
  const relay = makeRelay(gh);
  const photos = [1, 2, 3, 4, 5, 6].map((n) => ({ base64: photo(n) }));
  await relay.createJob({ account: 'lauraaix', price: '18', photos });
  const [job] = await relay.pendingJobsFor('lauraaix');
  // La 1re photo est la plus lente : l'ordre doit quand même être gardé.
  job.photos.forEach((p, i) => delays.set(p.sha, (6 - i) * 8));
  const read = await relay.readJob(job);
  assert.deepEqual(read.photos.map((p) => p.name), ['01.jpg', '02.jpg', '03.jpg', '04.jpg', '05.jpg', '06.jpg']);
  assert.deepEqual(read.photos.map((p) => p.base64), photos.map((p) => p.base64));
  assert.equal(read.data.price, '18');
  assert.equal(gh.maxActive, 4);
});
