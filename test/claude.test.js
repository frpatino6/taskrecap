import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';
import { App } from '../src/app.js';
import { cmdDoctor } from '../src/cli.js';
import {
  checkClaude, classifyFailure, clearClaudeCache, escapeCmdArgument, isSafeModel, killTree, knownLocations, locateClaude,
  publicStatus, runVersion, shortenPath, spawnSpec, unavailableMessage,
} from '../src/claude.js';
import * as config from '../src/config.js';
import { LLMUnavailable, askLlm, mapFailure } from '../src/llm.js';
import { startServer } from '../src/server.js';
import { tmpDir } from './helpers.js';
import { WEB } from './web_assets.js';

// ---- fake file systems: the resolver only needs isFile/readdir, so win32, darwin and linux are all testable here ----
const W = path.win32;
const WIN = {
  platform: 'win32', home: 'C:\\Users\\bob',
  env: {
    PATH: 'C:\\Tools;C:\\Users\\bob\\bin', PATHEXT: '.COM;.EXE;.BAT;.CMD', USERPROFILE: 'C:\\Users\\bob',
    APPDATA: 'C:\\Users\\bob\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\bob\\AppData\\Local',
  },
};
const fsOf = (files, dirs = {}) => ({ isFile: (p) => files.includes(p), readdir: (d) => dirs[d] || [] });

// ---- shortenPath ----
test('shortenPath hides the home folder, on posix and on Windows (case-insensitive), and leaves other paths alone', () => {
  assert.equal(shortenPath('/Users/me/.local/bin/claude', '/Users/me', 'darwin'), '~/.local/bin/claude');
  assert.equal(shortenPath('/usr/local/bin/claude', '/Users/me', 'darwin'), '/usr/local/bin/claude');
  assert.equal(shortenPath('/Users/menu/x', '/Users/me', 'linux'), '/Users/menu/x'); // a sibling folder sharing a prefix is not "home"
  assert.equal(shortenPath('C:\\USERS\\bob\\AppData\\Roaming\\npm\\claude.cmd', 'C:\\Users\\bob', 'win32'), '~\\AppData\\Roaming\\npm\\claude.cmd');
  assert.equal(shortenPath('D:\\tools\\claude.exe', 'C:\\Users\\bob', 'win32'), 'D:\\tools\\claude.exe');
});

// ---- locating the executable ----
test('win32: PATH search honours PATHEXT and prefers a real .exe over a .cmd shim in the same folder', () => {
  const f = fsOf(['C:\\Users\\bob\\bin\\claude.cmd', 'C:\\Users\\bob\\bin\\claude.exe']);
  const r = locateClaude({ ...WIN, ...f, override: null });
  assert.equal(r.path, 'C:\\Users\\bob\\bin\\claude.exe');
  assert.equal(r.via, 'path');
});

test('win32: only a .cmd shim on PATH is found; the variable may be called Path and PATHEXT may be missing', () => {
  const env = { Path: 'C:\\Tools;C:\\Users\\bob\\bin', USERPROFILE: 'C:\\Users\\bob' };
  const r = locateClaude({ ...WIN, env, ...fsOf(['C:\\Users\\bob\\bin\\claude.cmd']), override: null });
  assert.equal(r.path, 'C:\\Users\\bob\\bin\\claude.cmd');
});

test('win32: a bare extensionless "claude" file (a Unix-style script) is never picked', () => {
  const r = locateClaude({ ...WIN, ...fsOf(['C:\\Tools\\claude']), override: null });
  assert.equal(r.path, null);
});

test('win32: not on PATH -> well-known install folders (native installer, npm global, Programs\\claude*)', () => {
  const native = locateClaude({ ...WIN, ...fsOf(['C:\\Users\\bob\\.local\\bin\\claude.exe']), override: null });
  assert.equal(native.path, 'C:\\Users\\bob\\.local\\bin\\claude.exe');
  assert.equal(native.via, 'known-location');
  const npm = locateClaude({ ...WIN, ...fsOf(['C:\\Users\\bob\\AppData\\Roaming\\npm\\claude.cmd']), override: null });
  assert.equal(npm.path, 'C:\\Users\\bob\\AppData\\Roaming\\npm\\claude.cmd');
  const programs = 'C:\\Users\\bob\\AppData\\Local\\Programs';
  const app = locateClaude({ ...WIN, ...fsOf([W.join(programs, 'Claude Code', 'claude.exe')], { [programs]: ['Notepad++', 'Claude Code'] }), override: null });
  assert.equal(app.path, W.join(programs, 'Claude Code', 'claude.exe'));
});

test('darwin and linux: PATH first, then ~/.local/bin, /opt/homebrew/bin, nvm (newest version first)', () => {
  const base = { platform: 'darwin', home: '/Users/me', env: { PATH: '/usr/bin:/bin' } };
  assert.equal(locateClaude({ ...base, ...fsOf(['/bin/claude']), override: null }).path, '/bin/claude');
  assert.equal(locateClaude({ ...base, ...fsOf(['/Users/me/.local/bin/claude']), override: null }).via, 'known-location');
  assert.equal(locateClaude({ ...base, ...fsOf(['/opt/homebrew/bin/claude']), override: null }).path, '/opt/homebrew/bin/claude');
  const nvm = '/home/me/.nvm/versions/node';
  const linux = locateClaude({
    platform: 'linux', home: '/home/me', env: { PATH: '/usr/bin' }, override: null,
    ...fsOf([`${nvm}/v20.1.0/bin/claude`, `${nvm}/v22.2.0/bin/claude`], { [nvm]: ['v20.1.0', 'v22.2.0'] }),
  });
  assert.equal(linux.path, `${nvm}/v22.2.0/bin/claude`);
});

test('an explicit override beats PATH and the known folders; a bare name is searched on PATH', () => {
  const f = fsOf(['C:\\Users\\bob\\bin\\claude.exe', 'D:\\mine\\claude.exe', 'C:\\Tools\\other.cmd']);
  const byPath = locateClaude({ ...WIN, ...f, override: 'D:\\mine\\claude.exe' });
  assert.equal(byPath.path, 'D:\\mine\\claude.exe');
  assert.equal(byPath.via, 'override');
  assert.equal(locateClaude({ ...WIN, ...f, override: 'D:\\mine\\claude' }).path, 'D:\\mine\\claude.exe'); // extension added
  assert.equal(locateClaude({ ...WIN, ...f, override: 'other' }).path, 'C:\\Tools\\other.cmd');
});

test('an override that does not exist is an error: it is NOT silently replaced by another claude', () => {
  const r = locateClaude({ ...WIN, ...fsOf(['C:\\Users\\bob\\bin\\claude.exe']), override: 'D:\\typo\\claude.exe' });
  assert.equal(r.path, null);
  assert.equal(r.reason, 'override-not-found');
  assert.match(unavailableMessage(r), /does not exist/);
});

test('not found anywhere: the answer lists what was looked at, with the home folder shortened', () => {
  const r = locateClaude({ ...WIN, ...fsOf([]), override: null });
  assert.equal(r.path, null);
  assert.equal(r.reason, 'not-found');
  assert.equal(r.tried[0], 'PATH');
  assert.ok(r.tried.some((t) => t === '~\\.local\\bin\\claude.exe'), r.tried.join('|'));
  assert.ok(r.tried.every((t) => !t.startsWith('C:\\Users\\bob')), 'no full home path leaks');
  assert.deepEqual(knownLocations({ ...WIN, readdir: () => [] }).slice(0, 2), ['C:\\Users\\bob\\.local\\bin\\claude.exe', 'C:\\Users\\bob\\AppData\\Roaming\\npm\\claude.cmd']);
});

// ---- starting it ----
test('win32: a real .exe is spawned directly; a .cmd shim goes through cmd.exe with the verbatim-arguments flag', () => {
  const args = ['-p', '--system-prompt', 'You are an analyst. Reply ONLY with JSON, please.', '--setting-sources', ''];
  const exe = spawnSpec('C:\\Users\\bob\\.local\\bin\\claude.exe', args, WIN);
  assert.deepEqual([exe.command, exe.args], ['C:\\Users\\bob\\.local\\bin\\claude.exe', args]);
  const cmd = spawnSpec('C:\\Users\\bob\\AppData\\Roaming\\npm\\claude.cmd', args, WIN);
  assert.equal(cmd.command, 'cmd.exe');
  assert.deepEqual(cmd.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(cmd.options.windowsVerbatimArguments, true);
  assert.match(cmd.args[3], /^".*"$/);
  assert.equal(spawnSpec('C:\\x\\claude.cmd', ['-p'], { ...WIN, env: { ...WIN.env, ComSpec: 'C:\\Windows\\System32\\cmd.exe' } }).command, 'C:\\Windows\\System32\\cmd.exe');
});

test('cmd.exe quoting: a path with spaces and & and hostile arguments never leave an unescaped metacharacter', () => {
  const spec = spawnSpec('C:\\Program Files\\a & b\\claude.cmd', ['--model', 'x" & calc & "y', '--note', '100% (done)|^!'], WIN);
  const line = spec.args[3];
  assert.ok(line.includes('a^ ^&^ b'), line);
  for (const ch of ['&', '|', '<', '>', '(', ')', '%', '!']) {
    const bare = new RegExp(`(?<!\\^)\\${ch}`);
    assert.doesNotMatch(line, bare, `unescaped ${ch}: ${line}`);
  }
  assert.doesNotMatch(escapeCmdArgument('a" & echo pwned'), /(?<!\^)&/);
  assert.equal(escapeCmdArgument('', false), '^"^"'); // an empty argument stays an (escaped) empty pair of quotes
});

test('cmd.exe refuses a multi-line argument (it would end the command line); the prompt itself never travels as an argument', () => {
  assert.throws(() => spawnSpec('C:\\x\\claude.cmd', ['--system-prompt', 'a\nb'], WIN), /multi-line/);
  const source = fs.readFileSync(new URL('../src/llm.js', import.meta.url), 'utf8');
  assert.match(source, /child\.stdin\.end\(prompt\)/);
  assert.doesNotMatch(source, /args\.push\(prompt\)|'-p', prompt/);
});

test('posix: spawnSpec is the plain executable and arguments, whatever the path', () => {
  assert.deepEqual(spawnSpec('/Users/me/My Tools/claude', ['-p'], { platform: 'darwin' }), { command: '/Users/me/My Tools/claude', args: ['-p'], options: {} });
});

test('only plain model aliases and ids may reach the command line', () => {
  for (const ok of ['sonnet', 'opus', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001', 'sonnet[1m]']) assert.ok(isSafeModel(ok), ok);
  for (const bad of ['', 'a b', 'x&calc', 'x"y', 'a\nb', 'x|y', '$(id)', 'a'.repeat(200)]) assert.ok(!isSafeModel(bad), JSON.stringify(bad));
});

test('killTree: Windows kills the whole tree with taskkill /T /F; posix sends SIGTERM (SIGKILL when hard)', () => {
  const calls = [];
  const spawnFn = (cmd, args) => { calls.push([cmd, ...args]); return { on() {} }; };
  killTree({ pid: 4242, kill() { throw new Error('plain kill must not be used'); } }, { platform: 'win32', spawnFn });
  assert.deepEqual(calls[0], ['taskkill', '/pid', '4242', '/T', '/F']);
  const sent = [];
  killTree({ pid: 1, kill: (s) => sent.push(s) }, { platform: 'linux', hard: true });
  killTree({ pid: 1, kill: (s) => sent.push(s) }, { platform: 'darwin' });
  assert.deepEqual(sent, ['SIGKILL', 'SIGTERM']);
});

// ---- failures -> friendly messages ----
test('classifyFailure recognises "not logged in" and "claude is not recognized" (cmd.exe and PowerShell), and nothing else', () => {
  assert.equal(classifyFailure('claude -p error: Invalid API key · Please run /login'), 'not-logged-in');
  assert.equal(classifyFailure('Error: not logged in'), 'not-logged-in');
  assert.equal(classifyFailure("The term 'claude' is not recognized as the name of a cmdlet, function, script file, or operable program."), 'not-found');
  assert.equal(classifyFailure("'claude' is not recognized as an internal or external command"), 'not-found');
  assert.equal(classifyFailure('sh: claude: command not found'), 'not-found');
  assert.equal(classifyFailure('claude -p timed out'), null);
  assert.equal(classifyFailure(''), null);
});

test('mapFailure turns those into LLMUnavailable with the right code, and leaves other errors untouched', () => {
  const login = mapFailure(new Error('claude -p failed (1): Please run /login'));
  assert.ok(login instanceof LLMUnavailable);
  assert.equal(login.code, 'not-logged-in');
  assert.match(login.message, /not logged in/);
  const lost = mapFailure(new Error("The term 'claude' is not recognized"), { tried: ['PATH', '~/x/claude'] });
  assert.equal(lost.code, 'not-found');
  assert.match(lost.message, /--claude-path/);
  assert.match(lost.message, /TASKRECAP_CLAUDE/);
  const other = new Error('boom');
  assert.equal(mapFailure(other), other);
});

test('the friendly messages say what to do and never print the raw shell error', () => {
  const m = unavailableMessage({ reason: 'not-found', tried: ['PATH', '~/.local/bin/claude'] });
  assert.match(m, /https:\/\/claude\.com\/claude-code/);
  assert.match(m, /taskrecap doctor/);
  assert.match(m, /browsing and free search still work/);
  assert.match(m, /Looked in: PATH, ~\/\.local\/bin\/claude/);
  assert.doesNotMatch(m, /cmdlet|operable program/);
  assert.match(unavailableMessage({ reason: 'not-working', short_path: '~/bin/claude', detail: 'EACCES' }), /~\/bin\/claude.*EACCES/s);
});

// ---- status check ----
test('checkClaude: found + version ok -> available; found but --version fails -> not-working; nothing -> not-found', async () => {
  clearClaudeCache();
  const okRun = async () => ({ ok: true, version: '2.1.9', error: null });
  const bad = await checkClaude({ ...WIN, ...fsOf(['C:\\Users\\bob\\bin\\claude.exe']), override: null, run: async () => ({ ok: false, version: null, error: 'EACCES' }), force: true });
  assert.equal(bad.available, false);
  assert.equal(bad.reason, 'not-working');
  assert.equal(bad.detail, 'EACCES');
  assert.equal(bad.short_path, '~\\bin\\claude.exe');
  const none = await checkClaude({ ...WIN, ...fsOf([]), override: null, run: okRun, force: true });
  assert.deepEqual([none.available, none.reason], [false, 'not-found']);
  const good = await checkClaude({ ...WIN, ...fsOf(['C:\\Users\\bob\\bin\\claude.exe']), override: null, run: okRun, force: true });
  assert.deepEqual([good.available, good.version, good.via], [true, '2.1.9', 'path']);
  clearClaudeCache();
});

test('checkClaude caches the answer, and force re-checks (the "Check again" button)', async () => {
  clearClaudeCache();
  let runs = 0;
  const present = new Set();
  const opts = { ...WIN, override: null, isFile: (p) => present.has(p), readdir: () => [], run: async () => { runs += 1; return { ok: true, version: '2.0.0', error: null }; } };
  assert.equal((await checkClaude(opts)).available, false); // nothing installed yet
  present.add('C:\\Users\\bob\\bin\\claude.exe');
  assert.equal((await checkClaude(opts)).available, false); // cached
  assert.equal(runs, 0);
  assert.equal((await checkClaude({ ...opts, force: true })).available, true); // installed meanwhile
  assert.equal(runs, 1);
  clearClaudeCache();
});

test('publicStatus exposes only a shortened path, the reason, the places tried and the message', () => {
  const p = publicStatus({ available: false, reason: 'not-found', path: null, short_path: null, version: null, via: null, tried: ['PATH'], detail: 'secret detail' });
  assert.deepEqual(Object.keys(p).sort(), ['available', 'message', 'path', 'reason', 'tried', 'version', 'via']);
  assert.match(p.message, /not found/);
  assert.equal(publicStatus({ available: true, short_path: '~/c', version: '2', via: 'path', tried: ['PATH'] }).message, null);
});

// ---- real processes (posix only: these use a #! script as a fake claude) ----
const posix = process.platform !== 'win32';
const fakeBin = (dir, body, name = 'claude') => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!${process.execPath}\n${body}`);
  fs.chmodSync(file, 0o755);
  return file;
};

test('runVersion parses the version, and reports a failing or missing program without throwing', { skip: !posix }, async () => {
  const dir = tmpDir();
  assert.deepEqual(await runVersion(fakeBin(dir, "console.log('2.3.4 (Claude Code)')")), { ok: true, version: '2.3.4', error: null });
  const fail = await runVersion(fakeBin(dir, "console.error('broken install'); process.exit(3)", 'c2'));
  assert.equal(fail.ok, false);
  assert.match(fail.error, /broken install/);
  const missing = await runVersion(path.join(dir, 'nope'));
  assert.equal(missing.ok, false);
});

async function withOverride(value, fn) {
  const before = process.env.TASKRECAP_CLAUDE;
  const beforeOld = process.env.TASKRECAP_CLAUDE_BIN;
  process.env.TASKRECAP_CLAUDE = value;
  delete process.env.TASKRECAP_CLAUDE_BIN;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.TASKRECAP_CLAUDE; else process.env.TASKRECAP_CLAUDE = before;
    if (beforeOld !== undefined) process.env.TASKRECAP_CLAUDE_BIN = beforeOld;
  }
}

test('askLlm: a path that does not exist -> LLMUnavailable (override-not-found) before anything is started', async () => {
  await withOverride(path.join(tmpDir(), 'missing', 'claude'), async () => {
    await assert.rejects(() => askLlm('hi'), (e) => e instanceof LLMUnavailable && e.code === 'override-not-found' && /does not exist/.test(e.message));
  });
});

test('askLlm: a model name with shell characters is refused', async () => {
  await assert.rejects(() => askLlm('hi', { model: 'sonnet & calc' }), /Unsupported model name/);
});

test('askLlm: Claude Code that says "please run /login" -> LLMUnavailable (not-logged-in) with the fix, not a raw error', { skip: !posix }, async () => {
  const file = fakeBin(tmpDir(), "console.error('Invalid API key · Please run /login'); process.exit(1)");
  await withOverride(file, async () => {
    await assert.rejects(() => askLlm('hi'), (e) => e instanceof LLMUnavailable && e.code === 'not-logged-in' && /run `claude`/.test(e.message));
  });
});

test('askLlm: the prompt reaches Claude through stdin, whatever characters it has', { skip: !posix }, async () => {
  const body = "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.stringify({result:d,usage:{input_tokens:1,output_tokens:1}})));";
  await withOverride(fakeBin(tmpDir(), body), async () => {
    const [text] = await askLlm('a & b | "c" `d` $(e)\nline2 %PATH% ^!');
    assert.equal(text, 'a & b | "c" `d` $(e)\nline2 %PATH% ^!');
  });
});

test('--claude-path (setClaudePath) beats TASKRECAP_CLAUDE, which beats the older TASKRECAP_CLAUDE_BIN', () => {
  const keep = [process.env.TASKRECAP_CLAUDE, process.env.TASKRECAP_CLAUDE_BIN];
  try {
    config.setClaudePath(null);
    delete process.env.TASKRECAP_CLAUDE;
    process.env.TASKRECAP_CLAUDE_BIN = '/old';
    assert.equal(config.claudeOverride(), '/old');
    process.env.TASKRECAP_CLAUDE = '/env';
    assert.equal(config.claudeOverride(), '/env');
    config.setClaudePath('/flag');
    assert.equal(config.claudeOverride(), '/flag');
    config.setClaudePath(null);
    delete process.env.TASKRECAP_CLAUDE;
    delete process.env.TASKRECAP_CLAUDE_BIN;
    assert.equal(config.claudeOverride(), null);
    assert.equal(config.claudeBin(), 'claude');
  } finally {
    config.setClaudePath(null);
    for (const [i, k] of ['TASKRECAP_CLAUDE', 'TASKRECAP_CLAUDE_BIN'].entries()) {
      if (keep[i] === undefined) delete process.env[k]; else process.env[k] = keep[i];
    }
  }
});

// ---- server: /api/info carries `ai`, /api/ai re-checks, 503 keeps the code ----
const getJson = (srv, route) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: srv.port, path: route }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }));
  }).on('error', reject);
});

test('/api/info has an ai field; with an injected model it is available', async () => {
  const tmp = tmpDir();
  const app = new App({ projectsDir: path.join(tmp, 'p'), cacheDir: path.join(tmp, 'c'), usageFile: path.join(tmp, 'u.json'), ask: async () => '{}' });
  const srv = await startServer(app, 0);
  try {
    const r = await getJson(srv, '/api/info');
    assert.equal(r.body.ai.available, true);
    assert.equal(r.body.name, 'taskrecap');
    assert.equal((await getJson(srv, '/api/ai?force=1')).body.available, true);
  } finally {
    srv.server.close();
  }
});

test('/api/info reports AI off (with the message and what was tried) when Claude Code cannot be found, and free routes still work', async () => {
  const tmp = tmpDir();
  const app = new App({ projectsDir: path.join(tmp, 'p'), cacheDir: path.join(tmp, 'c'), usageFile: path.join(tmp, 'u.json') }); // no injected ask: the real resolver
  const srv = await startServer(app, 0);
  clearClaudeCache();
  try {
    await withOverride(path.join(tmp, 'no-such', 'claude'), async () => {
      const info = (await getJson(srv, '/api/info')).body;
      assert.equal(info.ai.available, false);
      assert.equal(info.ai.reason, 'override-not-found');
      assert.match(info.ai.message, /does not exist/);
      assert.equal((await getJson(srv, '/api/tasks')).status, 200);
    });
  } finally {
    clearClaudeCache();
    srv.server.close();
  }
});

test('an LLMUnavailable during an action comes back as 503 with its code', async () => {
  const tmp = tmpDir();
  const proj = path.join(tmp, 'p');
  const { makeSession, ts } = await import('./helpers.js');
  makeSession(proj, 'AAAAAAAA-1', [[ts(0), 'KK-1 fix', 'ok']]);
  const app = new App({
    projectsDir: proj, cacheDir: path.join(tmp, 'c'), usageFile: path.join(tmp, 'u.json'), votes: 1,
    ask: async () => { throw new LLMUnavailable(unavailableMessage({ reason: 'not-logged-in' }), 'not-logged-in'); },
  });
  const srv = await startServer(app, 0);
  try {
    const r = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: srv.port, method: 'POST', path: '/api/generate', headers: { 'Content-Type': 'application/json' } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      });
      req.on('error', reject);
      req.end(JSON.stringify({ key: 'KK-1', confirm: true }));
    });
    assert.equal(r.status, 503);
    assert.equal(r.body.code, 'not-logged-in');
    assert.match(r.body.error, /not logged in/);
  } finally {
    srv.server.close();
  }
});

// ---- doctor ----
const capture = () => { const lines = []; return { lines, out: { log: (m) => lines.push(String(m)), err: (m) => lines.push(String(m)) } }; };
const demoOpts = { demo: true, regex: config.keyRegex(), votes: 3, model: 'sonnet', lang: 'en' };

test('doctor: everything fine -> exit 0, shows the Claude path/version and says login cannot be verified for free', async () => {
  const { lines, out } = capture();
  const code = await cmdDoctor(demoOpts, out, { claude: async () => ({ available: true, short_path: '~/.local/bin/claude', version: '2.1.9', via: 'known-location', tried: ['PATH'] }), nodeVersion: '22.1.0', platform: 'win32' });
  const text = lines.join('\n');
  assert.equal(code, 0);
  assert.match(text, /\[ok\] Node 22\.1\.0/);
  assert.match(text, /System: win32/);
  assert.match(text, /\[ok\] Sessions folder: .*\(\d+ sessions?\)/);
  assert.match(text, /Claude Code: ~\/\.local\/bin\/claude \(version 2\.1\.9, found in a known install folder, not on PATH\)/);
  assert.match(text, /Login: it cannot be verified without a paid call/);
  assert.match(text, /All good/);
});

test('doctor: Claude Code missing and Node too old -> exit 1 with a "->" next step for each problem', async () => {
  const { lines, out } = capture();
  const code = await cmdDoctor(demoOpts, out, {
    claude: async () => ({ available: false, reason: 'not-found', path: null, short_path: null, version: null, via: null, detail: null, tried: ['PATH', '~/.local/bin/claude'] }),
    nodeVersion: '16.20.0',
  });
  const text = lines.join('\n');
  assert.equal(code, 1);
  assert.match(text, /\[!!\] Node 16\.20\.0 is too old/);
  assert.match(text, /\[!!\] Claude Code was not found/);
  assert.match(text, /-> .*--claude-path/s);
  assert.match(text, /Looked in: PATH, ~\/\.local\/bin\/claude/);
  assert.match(text, /Free mode .* works without Claude Code/);
  assert.match(text, /2 problems found/);
});

// ---- the page: AI buttons off + explanation + "check again" ----
test('page: with ai.available=false the AI buttons are disabled with a tooltip, the note explains the fix, and free mode is untouched', () => {
  const strings = JSON.parse(fs.readFileSync(path.join(WEB, 'strings.en.json'), 'utf8'));
  const els = {};
  const el = (id) => (els[id] ||= { id, disabled: false, innerHTML: '', title: '', removeAttribute(a) { if (a === 'title') this.title = ''; }, querySelectorAll() { return []; } });
  const ctx = vm.createContext({ document: { getElementById: el }, window: {}, fetch() {}, location: {}, localStorage: {} });
  vm.runInContext(fs.readFileSync(path.join(WEB, 'js', 'core.js'), 'utf8'), ctx);
  ctx.strings = strings;
  vm.runInContext('S = strings; INFO = { ai: { available: false, reason: "not-found", tried: ["PATH", "~/.local/bin/claude"] } };', ctx);
  assert.equal(vm.runInContext('aiOn()', ctx), false);
  vm.runInContext('applyAiGate()', ctx);
  assert.equal(els['ai-search'].disabled, true);
  assert.equal(els['none-ai'].disabled, true);
  assert.equal(els['ai-search'].title, strings.ai_off_tooltip);
  assert.match(String(els['ai-note'].innerHTML), /AI actions are unavailable/);
  assert.match(String(els['ai-note'].innerHTML), /--claude-path/);
  assert.match(String(els['ai-note'].innerHTML), /TASKRECAP_CLAUDE/);
  assert.match(String(els['ai-note'].innerHTML), /taskrecap doctor/);
  assert.match(String(els['ai-note'].innerHTML), /Looked for it in: PATH, ~\/\.local\/bin\/claude/);
  assert.match(String(els['ai-note'].innerHTML), /Check again/);
  assert.equal(els.q, undefined); // the search box is never touched
  vm.runInContext('INFO = { ai: { available: true } }; applyAiGate();', ctx);
  assert.equal(els['ai-search'].disabled, false);
  assert.equal(String(els['ai-note'].innerHTML), '');
  assert.equal(vm.runInContext('(INFO = {}, aiOn())', ctx), true); // an older server without the field: AI stays on
});

test('page: the capsule view disables the generate button and shows the same note when Claude Code is missing', () => {
  const detail = fs.readFileSync(path.join(WEB, 'js', 'detail.js'), 'utf8');
  assert.match(detail, /!aiOn\(\)/);
  assert.match(detail, /gen\.disabled = true;[\s\S]*aiOffHtml\(\)[\s\S]*bindAiRecheck\(gb\)/);
  const main = fs.readFileSync(path.join(WEB, 'js', 'main.js'), 'utf8');
  assert.match(main, /applyAiGate\(\);/);
});
