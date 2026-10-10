/**
 * Revendo — web/shared doit être la copie exacte de extension/shared (source
 * de vérité) : le site Netlify publie web/ tel qu'il est commité. Un oubli de
 * tools/sync-shared.sh fait échouer ce test.
 * Lancement : node --test tools/test/*.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..');

test('web/shared est synchronisé avec extension/shared', () => {
  const src = path.join(ROOT, 'extension', 'shared');
  const dst = path.join(ROOT, 'web', 'shared');
  const files = fs.readdirSync(src).sort();
  assert.deepEqual(fs.readdirSync(dst).sort(), files, 'mêmes fichiers');
  for (const f of files) assert.ok(fs.readFileSync(path.join(src, f)).equals(fs.readFileSync(path.join(dst, f))), `${f} différent : lancer tools/sync-shared.sh`);
});
