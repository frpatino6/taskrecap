// Maintainer tooling (not published to npm): writes demo/capsules/.index/organize.json, the sample "Organize with AI" proposals of
// the FICTIONAL demo sessions, so `taskrecap --demo` shows the review panel without spending a token. No model is called: a scripted
// answer goes through the real pipeline (skeletons, strict validation, store), so the proposals are exactly what the app would keep.
// Run: node tools/demo/build-organize.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { App, DEMO_DIR } from '../../src/app.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'demo', 'capsules', '.index', 'organize.json');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'taskrecap-demo-organize-'));

const TITLES = {
  f2a2b2c2: 'Investigate the 500 error on the orders endpoint with an empty cart',
  f5a5b5c5: 'Rewrite the onboarding guide for new contributors',
  d4e5f6a7: 'Check which Node version this repo targets',
};

/** The scripted "model": ids come from the skeleton it was given, like the real one. */
async function scripted(prompt) {
  const ids = [...prompt.matchAll(/^SESSION (\S+) \|/gm)].map((m) => m[1]);
  const has = (id) => ids.includes(id);
  const answer = { titles: Object.entries(TITLES).filter(([id]) => has(id)).map(([session, title]) => ({ session, title })), groups: [], splits: [] };
  if (has('f3a3b3c3') && has('f4a4b4c4')) {
    answer.groups.push({
      sessions: ['f3a3b3c3', 'f4a4b4c4'], title: 'Pagination of the products listing', confidence: 'high',
      reason: 'The second session writes the tests for the pagination the first one added to the products endpoint.',
      evidence: [{ session: 'f3a3b3c3', turn: 0 }, { session: 'f4a4b4c4', turn: 0 }],
    });
  }
  if (has('fa1a1a1a')) {
    answer.splits.push({
      session: 'fa1a1a1a', reason: 'The morning is about broken documentation anchors; after the break the same session starts the 2.4 release notes.',
      parts: [
        { start: 0, end: 7, title: 'Fix the broken anchors in the docs', evidence: [{ session: 'fa1a1a1a', turn: 1 }] },
        { start: 8, end: 15, title: 'Write the 2.4 release notes', evidence: [{ session: 'fa1a1a1a', turn: 8 }] },
      ],
    });
  }
  return [JSON.stringify(answer), { cost_usd: 0, input_tokens: 0, output_tokens: 0 }];
}

// the sample corrections (two docs sessions grouped by the user) apply here too: those sessions are not "unsorted" in the demo
fs.mkdirSync(path.join(tmp, 'cache', '.index'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'demo', 'capsules', '.index', 'overrides.json'), path.join(tmp, 'cache', '.index', 'overrides.json'));
const app = new App({ projectsDir: path.join(DEMO_DIR, 'sessions'), cacheDir: path.join(tmp, 'cache'), demo: true, ask: scripted });
const res = await app.organize({});
const kinds = res.proposals.map((p) => p.type).sort().join(',');
if (!/group/.test(kinds) || !/split/.test(kinds) || !/title/.test(kinds)) throw new Error(`the sample answer did not produce all three kinds: ${kinds}`);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.copyFileSync(path.join(tmp, 'cache', '.index', 'organize.json'), OUT);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`wrote ${res.proposals.length} sample proposals (${kinds}) to demo/capsules/.index/organize.json`);
