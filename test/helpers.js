// Shared test helpers (this file contains no tests).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wc-test-'));
}

/** prompts: [[ts, userText, assistantText, [[tool, input, resultOrNull]]]] -> <projectsDir>/<proj>/<sid>.jsonl */
export function makeSession(projectsDir, sid, prompts, { proj = 'proj', branch = 'main', cwd = '/x/app' } = {}) {
  const dir = path.join(projectsDir, proj);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sid}.jsonl`);
  const lines = [];
  for (const [ts, user, asst, tools = []] of prompts) {
    const base = { timestamp: ts, gitBranch: branch, cwd };
    lines.push({ type: 'user', ...base, message: { content: user } });
    const blocks = [{ type: 'text', text: asst }];
    const results = [];
    tools.forEach(([name, input, res], n) => {
      blocks.push({ type: 'tool_use', id: `tu${n}`, name, input });
      if (res != null) results.push({ type: 'tool_result', tool_use_id: `tu${n}`, content: res });
    });
    lines.push({ type: 'assistant', ...base, message: { content: blocks } });
    if (results.length) lines.push({ type: 'user', ...base, message: { content: results } });
  }
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

/** Stands in for the LLM: answers range, capsule and AI-search prompts deterministically. */
export async function fakeAsk(prompt) {
  if (prompt.includes('State which turn ranges')) {
    return [JSON.stringify({ ranges: [{ start: 0, end: 1, reason: 'x' }] }), { cost_usd: 0.01, input_tokens: 10, output_tokens: 5 }];
  }
  if (prompt.includes('You help a developer find work')) {
    return [JSON.stringify({ matches: [{ key: 'KK-1', reason: 'about the thing' }, { key: 'MADE-UP-9', reason: 'invented' }] }),
      { cost_usd: 0.005, input_tokens: 200, output_tokens: 20 }];
  }
  const cap = {
    objective: 'Fix the thing',
    timeline: [{ date: '01-01', repo: 'app', result: 'done', cites: [{ session: 'AAAAAAAA', turn: 0 }] }],
    decisions: [
      { decision: 'Use cents', why: 'floats drift', cites: [{ session: 'AAAAAAAA', turn: 1 }] },
      { decision: 'Uncited', why: 'no evidence', cites: [] },
    ],
    dead_ends: [], left_out: [], pending: [{ text: 'more tests', cites: [] }], briefing: 'Resume the thing.',
  };
  return [JSON.stringify(cap), { cost_usd: 0.02, input_tokens: 100, output_tokens: 50 }];
}

export const ts = (m) => `2026-01-01T00:${String(m).padStart(2, '0')}:00Z`;
