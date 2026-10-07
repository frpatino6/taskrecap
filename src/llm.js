// The ONLY place that talks to a model: headless Claude Code (`claude -p`) with the user's own login.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as config from './config.js';

export const SYSTEM_PROMPT = 'You are an analyst. Reply ONLY with valid JSON: no text before or after, no code fences.';
// Rough list-price assumption (USD per million tokens, Sonnet-class). Only used for the pre-run estimate;
// the real cost reported by `claude -p` is shown after each run.
export const PRICE_IN_PER_MTOK = 3.0;
export const PRICE_OUT_PER_MTOK = 15.0;
export const CALL_OVERHEAD_TOKENS = 4000; // fixed per-call overhead of a headless Claude Code call

/** `claude` is not installed or not on PATH. */
export class LLMUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = 'LLMUnavailable';
  }
}

/** The user cancelled: the running `claude -p` processes were stopped. */
export class Aborted extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'AbortError';
  }
}

export const isAbort = (e) => Boolean(e) && e.name === 'AbortError';

/** Parse the first JSON object in `text` (tolerates code fences / chatter). Throws if none. */
export function extractJson(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```(?:json)?\s*|\s*```$/g, '');
  const start = t.indexOf('{');
  if (start < 0) throw new Error('no JSON object in LLM output');
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (inStr) {
      esc = ch === '\\' && !esc;
      if (ch === '"' && !esc) inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return JSON.parse(t.slice(start, i + 1));
    }
  }
  throw new Error('unterminated JSON object in LLM output');
}

/** Turn the stdout of `claude -p --output-format json` into [text, meta]. meta = real cost + token counts. */
export function parseClaudeOutput(stdout) {
  let out;
  try {
    out = JSON.parse(stdout);
  } catch {
    throw new Error('claude -p returned non-JSON output: ' + String(stdout).slice(0, 200));
  }
  if (out.is_error) throw new Error('claude -p error: ' + String(out.result).slice(0, 300));
  const usage = out.usage || {};
  const meta = {
    cost_usd: out.total_cost_usd == null ? null : out.total_cost_usd,
    input_tokens: (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0),
    output_tokens: usage.output_tokens || 0,
  };
  return [out.result || '', meta];
}

/**
 * Incremental parser for `claude -p --output-format stream-json --include-partial-messages`: calls onText(wholeTextSoFar)
 * as the answer is written; `end()` returns [text, meta] from the final result line (same shape as the json format).
 */
export function makeStreamParser(onText = null) {
  let buf = '';
  let text = '';
  let result = null;
  const line = (raw) => {
    const s = raw.trim();
    if (!s) return;
    let ev;
    try {
      ev = JSON.parse(s);
    } catch {
      return;
    }
    const delta = ev.type === 'stream_event' && ev.event && ev.event.type === 'content_block_delta' && ev.event.delta;
    if (delta && delta.type === 'text_delta') {
      text += delta.text || '';
      if (onText) {
        try {
          onText(text);
        } catch {
          /* a progress listener must never break the call */
        }
      }
    } else if (ev.type === 'result') {
      result = ev;
    }
  };
  return {
    push(chunk) {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        line(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    },
    end() {
      line(buf);
      buf = '';
      if (!result) throw new Error('claude -p ended without a result');
      return parseClaudeOutput(JSON.stringify(result));
    },
  };
}

/**
 * Run one headless Claude Code call. Resolves to [text, meta].
 * `signal` (AbortSignal) kills the process and rejects with Aborted. `onText(textSoFar)` streams the answer as it is written.
 */
export function askLlm(prompt, { model = 'sonnet', budget = 1.5, timeout = 900000, signal = null, onText = null } = {}) {
  if (signal && signal.aborted) return Promise.reject(new Aborted());
  const binary = config.claudeBin();
  const format = onText ? ['stream-json', '--verbose', '--include-partial-messages'] : ['json'];
  const args = [
    '-p', '--output-format', ...format, '--tools', '', '--no-session-persistence',
    '--disable-slash-commands', '--strict-mcp-config', '--setting-sources', '',
    '--system-prompt', SYSTEM_PROMPT, '--model', model, '--max-budget-usd', String(budget),
  ];
  // neutral cwd: no project CLAUDE.md leaks into the call
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'taskrecap-'));
  const cleanup = () => fs.rmSync(cwd, { recursive: true, force: true });
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(binary, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      cleanup();
      reject(e);
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const parser = onText ? makeStreamParser(onText) : null;
    const onAbort = () => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
      done(reject, new Aborted());
    };
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      cleanup();
      fn(v);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done(reject, new Error('claude -p timed out'));
    }, timeout);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      if (parser) parser.push(d);
      else stdout += d;
    });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => {
      if (e.code === 'ENOENT') done(reject, new LLMUnavailable('The `claude` command was not found. Install Claude Code and log in, then retry.'));
      else done(reject, e);
    });
    child.on('close', (code) => {
      if (code !== 0) {
        done(reject, new Error(`claude -p failed (${code}): ${(stderr.trim() || stdout.trim()).slice(0, 300)}`));
        return;
      }
      try {
        done(resolve, parser ? parser.end() : parseClaudeOutput(stdout));
      } catch (e) {
        done(reject, e);
      }
    });
    child.stdin.on('error', () => { /* the close handler reports the failure */ });
    child.stdin.end(prompt);
  });
}

/** Rough pre-run estimate -> {calls, input_tokens, output_tokens, usd, seconds}. Chars/4 ~ tokens. */
export function estimateCost(calls, inputChars, outputTokens) {
  const inputTokens = Math.floor(inputChars / 4) + calls * CALL_OVERHEAD_TOKENS;
  const usd = (inputTokens / 1e6) * PRICE_IN_PER_MTOK + (outputTokens / 1e6) * PRICE_OUT_PER_MTOK;
  const seconds = Math.max(0, calls - 1) * 20 + 45; // range-selection calls are short; the capsule call is the long one
  return { calls, input_tokens: inputTokens, output_tokens: outputTokens, usd: Math.round(usd * 100) / 100, seconds };
}
