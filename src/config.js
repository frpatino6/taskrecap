// Paths and defaults, all overridable with flags or environment variables.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { expandUser } from './util.js';

export const APP_NAME = 'taskrecap'; // the product name lives here and in package.json only
export const APP_TITLE = 'taskrecap';
export const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; // one source of truth: it was hard-coded and went stale at 0.1.1

export const DEFAULT_KEY_REGEX = String.raw`\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b`; // Jira-style by default; any regex works

/** Where Claude Code keeps its session transcripts. */
export function projectsDir(override) {
  if (override) return expandUser(override);
  if (process.env.TASKRECAP_PROJECTS_DIR) return expandUser(process.env.TASKRECAP_PROJECTS_DIR);
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(expandUser(base), 'projects');
}

/** Where generated capsules and usage counters are cached (never inside the Claude folders). */
export function homeDir() {
  return expandUser(process.env.TASKRECAP_HOME) || path.join(os.homedir(), '.' + APP_NAME);
}

const LEGACY_HOME_NAME = '.work-capsules'; // the folder used before the tool was renamed

/**
 * First start after the rename: COPY (never move or delete) the old cache into the new folder, so the user keeps
 * their capsules and usage counter. Does nothing if the new folder exists or the old one does not.
 * Returns true when something was copied.
 */
export function migrateLegacyHome(newDir = homeDir(), legacyDir = path.join(os.homedir(), LEGACY_HOME_NAME)) {
  if (fs.existsSync(newDir) || !fs.existsSync(legacyDir)) return false;
  fs.cpSync(legacyDir, newDir, { recursive: true });
  return true;
}

export function keyRegex(override) {
  return override || process.env.TASKRECAP_KEY_REGEX || DEFAULT_KEY_REGEX;
}

let cliClaudePath = null;
/** `--claude-path` from the command line: beats the environment variables. */
export function setClaudePath(p) {
  cliClaudePath = p || null;
}

/** The Claude executable the user asked for, if any: --claude-path, then TASKRECAP_CLAUDE (TASKRECAP_CLAUDE_BIN is the older name). */
export function claudeOverride() {
  return cliClaudePath || process.env.TASKRECAP_CLAUDE || process.env.TASKRECAP_CLAUDE_BIN || null;
}
