// Finding and starting the `claude` executable on any OS. Bare spawn('claude') only works when the node process sees it
// on PATH and (on Windows) when it is a real .exe: npm installs a `claude.cmd` shim, and Claude Code is often installed
// in a folder that is not on the PATH of the process that started taskrecap.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as config from './config.js';
import { expandUser } from './util.js';

const WIN_EXT_ORDER = ['.exe', '.cmd', '.bat']; // a real executable beats a shim
const VERSION_TIMEOUT_MS = 8000;
const CACHE_MS = 60000;
const INSTALL_URL = 'https://claude.com/claude-code';

const isWin = (platform) => platform === 'win32';
const pathLib = (platform) => (isWin(platform) ? path.win32 : path.posix);

/** Environment lookup that ignores case on Windows (`Path` vs `PATH`). */
export function envVar(env, name, platform = process.platform) {
  if (env[name] !== undefined) return env[name];
  if (!isWin(platform)) return undefined;
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

const defaultIsFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};
const defaultReaddir = (p) => {
  try {
    return fs.readdirSync(p);
  } catch {
    return [];
  }
};

/** `/Users/me/.local/bin/claude` -> `~/.local/bin/claude`: show where it is without printing the whole home path. */
export function shortenPath(p, home = os.homedir(), platform = process.platform) {
  if (!p) return p;
  const lib = pathLib(platform);
  const h = home ? lib.normalize(home).replace(/[\\/]+$/, '') : '';
  const norm = lib.normalize(p);
  const same = (a, b) => (isWin(platform) ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (h && norm.length > h.length && same(norm.slice(0, h.length), h) && /[\\/]/.test(norm[h.length])) return '~' + norm.slice(h.length);
  return norm;
}

/** The extensions to try for a command name on this OS, in our order of preference. */
function extensions(env, platform) {
  if (!isWin(platform)) return [''];
  const declared = String(envVar(env, 'PATHEXT', platform) || '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.trim().toLowerCase());
  const exts = WIN_EXT_ORDER.filter((e) => declared.includes(e));
  return exts.length ? exts : WIN_EXT_ORDER;
}

function searchPath(name, { env, platform, isFile }) {
  const lib = pathLib(platform);
  const dirs = String(envVar(env, 'PATH', platform) || '').split(isWin(platform) ? ';' : ':').map((d) => d.trim().replace(/^"|"$/g, '')).filter(Boolean);
  const hasExt = isWin(platform) && /\.[a-z0-9]{1,4}$/i.test(name);
  for (const dir of dirs) {
    for (const ext of hasExt ? [''] : extensions(env, platform)) {
      const file = lib.join(dir, name + ext);
      if (isFile(file)) return file;
    }
  }
  return null;
}

/** Where Claude Code usually lives when it is installed but its folder is not on PATH. */
export function knownLocations({ env = process.env, platform = process.platform, home = os.homedir(), readdir = defaultReaddir } = {}) {
  const lib = pathLib(platform);
  const j = (...p) => lib.join(...p);
  if (isWin(platform)) {
    const profile = envVar(env, 'USERPROFILE', platform) || home;
    const appData = envVar(env, 'APPDATA', platform) || j(profile, 'AppData', 'Roaming');
    const local = envVar(env, 'LOCALAPPDATA', platform) || j(profile, 'AppData', 'Local');
    const prefix = envVar(env, 'npm_config_prefix', platform);
    const out = [
      j(profile, '.local', 'bin', 'claude.exe'),
      j(appData, 'npm', 'claude.cmd'),
      j(profile, '.claude', 'local', 'claude.exe'),
      j(profile, '.claude', 'local', 'claude.cmd'),
      j(local, 'Volta', 'bin', 'claude.exe'),
    ];
    if (prefix) out.push(j(prefix, 'claude.cmd'));
    for (const entry of readdir(j(local, 'Programs'))) {
      if (/^claude/i.test(entry)) out.push(j(local, 'Programs', entry, 'claude.exe'));
    }
    return out;
  }
  const out = [
    j(home, '.claude', 'local', 'claude'),
    j(home, '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    j(home, '.npm-global', 'bin', 'claude'),
    j(home, '.volta', 'bin', 'claude'),
    j(home, '.bun', 'bin', 'claude'),
  ];
  const nvm = j(home, '.nvm', 'versions', 'node');
  for (const v of readdir(nvm).sort().reverse()) out.push(j(nvm, v, 'bin', 'claude'));
  return out;
}

/**
 * Find the executable without running it. Order: explicit override (--claude-path / TASKRECAP_CLAUDE), PATH, well-known
 * install folders. An override that does not exist is an error, never silently replaced.
 * -> {path, via, tried[]} or {path: null, reason: 'not-found' | 'override-not-found', via?, tried[]}
 */
export function locateClaude({
  platform = process.platform, env = process.env, home = os.homedir(), override = config.claudeOverride(),
  isFile = defaultIsFile, readdir = defaultReaddir,
} = {}) {
  const lib = pathLib(platform);
  const ctx = { env, platform, isFile };
  const shown = (p) => shortenPath(p, home, platform);
  if (override) {
    const given = expandUser(String(override));
    if (/[\\/]/.test(given) || lib.isAbsolute(given)) {
      const candidates = isWin(platform) && !/\.[a-z0-9]{1,4}$/i.test(given) ? [given, ...extensions(env, platform).map((e) => given + e)] : [given];
      const hit = candidates.find((c) => isFile(c));
      if (hit) return { path: hit, via: 'override', tried: [shown(given)] };
    } else {
      const hit = searchPath(given, ctx);
      if (hit) return { path: hit, via: 'override', tried: [shown(given)] };
    }
    return { path: null, reason: 'override-not-found', via: 'override', tried: [shown(given)] };
  }
  const onPath = searchPath('claude', ctx);
  if (onPath) return { path: onPath, via: 'path', tried: ['PATH'] };
  const known = knownLocations({ env, platform, home, readdir });
  const hit = known.find((c) => isFile(c));
  if (hit) return { path: hit, via: 'known-location', tried: ['PATH'] };
  return { path: null, reason: 'not-found', tried: ['PATH', ...known.map(shown)] };
}

// ---- starting it ----

// cmd.exe quoting (the algorithm of the `cross-spawn` package, https://qntm.org/cmd): every argument is quoted and every
// cmd metacharacter escaped, so nothing a path or option contains can become a second command.
const META_CHARS = /([()\][%!^"`<>&|;, *?])/g;
export const escapeCmdCommand = (cmd) => String(cmd).replace(META_CHARS, '^$1');
export function escapeCmdArgument(arg, doubleEscape = false) {
  let a = `${arg}`;
  a = a.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  a = a.replace(/(?=(\\+?)?)\1$/, '$1$1');
  a = `"${a}"`;
  a = a.replace(META_CHARS, '^$1');
  if (doubleEscape) a = a.replace(META_CHARS, '^$1');
  return a;
}
const NPM_BIN_SHIM = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i;

/**
 * How to start `file` with `args`. A real executable runs directly. A .cmd/.bat shim (Windows) cannot be spawned directly
 * (Node refuses it since 2024): it goes through cmd.exe with every argument escaped. Prompts never travel here, only fixed
 * flags and a validated model alias: the prompt is written to stdin.
 */
export function spawnSpec(file, args, { platform = process.platform, env = process.env } = {}) {
  if (isWin(platform) && /\.(cmd|bat)$/i.test(file)) {
    for (const a of args) {
      if (/[\r\n\0]/.test(a)) throw new Error('Refusing to pass a multi-line argument through cmd.exe');
    }
    const double = NPM_BIN_SHIM.test(file);
    const line = [escapeCmdCommand(path.win32.normalize(file)), ...args.map((a) => escapeCmdArgument(a, double))].join(' ');
    return { command: envVar(env, 'ComSpec', platform) || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], options: { windowsVerbatimArguments: true } };
  }
  return { command: file, args, options: {} };
}

/** Stop a started process and its children (on Windows the child is cmd.exe or a launcher: kill the whole tree). */
export function killTree(child, { platform = process.platform, hard = false, spawnFn = spawn } = {}) {
  if (isWin(platform) && child.pid) {
    try {
      const k = spawnFn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      k.on('error', () => child.kill());
      return;
    } catch {
      /* fall through to a plain kill */
    }
  }
  child.kill(hard ? 'SIGKILL' : 'SIGTERM');
  if (!hard) setTimeout(() => child.kill('SIGKILL'), 2000).unref();
}

/** Only plain model aliases/ids reach the command line (it could come from --model). */
export const isSafeModel = (m) => /^[A-Za-z0-9._:\-[\]]{1,80}$/.test(String(m));

/** Run `<claude> --version` -> {ok, version, error}. Never rejects. */
export function runVersion(file, { platform = process.platform, env = process.env, spawnFn = spawn, timeout = VERSION_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      const spec = spawnSpec(file, ['--version'], { platform, env });
      child = spawnFn(spec.command, spec.args, { ...spec.options, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      resolve({ ok: false, version: null, error: e.message });
      return;
    }
    let out = '';
    let err = '';
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      try { killTree(child, { platform, hard: true, spawnFn }); } catch { /* already gone */ }
      done({ ok: false, version: null, error: 'timed out' });
    }, timeout);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => done({ ok: false, version: null, error: e.code || e.message }));
    child.on('close', (code) => {
      const m = out.match(/\d+\.\d+\.\d+\S*/);
      if (code === 0 && out.trim()) done({ ok: true, version: m ? m[0] : out.trim().slice(0, 40), error: null });
      else done({ ok: false, version: null, error: (err.trim() || out.trim() || `exit code ${code}`).slice(0, 160) });
    });
  });
}

// ---- status for the page, the CLI and the error messages ----

let cache = null;
export const clearClaudeCache = () => { cache = null; };

/**
 * Is Claude Code usable? Located AND `--version` runs (cached 60 s; `force` re-checks). Login cannot be verified without
 * a paid call, so it is not checked here: an auth failure is reported by the call itself (see classifyFailure).
 * -> {available, path, short_path, version, via, reason, detail, tried[]}
 */
export async function checkClaude({
  force = false, platform = process.platform, env = process.env, home = os.homedir(), override = config.claudeOverride(),
  isFile = defaultIsFile, readdir = defaultReaddir, run = runVersion,
} = {}) {
  const key = JSON.stringify([override || '', envVar(env, 'PATH', platform) || '', platform]);
  if (!force && cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.value;
  const found = locateClaude({ platform, env, home, override, isFile, readdir });
  let value;
  if (!found.path) {
    value = { available: false, reason: found.reason, path: null, version: null, via: found.via || null, detail: null, tried: found.tried };
  } else {
    const r = await run(found.path, { platform, env });
    value = r.ok
      ? { available: true, reason: null, path: found.path, version: r.version, via: found.via, detail: null, tried: found.tried }
      : { available: false, reason: 'not-working', path: found.path, version: null, via: found.via, detail: r.error, tried: found.tried };
  }
  value.short_path = value.path ? shortenPath(value.path, home, platform) : null;
  cache = { key, at: Date.now(), value };
  return value;
}

/** One friendly paragraph for a status or a failure code. Plain text: the page and the terminal both show it. */
export function unavailableMessage(status) {
  const fix = `Install Claude Code (${INSTALL_URL}) and run \`claude\` once to log in. Already installed? Tell taskrecap where it is: ` +
    'start it with `--claude-path <full path to claude>` or set TASKRECAP_CLAUDE. Run `taskrecap doctor` for a step-by-step check.';
  const where = status.tried && status.tried.length > 1 ? ` Looked in: ${status.tried.slice(0, 6).join(', ')}${status.tried.length > 6 ? ', ...' : ''}.` : '';
  switch (status.reason) {
    case 'override-not-found':
      return `The Claude path you set (${(status.tried || ['?'])[0]}) does not exist. Fix --claude-path / TASKRECAP_CLAUDE or remove it to search automatically.`;
    case 'not-working':
      return `Claude Code was found at ${status.short_path || 'its install folder'} but it did not run (${status.detail || 'unknown error'}). ` +
        'Open a terminal and try `claude --version`; reinstall it if that fails, then check again.';
    case 'not-logged-in':
      return 'Claude Code is installed but not logged in. Open a terminal, run `claude`, log in, then try again. Browsing and free search work without it.';
    default:
      return `Claude Code was not found on this computer, so AI actions cannot run (browsing and free search still work).${where} ${fix}`;
  }
}

/** Classify the text a failed `claude -p` printed: 'not-logged-in', 'not-found' (the shell could not find it) or null. */
export function classifyFailure(text) {
  const t = String(text || '');
  if (/the term '[^']*' is not recognized|is not recognized as (an internal or external command|the name of a cmdlet)|command not found|no such file or directory.*claude|ENOENT/i.test(t)) return 'not-found';
  if (/not logged in|please run \/login|run \/login|invalid api key|authentication_error|oauth token (has )?expired|unauthorized|\b401\b/i.test(t)) return 'not-logged-in';
  return null;
}

/** What the page and the CLI get: nothing sensitive beyond a home-shortened path. */
export function publicStatus(status) {
  return {
    available: status.available, path: status.short_path || null, version: status.version || null, via: status.via || null,
    reason: status.reason || null, tried: status.tried || [], message: status.available ? null : unavailableMessage(status),
  };
}
