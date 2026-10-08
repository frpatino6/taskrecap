import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parseCli } from '../src/cli.js';
import { tmpDir } from './helpers.js';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'taskrecap.js');
const env = () => ({ ...process.env, TASKRECAP_HOME: tmpDir() });

test('parseCli: no arguments means the dashboard; flags are validated', () => {
  assert.equal(parseCli([]).cmd, 'ui');
  assert.equal(parseCli(['--demo', '--no-open']).opts.noOpen, true);
  assert.equal(parseCli(['ui', '--port', '9000']).opts.port, 9000);
  const g = parseCli(['generate', 'ABC-1', '--votes', '1', '-y']);
  assert.deepEqual([g.cmd, g.key, g.opts.votes, g.opts.yes], ['generate', 'ABC-1', 1, true]);
  assert.throws(() => parseCli(['nope']), /Unknown command/);
  assert.throws(() => parseCli(['--votes', '0']), /--votes/);
  assert.throws(() => parseCli(['--port', 'x']), /--port/);
  assert.throws(() => parseCli(['--key-regex', '(']), /Invalid --key-regex/);
  assert.throws(() => parseCli(['--bogus']), /bogus/);
});

test('the CLI prints help, version and the demo task list', () => {
  const run = (args) => spawnSync(process.execPath, [BIN, ...args], { env: env(), encoding: 'utf8' });
  assert.match(run(['--help']).stdout, /Usage:/);
  const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(run(['--version']).stdout.trim(), `taskrecap ${version}`); // the number users see is the one that was published
  const list = run(['list', '--demo']);
  assert.equal(list.status, 0);
  assert.match(list.stdout, /SHOP-101/);
  assert.match(list.stdout, /session:/); // sessions without a task key are listed one by one
  assert.equal(JSON.parse(run(['list', '--demo', '--json']).stdout).length, 22);
  const bad = run(['generate']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Usage: taskrecap generate/);
});

test('`taskrecap` with no arguments starts the dashboard and serves the page (no browser opened)', async () => {
  const child = spawn(process.execPath, [BIN, '--demo', '--no-open', '--port', '0'], { env: env() });
  let out = '';
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start: ' + out)), 8000);
    child.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/running at (http:\/\/127\.0\.0\.1:\d+\/)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    child.on('exit', (c) => reject(new Error(`exited early (${c}): ${out}`)));
  });
  try {
    const page = await (await fetch(url)).text();
    assert.ok(page.includes('taskrecap'));
    const tasks = await (await fetch(url + 'api/tasks')).json();
    assert.ok(tasks.tasks.some((t) => t.key === 'SHOP-101'));
  } finally {
    child.kill('SIGINT');
  }
});
