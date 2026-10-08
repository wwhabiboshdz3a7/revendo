/**
 * Revendo — tests du robot du PC (photos) : moniteur réseau des envois
 * (cdp.js), photos visibles et allègement (jobs.js), statut final (finalizeTab).
 * Sans réseau ni navigateur : chrome.*, document et XMLHttpRequest sont simulés.
 * Lancement : node --test tools/test/*.test.mjs
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

// ---------------------------------------------------------------------------
// Faux environnement Chrome (stockage en mémoire)
// ---------------------------------------------------------------------------

const mem = new Map();
globalThis.chrome = {
  runtime: { getManifest: () => ({ version: '0.0.0-test' }), lastError: undefined, getPlatformInfo: (cb) => cb?.() },
  storage: {
    local: {
      async get(keys) {
        const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || {});
        const out = {};
        for (const k of list) if (mem.has(k)) out[k] = structuredClone(mem.get(k));
        return out;
      },
      async set(obj) {
        for (const [k, v] of Object.entries(obj)) mem.set(k, structuredClone(v));
      },
      async remove(keys) {
        for (const k of [].concat(keys)) mem.delete(k);
      },
    },
  },
  debugger: { detach: (_t, cb) => cb?.(), onDetach: { addListener() {} } },
  windows: { remove: async () => {} },
  tabs: { remove: async () => {} },
};

const { photoNetMonitor } = await import('../../extension/background/cdp.js');
const jobs = await import('../../extension/background/jobs.js');

// ---------------------------------------------------------------------------
// Moniteur réseau (exécuté normalement dans la page Vinted, monde MAIN)
// ---------------------------------------------------------------------------

function fakePage() {
  const dataset = {};
  const pending = [];
  class FakeXHR {
    constructor() {
      this.status = 0;
      this.handlers = [];
    }
    open(method, url) {
      this.method = method;
      this.url = url;
    }
    send() {
      pending.push(this);
    }
    addEventListener(type, fn) {
      if (type === 'loadend') this.handlers.push(fn);
    }
    finish(status) {
      this.status = status;
      for (const fn of this.handlers) fn();
    }
  }
  const resolvers = [];
  const win = {
    fetch: (input, init) => new Promise((resolve, reject) => resolvers.push({ input, init, resolve, reject })),
  };
  return { dataset, pending, resolvers, win, FakeXHR };
}

function withPage(page, fn) {
  const saved = { window: globalThis.window, document: globalThis.document, XMLHttpRequest: globalThis.XMLHttpRequest };
  globalThis.window = page.win;
  globalThis.document = { documentElement: { dataset: page.dataset } };
  globalThis.XMLHttpRequest = page.FakeXHR;
  return Promise.resolve()
    .then(fn)
    .finally(() => Object.assign(globalThis, saved));
}

const counters = (ds) => ({ on: ds.rvPhMonitor, started: ds.rvPhStarted, done: ds.rvPhDone, failed: ds.rvPhFailed });
const tick = () => new Promise((r) => setTimeout(r, 0));

test('moniteur : compte les envois POST/PUT « /photo » (XHR et fetch), ignore le reste', async () => {
  const page = fakePage();
  await withPage(page, async () => {
    assert.deepEqual(photoNetMonitor(), { ok: true, already: false });
    assert.deepEqual(counters(page.dataset), { on: '1', started: '0', done: '0', failed: '0' });

    // XHR : un envoi réussi, un refusé (413), une lecture GET ignorée.
    for (const [m, u] of [['POST', '/api/v2/photos'], ['post', 'https://www.vinted.fr/api/v2/photos'], ['GET', '/api/v2/photos/1']]) {
      const x = new XMLHttpRequest();
      x.open(m, u);
      x.send();
    }
    assert.equal(page.dataset.rvPhStarted, '2');
    page.pending[0].finish(200);
    page.pending[1].finish(413);
    page.pending[2].finish(200);
    page.pending[0].finish(200); // un second « loadend » ne compte pas deux fois
    assert.deepEqual(counters(page.dataset), { on: '1', started: '2', done: '1', failed: '1' });

    // fetch : PUT vers /photo (Request-like), POST ailleurs ignoré, erreur réseau = échec.
    const f1 = window.fetch({ url: '/api/v2/photos/7', method: 'PUT' });
    const f2 = window.fetch('/api/v2/items', { method: 'POST' });
    const f3 = window.fetch('/api/v2/photos', { method: 'POST' });
    assert.equal(page.dataset.rvPhStarted, '4');
    page.resolvers[0].resolve({ ok: true });
    page.resolvers[1].resolve({ ok: true });
    page.resolvers[2].reject(new Error('réseau'));
    await f1;
    await f2;
    await f3.catch(() => null);
    await tick();
    assert.deepEqual(counters(page.dataset), { on: '1', started: '4', done: '2', failed: '2' });
  });
});

test('moniteur : idempotent (une seconde injection ne double pas le comptage)', async () => {
  const page = fakePage();
  await withPage(page, async () => {
    photoNetMonitor();
    assert.deepEqual(photoNetMonitor(), { ok: true, already: true });
    const x = new XMLHttpRequest();
    x.open('POST', '/api/v2/photos');
    x.send();
    x.finish(201);
    assert.deepEqual(counters(page.dataset), { on: '1', started: '1', done: '1', failed: '0' });
  });
});

// ---------------------------------------------------------------------------
// jobs.js
// ---------------------------------------------------------------------------

test('shownPhotos : compteur du content script, sinon ligne « Photos », borné au nombre envoyé', () => {
  assert.equal(jobs.shownPhotos({ photos: { sent: 7, shown: 5 } }, 7), 5);
  assert.equal(jobs.shownPhotos({ photos: { shown: 9 } }, 7), 7);
  assert.equal(jobs.shownPhotos({ fields: [{ label: 'Photos', ok: true, detail: '6/7 visibles — ajoutées une par une' }] }, 7), 6);
  assert.equal(jobs.shownPhotos({ photos: { shown: null }, fields: [{ label: 'Photos', detail: '3/7 visibles' }] }, 7), 3);
  assert.equal(jobs.shownPhotos({ ok: false, message: 'onglet fermé' }, 7), 0);
  assert.equal(jobs.shownPhotos(null, 0), 0);
});

test('shrinkPhotos : petites photos intactes, échec de décodage → original gardé', async () => {
  const small = { name: '01.jpg', base64: 'A'.repeat(4000), mime: 'image/jpeg' };
  const big = { name: '02.jpg', base64: 'B'.repeat(1_000_000), mime: 'image/jpeg' }; // ~750 Ko, illisible ici
  const input = [small, big];
  const warn = console.warn;
  console.warn = () => {};
  try {
    const out = await jobs.shrinkPhotos(input);
    assert.notEqual(out, input);
    assert.equal(out.length, 2);
    assert.equal(out[0], small);
    assert.equal(out[1], big);
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(await jobs.shrinkPhotos([]), []);
});

test('finalizeTab : le résumé porte aiError, aiModel, noKey et photos { sent, shown }', async () => {
  const tabId = 42;
  await chrome.storage.local.set({
    [`rv_tab_${tabId}`]: {
      origin: 'manual',
      jobId: 'manuel-1',
      jobAccount: '',
      thumb: '',
      listing: { title: 'Pull Tommy Hilfiger', price: '25', autoSave: true, recognition: { mode: 'free', model: '', error: 'HTTP 429 (quota)', noKey: false } },
      photos: Array.from({ length: 7 }, (_, i) => ({ name: `${i + 1}.jpg`, base64: 'AA' })),
      account: { id: '1', login: 'lauraaix', domain: 'www.vinted.fr' },
      windowId: 1,
    },
    rv_settings: { worker: { closeTab: false } },
  });
  const log = console.log;
  const warn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try {
    await jobs.finalizeTab(tabId, {
      ok: true,
      draftSaved: true,
      draftConfirmed: true,
      fields: [{ label: 'Photos', ok: true, detail: '7/7 visibles' }],
      photos: { sent: 7, shown: 7 },
    });
  } finally {
    console.log = log;
    console.warn = warn;
  }
  const { rv_last_result: st, rv_log: journal } = await chrome.storage.local.get(['rv_last_result', 'rv_log']);
  assert.equal(st.state, 'done');
  assert.equal(st.summary.mode, 'free');
  assert.equal(st.summary.aiError, 'HTTP 429 (quota)');
  assert.equal(st.summary.aiModel, '');
  assert.equal(st.summary.noKey, false);
  assert.deepEqual(st.summary.photos, { sent: 7, shown: 7 });
  assert.match(journal[0].message, /IA indisponible \(HTTP 429 \(quota\)\)/);
  assert.equal((await chrome.storage.local.get(`rv_tab_${tabId}`))[`rv_tab_${tabId}`], undefined);
});
