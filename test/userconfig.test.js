import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { DEFAULT_KEY_REGEX } from '../src/config.js';
import { UserError } from '../src/errors.js';
import { combinePatterns, loadUserConfig, resolveKeyConfig, validatePatterns } from '../src/userconfig.js';
import { findKeys } from '../src/sessions.js';
import { SessionIndex } from '../src/tasks.js';
import { makeSession, tmpDir } from './helpers.js';

const BIN = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'taskrecap.js');
const writeConfig = (home, data) => fs.writeFileSync(path.join(home, 'config.json'), typeof data === 'string' ? data : JSON.stringify(data));

test('no config file: the default Jira-style pattern, nothing ignored', () => {
  const home = tmpDir();
  const kc = resolveKeyConfig({}, { home, env: {} });
  assert.deepEqual(kc.patterns, [DEFAULT_KEY_REGEX]);
  assert.equal(kc.source, 'default');
  assert.deepEqual(kc.ignoreBranches, []);
  assert.equal(kc.fileExists, false);
});

test('keyPatterns from config.json: several patterns are combined, each one wrapped', () => {
  const home = tmpDir();
  writeConfig(home, { keyPatterns: [String.raw`\b[A-Z]{2,5}-\d+\b`, String.raw`#\d{2,6}\b`], ignoreBranches: ['staging', ' qa '] });
  const kc = resolveKeyConfig({}, { home, env: {} });
  assert.equal(kc.source, 'file');
  assert.deepEqual(kc.ignoreBranches, ['staging', 'qa']);
  assert.deepEqual(findKeys('fix PROJ-12 and #4521 but not #7', kc.regex), ['PROJ-12', '#4521']);
  assert.equal(combinePatterns(['a|b', 'c']), '(?:a|b)|(?:c)', 'an alternation inside one pattern stays inside it');
  assert.equal(combinePatterns(['x']), 'x');
});

test('precedence: --key-regex > TASKRECAP_KEY_REGEX > TASKRECAP_KEY_PATTERNS > config file > default', () => {
  const home = tmpDir();
  writeConfig(home, { keyPatterns: ['FILE-\\d+'] });
  assert.equal(resolveKeyConfig({ flag: 'FLAG-\\d+' }, { home, env: { TASKRECAP_KEY_REGEX: 'ENV-\\d+' } }).regex, 'FLAG-\\d+');
  assert.equal(resolveKeyConfig({}, { home, env: { TASKRECAP_KEY_REGEX: 'ENV-\\d+' } }).regex, 'ENV-\\d+');
  assert.equal(resolveKeyConfig({}, { home, env: { TASKRECAP_KEY_PATTERNS: JSON.stringify(['A-\\d+', 'B-\\d+']) } }).regex, '(?:A-\\d+)|(?:B-\\d+)');
  assert.equal(resolveKeyConfig({}, { home, env: {} }).regex, 'FILE-\\d+');
  assert.equal(resolveKeyConfig({}, { home, env: {}, skipFile: true }).source, 'default');
});

test('ignored branches add up from the file, the environment and the flag', () => {
  const home = tmpDir();
  writeConfig(home, { ignoreBranches: ['staging'] });
  const kc = resolveKeyConfig({ ignore: 'qa, staging,release' }, { home, env: { TASKRECAP_IGNORE_BRANCHES: 'hotfix' } });
  assert.deepEqual(kc.ignoreBranches.sort(), ['hotfix', 'qa', 'release', 'staging']);
});

test('a bad regex, bad JSON or a wrong shape is a clear UserError that names the setting', () => {
  const home = tmpDir();
  const err = (cfg, env = {}) => { writeConfig(home, cfg); try { resolveKeyConfig({}, { home, env }); } catch (e) { return e; } return null; };
  let e = err({ keyPatterns: ['('] });
  assert.ok(e instanceof UserError);
  assert.match(e.message, /keyPatterns\[0\] is not a valid regular expression: \(/);
  assert.match(e.message, /config\.json/);
  assert.match(err('{ nope').message, /not valid JSON/);
  assert.match(err('[1,2]').message, /must contain a JSON object/);
  assert.match(err({ keyPatterns: 'ABC-\\d+' }).message, /non-empty list/);
  assert.match(err({ keyPatterns: [] }).message, /non-empty list/);
  assert.match(err({ keyPatterns: [''] }).message, /non-empty text/);
  assert.match(err({ keyPatterns: [5] }).message, /non-empty text/);
  assert.match(err({ keyPatterns: ['x'.repeat(400)] }).message, /longer than 300/);
  assert.match(err({ ignoreBranches: 'main' }).message, /list of branch names/);
  assert.match(err({ ignoreBranches: [1] }).message, /must be text/);
  assert.match(err({}, { TASKRECAP_KEY_REGEX: '[' }).message, /TASKRECAP_KEY_REGEX/);
  assert.match(err({}, { TASKRECAP_KEY_PATTERNS: 'not json' }).message, /TASKRECAP_KEY_PATTERNS must be a JSON array/);
  assert.match(err({}, { TASKRECAP_KEY_PATTERNS: '["("]' }).message, /TASKRECAP_KEY_PATTERNS: keyPatterns\[0\]/);
  assert.throws(() => validatePatterns(Array.from({ length: 21 }, (_, i) => `K${i}-\\d+`), 'x'), /at most 20/);
  writeConfig(home, '{}');
  assert.deepEqual(loadUserConfig(home).keyPatterns, null);
});

test('a configured pattern changes which sessions become tasks (a GitHub-style #123 works without any Jira key)', () => {
  const proj = tmpDir();
  makeSession(proj, 'AAAAAAAA-1', [['2026-09-09T09:00:00Z', 'Fix the login redirect, see #123 for the details', 'ok']], { branch: 'main' });
  const kc = resolveKeyConfig({}, { home: tmpDir(), env: { TASKRECAP_KEY_PATTERNS: JSON.stringify([String.raw`#\d{2,6}\b`]) } });
  assert.deepEqual(new SessionIndex(proj, kc.regex).tasks().map((t) => t.key), ['#123']);
  assert.deepEqual(new SessionIndex(proj).tasks().map((t) => t.key), ['session:AAAAAAAA'], 'with the default pattern it is a session of its own');
});

test('the CLI reports a broken settings file as an error, and doctor explains it and keeps going', () => {
  const home = tmpDir();
  writeConfig(home, { keyPatterns: ['('] });
  const env = { ...process.env, TASKRECAP_HOME: home, TASKRECAP_KEY_REGEX: '', TASKRECAP_KEY_PATTERNS: '' };
  const list = spawnSync(process.execPath, [BIN, 'list', '--demo'], { env, encoding: 'utf8' });
  assert.equal(list.status, 1);
  assert.match(list.stderr, /keyPatterns\[0\] is not a valid regular expression/);
  const doctor = spawnSync(process.execPath, [BIN, 'doctor', '--demo'], { env, encoding: 'utf8' });
  assert.match(doctor.stdout, /Settings problem: .*keyPatterns\[0\]/);
  assert.match(doctor.stdout, /Fix or delete that setting/);
  assert.match(doctor.stdout, /Sessions folder/, 'doctor keeps checking the rest');
  writeConfig(home, { keyPatterns: [String.raw`\b[A-Z]{2,5}-\d+\b`], ignoreBranches: ['staging'] });
  const ok = spawnSync(process.execPath, [BIN, 'doctor', '--demo'], { env, encoding: 'utf8' });
  assert.match(ok.stdout, /Task keys: 1 pattern \(from .*config\.json\), ignored branches: staging/);
});
