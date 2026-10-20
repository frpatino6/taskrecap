// The test object every spec imports. It adds:
//   server        (worker)  a real `taskrecap --demo` on a free port, on a temporary TASKRECAP_HOME, killed at teardown
//   serverConfig  (option)  env/args variations, see presets.js
//   freshServer   (test)    a NEW pristine server for one test (use it when the test mutates state)
//   freshPage     (test)    a page already pointed at freshServer
//   page/baseURL            point at `server` by default; the home view is forced to "cards"
import { test as base, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { ROOT, presets } from './presets.js';

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function startServer(config) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-e2e-'));
  const port = await freePort();
  const extra = config.prepare ? config.prepare(home) || [] : []; // a preset may seed files in the temporary folder and add arguments
  const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'taskrecap.js'), ...(config.demo === false ? [] : ['--demo']), '--no-open', '--port', String(port), ...(config.args || []), ...extra], {
    cwd: ROOT,
    env: { ...process.env, TZ: 'UTC', TASKRECAP_HOME: path.join(home, 'home'), ...(config.env || {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = await new Promise((resolve, reject) => {
    let out = '';
    const t = setTimeout(() => reject(new Error('server did not start: ' + out)), 20_000);
    child.stdout.on('data', (d) => { out += d; const m = out.match(/http:\/\/127\.0\.0\.1:\d+\//); if (m) { clearTimeout(t); resolve(m[0]); } });
    child.on('exit', (c) => { clearTimeout(t); reject(new Error('server exited ' + c + ': ' + out)); });
  });
  return {
    url,
    home: path.join(home, 'home'),
    async stop() { child.removeAllListeners('exit'); child.kill(); fs.rmSync(home, { recursive: true, force: true }); },
  };
}

// The home opens in "timeline" by default; the specs that need cards ask for it through the page, tests of the timeline switch back.
const preferCards = (context) => context.addInitScript(() => { try { if (!localStorage.getItem('tr-view')) localStorage.setItem('tr-view', 'cards'); } catch (e) { /* ignore */ } });

export const test = base.extend({
  serverConfig: [presets.default, { option: true, scope: 'worker' }],

  server: [async ({ serverConfig }, use) => {
    const s = await startServer(serverConfig);
    await use(s);
    await s.stop();
  }, { scope: 'worker', auto: false }],

  baseURL: async ({ server }, use) => { await use(server.url); },

  context: async ({ context }, use) => { await preferCards(context); await use(context); },

  freshServer: async ({ serverConfig }, use) => {
    const s = await startServer(serverConfig);
    await use(s);
    await s.stop();
  },

  freshPage: async ({ browser, freshServer }, use) => {
    const context = await browser.newContext({ baseURL: freshServer.url, viewport: { width: 1280, height: 800 }, locale: 'en-US', timezoneId: 'UTC', colorScheme: 'light' });
    await preferCards(context);
    const page = await context.newPage();
    await use(page);
    await context.close();
  },
});

export { expect };
