// Server variations a spec can ask for with `test.use({ serverConfig: presets.xxx })`.
// Each spec FILE gets its own server, so a preset never leaks into other files.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const FAKE_CLAUDE = path.join(ROOT, 'tools', 'screenshots', 'fake-claude.mjs');

export const presets = {
  /** The demo as the user first sees it. */
  default: { env: {}, args: [] },
  /** `claude` is not installed: AI actions are disabled and explain why. */
  noClaude: { env: { TASKRECAP_CLAUDE: '/nonexistent/claude' }, args: [] },
  /** `claude` is a stand-in that answers organize/capsule prompts offline (no network, no spend). */
  fakeClaude: { env: { TASKRECAP_CLAUDE: FAKE_CLAUDE }, args: [] },
  /** Not the demo: a real (but empty) Claude projects folder with zero sessions. */
  emptySessions: {
    demo: false,
    prepare: (root) => { const dir = path.join(root, 'empty-projects'); fs.mkdirSync(dir, { recursive: true }); return ['--projects-dir', dir]; },
  },
  /** The demo, but its stored corrections and organize proposals are garbage files. */
  corruptedStore: {
    prepare: (root) => {
      const dir = path.join(root, 'home', 'demo-cache', '.index');
      fs.mkdirSync(dir, { recursive: true });
      for (const name of ['overrides.json', 'organize.json']) fs.writeFileSync(path.join(dir, name), '{"version": 1, "units": [<<< not json');
      return [];
    },
  },
};
