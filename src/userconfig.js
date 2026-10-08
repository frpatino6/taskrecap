// The user's own settings: which text counts as a task key, and which branches mean "no task".
//   ~/.taskrecap/config.json   { "keyPatterns": ["\\b[A-Z][A-Z0-9]{1,9}-\\d{1,6}\\b", "#\\d{2,6}"], "ignoreBranches": ["staging"] }
// Precedence for the key patterns: --key-regex > TASKRECAP_KEY_REGEX > TASKRECAP_KEY_PATTERNS (JSON array) > config file > default.
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_KEY_REGEX } from './config.js';
import { UserError } from './errors.js';

export const CONFIG_FILE = 'config.json';
export const MAX_PATTERNS = 20;
export const MAX_PATTERN_LENGTH = 300;
export const MAX_IGNORED_BRANCHES = 100;

/** Compile every pattern once. Throws a UserError that names the offending pattern and where it came from. */
export function validatePatterns(list, where) {
  if (!Array.isArray(list) || !list.length) throw new UserError(`${where}: keyPatterns must be a non-empty list of regular expressions`);
  if (list.length > MAX_PATTERNS) throw new UserError(`${where}: at most ${MAX_PATTERNS} key patterns are allowed`);
  return list.map((p, i) => {
    if (typeof p !== 'string' || !p.trim()) throw new UserError(`${where}: keyPatterns[${i}] must be a non-empty text`);
    if (p.length > MAX_PATTERN_LENGTH) throw new UserError(`${where}: keyPatterns[${i}] is longer than ${MAX_PATTERN_LENGTH} characters`);
    try {
      new RegExp(p, 'g');
    } catch (e) {
      throw new UserError(`${where}: keyPatterns[${i}] is not a valid regular expression: ${p} (${e.message})`);
    }
    return p;
  });
}

/** One regex source that matches any of the patterns (each wrapped, so alternations inside a pattern stay inside it). */
export function combinePatterns(patterns) {
  return patterns.length === 1 ? patterns[0] : patterns.map((p) => `(?:${p})`).join('|');
}

function validateBranches(list, where) {
  if (!Array.isArray(list)) throw new UserError(`${where}: ignoreBranches must be a list of branch names`);
  if (list.length > MAX_IGNORED_BRANCHES) throw new UserError(`${where}: at most ${MAX_IGNORED_BRANCHES} ignored branches are allowed`);
  return list.map((b, i) => {
    if (typeof b !== 'string') throw new UserError(`${where}: ignoreBranches[${i}] must be text`);
    return b.trim();
  }).filter(Boolean);
}

/** Reads <home>/config.json. A missing file is fine; a broken one is a clear error, never silently ignored. */
export function loadUserConfig(home) {
  const file = path.join(home, CONFIG_FILE);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { file, exists: false, keyPatterns: null, ignoreBranches: [] };
    throw new UserError(`Cannot read ${file}: ${e.message}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new UserError(`${file} is not valid JSON: ${e.message}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new UserError(`${file} must contain a JSON object`);
  const where = file;
  return {
    file, exists: true,
    keyPatterns: data.keyPatterns === undefined ? null : validatePatterns(data.keyPatterns, where),
    ignoreBranches: data.ignoreBranches === undefined ? [] : validateBranches(data.ignoreBranches, where),
  };
}

const splitList = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

/**
 * -> {regex, patterns, ignoreBranches, source: 'flag'|'env'|'file'|'default', file}
 * `flag`: the --key-regex value (already known to be valid), `ignore`: --ignore-branches (comma separated).
 */
export function resolveKeyConfig({ flag = null, ignore = '' } = {}, { home, env = process.env, skipFile = false } = {}) {
  const fileCfg = skipFile ? { file: path.join(home, CONFIG_FILE), exists: false, keyPatterns: null, ignoreBranches: [] } : loadUserConfig(home);
  const ignoreBranches = [...new Set([...fileCfg.ignoreBranches, ...splitList(env.TASKRECAP_IGNORE_BRANCHES), ...splitList(ignore)])];
  let patterns;
  let source;
  if (flag) {
    patterns = [flag];
    source = 'flag';
  } else if (env.TASKRECAP_KEY_REGEX) {
    patterns = validatePatterns([env.TASKRECAP_KEY_REGEX], 'TASKRECAP_KEY_REGEX');
    source = 'env';
  } else if (env.TASKRECAP_KEY_PATTERNS) {
    let list;
    try {
      list = JSON.parse(env.TASKRECAP_KEY_PATTERNS);
    } catch {
      throw new UserError('TASKRECAP_KEY_PATTERNS must be a JSON array of regular expressions, e.g. ["\\\\b[A-Z]+-\\\\d+\\\\b"]');
    }
    patterns = validatePatterns(list, 'TASKRECAP_KEY_PATTERNS');
    source = 'env';
  } else if (fileCfg.keyPatterns) {
    patterns = fileCfg.keyPatterns;
    source = 'file';
  } else {
    patterns = [DEFAULT_KEY_REGEX];
    source = 'default';
  }
  return { regex: combinePatterns(patterns), patterns, ignoreBranches, source, file: fileCfg.file, fileExists: fileCfg.exists };
}
