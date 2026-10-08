// Local web server (node:http only). Binds to 127.0.0.1; nothing leaves your machine except the explicit
// `claude -p` calls you confirm.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Busy, UserError, WEB_DIR, listLangs } from './app.js';
import { EvidenceError } from './evidence.js';
import { LLMUnavailable } from './llm.js';

export const HOST = '127.0.0.1';
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const MAX_BODY_BYTES = 1024 * 1024;

/** 'localhost:8765' -> 'localhost'; '' for missing values. */
export function hostOf(value) {
  return String(value || '').trim().toLowerCase().replace(/:\d+$/, '');
}

function send(res, code, body, ctype = 'application/json; charset=utf-8') {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(ctype.startsWith('application/json') ? JSON.stringify(body) : String(body), 'utf8');
  res.writeHead(code, {
    'Content-Type': ctype,
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(data);
}

const sendError = (res, code, msg) => send(res, code, { error: msg });

/** Blocks DNS-rebinding and cross-site requests: only our own page may talk to the API. */
function localOnly(req, res) {
  if (!LOCAL_HOSTS.has(hostOf(req.headers.host))) {
    sendError(res, 403, 'Forbidden host');
    return false;
  }
  const origin = req.headers.origin;
  if (origin && !LOCAL_HOSTS.has(hostOf(origin.replace(/^https?:\/\//, '')))) {
    sendError(res, 403, 'Forbidden origin');
    return false;
  }
  return true;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new UserError('Request too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new UserError('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** Maps an app error to an HTTP status and a message for the page. */
function errorInfo(e) {
  if (e instanceof EvidenceError) return { status: e.code === 'bad_request' ? 400 : e.code === 'ambiguous' ? 409 : 404, message: e.message, code: e.code };
  if (e instanceof UserError) return { status: 400, message: e.message };
  if (e instanceof Busy) return { status: 409, message: 'This capsule is already being generated' };
  if (e instanceof LLMUnavailable) return { status: 503, message: e.message, code: e.code };
  return { status: 500, message: `Request failed: ${e.message}` }; // surface LLM/runtime failures to the page
}

function fail(res, e) {
  const { status, message, code } = errorInfo(e);
  return send(res, status, code ? { error: message, code } : { error: message });
}

/**
 * Runs an AI action and streams its progress as NDJSON (one JSON event per line). If the page closes the connection
 * (Cancel button, closed tab) the action is aborted: the `claude -p` processes are killed and nothing is saved.
 * Errors raised before the first event keep their normal HTTP status; later ones arrive as an {type:'error'} event.
 */
async function streamAction(res, run) {
  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) abort.abort();
  });
  let started = false;
  let lastUsage = null; // the closing events (done / error) carry the usage of the last progress event
  const emit = (event) => {
    if (res.writableEnded || res.destroyed) return;
    if (event.usage) lastUsage = event.usage;
    event = { ts: new Date().toISOString(), usage: lastUsage, ...event };
    if (!started) {
      started = true;
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
    }
    res.write(JSON.stringify(event) + '\n');
  };
  try {
    const result = await run({ emit, signal: abort.signal });
    emit({ type: 'done', result });
    res.end();
  } catch (e) {
    if (abort.signal.aborted) {
      if (!res.writableEnded) res.end();
      return;
    }
    if (!started) return fail(res, e);
    emit({ type: 'error', message: errorInfo(e).message, code: e.name });
    res.end();
  }
}

/** Query string of /api/timeline -> options of buildTimeline (anything malformed is simply ignored). */
export function timelineOptions(q) {
  const opts = {};
  if (q.get('repo')) opts.repo = q.get('repo');
  if (q.get('from')) opts.from = q.get('from');
  if (q.get('to')) opts.to = q.get('to');
  if (q.get('capsule') === 'none' || q.get('capsule') === 'ready') opts.capsule = q.get('capsule');
  if (q.has('keys')) opts.keys = q.get('keys').split('\n').filter(Boolean);
  const limit = q.get('limit');
  if (limit === 'all') opts.limit = 'all';
  else if (/^\d{1,4}$/.test(limit || '') && Number(limit) > 0) opts.limit = Number(limit);
  return opts;
}

export function makeHandler(app) {
  return async (req, res) => {
    try {
      if (!localOnly(req, res)) return;
      const url = new URL(req.url, 'http://localhost');
      const route = url.pathname.replace(/\/+$/, '') || '/';
      if (req.method === 'GET') return await handleGet(app, url, route, res);
      if (req.method === 'POST') return await handlePost(app, req, route, res);
      return sendError(res, 405, 'Method not allowed');
    } catch (e) {
      return fail(res, e);
    }
  };
}

/** The only static files the page may load, by URL. Anything else under web/ (or outside it) is never served. */
export const WEB_ASSETS = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  ...Object.fromEntries(['core', 'home', 'timeline', 'ai', 'files', 'detail', 'evidence', 'main'].map((n) => [`/js/${n}.js`, [`js/${n}.js`, 'text/javascript; charset=utf-8']])),
};

async function handleGet(app, url, route, res) {
  if (Object.hasOwn(WEB_ASSETS, route)) {
    const [file, ctype] = WEB_ASSETS[route];
    return send(res, 200, fs.readFileSync(path.join(WEB_DIR, file)), ctype);
  }
  if (route === '/api/info') return send(res, 200, { ...app.info(), ai: await app.aiStatus() });
  if (route === '/api/ai') return send(res, 200, await app.aiStatus(url.searchParams.get('force') === '1')); // "check again" after installing Claude Code
  if (route === '/api/strings') return send(res, 200, app.stringsFor(url.searchParams.get('lang')));
  if (route === '/api/langs') return send(res, 200, { langs: listLangs() });
  if (route === '/api/usage') return send(res, 200, app.usageSnapshot());
  if (route === '/api/tasks') return send(res, 200, { tasks: app.listTasks() });
  if (route === '/api/timeline') return send(res, 200, app.timeline(timelineOptions(url.searchParams)));
  const m = route.match(/^\/api\/tasks\/(.+)$/);
  if (m) {
    const detail = app.taskDetail(decodeURIComponent(m[1]));
    return detail ? send(res, 200, detail) : sendError(res, 404, 'Unknown task');
  }
  if (route === '/api/search') return send(res, 200, { hits: app.search(url.searchParams.get('q') || ''), searched: app.searchCoverage() });
  if (route === '/api/files') return send(res, 200, app.findFiles(url.searchParams.get('q') || ''));
  if (route === '/api/files/tasks') return send(res, 200, app.fileTasks(url.searchParams.get('path') || ''));
  if (route === '/api/messages') {
    const q = url.searchParams;
    return send(res, 200, app.sessionMessages({ key: q.get('key') || '', session: q.get('session'), scope: q.get('scope') || 'all', offset: q.get('offset'), limit: q.get('limit') }));
  }
  if (route === '/api/evidence') {
    const q = url.searchParams;
    return send(res, 200, app.evidence({ session: q.get('session'), turn: q.get('turn'), context: q.has('context') ? q.get('context') : undefined, key: q.get('key') || '' }));
  }
  if (route === '/api/estimate') return send(res, 200, app.estimate(url.searchParams.get('key') || ''));
  if (route === '/api/ai-search/estimate') return send(res, 200, app.estimateSearch(url.searchParams.get('q') || ''));
  return sendError(res, 404, 'Not found');
}

async function handlePost(app, req, route, res) {
  const isGenerate = route === '/api/generate';
  const isAiSearch = route === '/api/ai-search';
  if (!isGenerate && !isAiSearch) return sendError(res, 404, 'Not found');
  if (!(req.headers['content-type'] || '').includes('application/json')) return sendError(res, 415, 'JSON required');
  const body = await readJson(req);
  if (body.confirm !== true) { // spending tokens always needs an explicit confirmation
    return sendError(res, 400, `Confirmation required: send ${isGenerate ? '{"key": ..., ' : '{"query": ..., '}"confirm": true}`);
  }
  const key = String(body.key || '');
  const query = String(body.query || '');
  if ((req.headers.accept || '').includes('application/x-ndjson')) { // live progress
    return streamAction(res, (opts) => (isGenerate ? app.generate(key, opts) : app.aiSearch(query, opts)));
  }
  return send(res, 200, isGenerate ? await app.generate(key) : await app.aiSearch(query));
}

/** Start listening on `port`; if it is busy, try the next ones (port 0 = any free port). -> {server, port, url} */
export async function startServer(app, port = 8765, { maxTries = 20 } = {}) {
  const handler = makeHandler(app);
  for (let i = 0; i < (port === 0 ? 1 : maxTries); i++) {
    const server = http.createServer(handler);
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port === 0 ? 0 : port + i, HOST, resolve);
      });
      const actual = server.address().port;
      return { server, port: actual, url: `http://${HOST}:${actual}/` };
    } catch (e) {
      server.close();
      if (e.code !== 'EADDRINUSE') throw e;
    }
  }
  throw new Error(`No free port found from ${port} to ${port + maxTries - 1}. Use --port.`);
}

/** Open `url` in the default browser. Never throws: if it fails, the URL is already printed. */
export function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];
  try {
    const child = spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* ignore */
  }
}
