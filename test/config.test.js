import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { migrateLegacyHome } from '../src/config.js';
import { tmpDir } from './helpers.js';

function legacyWithCapsule() {
  const legacy = path.join(tmpDir(), 'old');
  fs.mkdirSync(path.join(legacy, 'capsules'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'capsules', 'ABC-1.json'), '{"key":"ABC-1"}');
  fs.writeFileSync(path.join(legacy, 'usage.json'), '{"total":{"usd":0.5}}');
  return legacy;
}

test('migrateLegacyHome copies the old cache to the new folder and keeps the old one intact', () => {
  const legacy = legacyWithCapsule();
  const fresh = path.join(tmpDir(), 'new');
  assert.equal(migrateLegacyHome(fresh, legacy), true);
  assert.equal(fs.readFileSync(path.join(fresh, 'capsules', 'ABC-1.json'), 'utf8'), '{"key":"ABC-1"}');
  assert.ok(fs.existsSync(path.join(fresh, 'usage.json')));
  assert.ok(fs.existsSync(path.join(legacy, 'capsules', 'ABC-1.json')), 'the old folder is never touched');
});

test('migrateLegacyHome does nothing when the new folder exists or there is no old folder', () => {
  const legacy = legacyWithCapsule();
  const existing = tmpDir();
  assert.equal(migrateLegacyHome(existing, legacy), false);
  assert.deepEqual(fs.readdirSync(existing), []);
  assert.equal(migrateLegacyHome(path.join(tmpDir(), 'new'), path.join(tmpDir(), 'missing')), false);
});
