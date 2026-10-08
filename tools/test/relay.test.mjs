/**
 * Revendo — tests du relais GitHub (shared/relay.js) : envoi des photos en
 * avance (uploadBlob + nouveaux essais), création d'annonce en UN commit sans
 * relire l'arborescence, lecture parallèle des photos dans l'ordre.
 * L'API Git Data de GitHub est simulée en mémoire (aucun réseau).
 * Lancement : node --test tools/test/
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { ConflictError, GitHubRelay, RelayError, isTransient, mapLimit, utf8ToBase64 } from '../../extension/shared/relay.js';

// ---------------------------------------------------------------------------
// Faux GitHub (blobs, arbres plats, commits, une branche)
// ---------------------------------------------------------------------------

const sha1 = (s) => createHash('sha1').update(s).digest('hex');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeGitHub({ files = {}, blobDelay = 0, blobFailures = [], patchConflicts = 0, readDelay = () => 0 } = {}) {
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
  assert.equal(await relay.claimJob(job, { login: 'lauraaix' }), true);
  assert.equal(await relay.claimJob(job, { login: 'lauraaix' }), false);
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
