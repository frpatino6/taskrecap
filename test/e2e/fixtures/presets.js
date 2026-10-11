// Server variations a spec can ask for with `test.use({ serverConfig: presets.xxx })`.
// Each spec FILE gets its own server, so a preset never leaks into other files.
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
};
