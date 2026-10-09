#!/usr/bin/env node
// Maintainer tooling (not published): a stand-in for `claude -p` so the browser checks can drive the WHOLE real stack (estimate,
// confirmation, streaming progress, validation, store) with no network and no spend. It answers the "Organize with AI" prompts from the
// session ids it finds in the skeleton, and the capsule prompts (turn ranges, the capsule itself) from the [s:<id> t:<n> MM-DD...] tags of
// the evidence, like the real model would. Every capsule it writes says "Stand-in capsule" so a check can tell it from the samples.
import fs from 'node:fs';

if (process.argv.includes('--version')) { console.log('2.0.0 (Claude Code, fake for checks)'); process.exit(0); }
const prompt = fs.readFileSync(0, 'utf8');
if (/State which turn ranges/.test(prompt)) {
  const out = JSON.stringify({ ranges: [{ start: 0, end: 1, reason: 'stand-in' }] });
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: out, usage: { input_tokens: 800, output_tokens: 30 }, total_cost_usd: 0.004 }));
  process.exit(0);
}
if (/You are an analyst/.test(prompt)) {
  const seen = new Map();
  for (const m of prompt.matchAll(/\[s:(\S+) t:(\d+) (\d\d-\d\d)T[^\]]*\] USER: ([^\n]*)/g)) if (!seen.has(`${m[1]}:${m[2]}`)) seen.set(`${m[1]}:${m[2]}`, { session: m[1], turn: Number(m[2]), date: m[3], text: m[4].slice(0, 70) });
  const rows = [...seen.values()].slice(0, 4);
  const cite = (r) => [{ session: r.session, turn: r.turn }];
  const capsule = {
    objective: `Stand-in capsule: ${rows[0] ? rows[0].text : 'nothing'}`,
    timeline: rows.map((r) => ({ date: r.date, repo: 'demo', result: `Stand-in step: ${r.text}`, cites: cite(r) })),
    decisions: [
      ...rows.slice(0, 2).map((r) => ({ decision: `Stand-in decision about: ${r.text}`, why: 'Written by the stand-in model.', cites: cite(r), uncertain: false })),
      { decision: 'An invented decision', why: 'Cites a message that does not exist, so it must be dropped.', cites: [{ session: rows[0] ? rows[0].session : 'x', turn: 9999 }] },
    ],
    dead_ends: [], left_out: [], pending: [{ text: 'Stand-in pending item.', cites: [] }],
    briefing: 'Stand-in briefing: continue where this unit stopped.',
  };
  const text = JSON.stringify(capsule);
  const result = { type: 'result', subtype: 'success', is_error: false, result: text, usage: { input_tokens: 4000, output_tokens: 600 }, total_cost_usd: 0.021 };
  await new Promise((r) => setTimeout(r, 900));
  if (process.argv.includes('stream-json')) {
    const half = Math.floor(text.length / 2);
    for (const piece of [text.slice(0, half), text.slice(half)]) console.log(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: piece } } }));
  }
  console.log(JSON.stringify(result));
  process.exit(0);
}
const ids = [...prompt.matchAll(/^SESSION (\S+) \|/gm)].map((m) => m[1]);
const has = (id) => ids.includes(id);
const titlesOnly = /Give each session a clear title/.test(prompt);
const answer = { titles: ids.map((id) => ({ session: id, title: `Named by the stand-in model: ${id}` })), groups: [], splits: [] };
if (!titlesOnly) {
  if (has('f3a3b3c3') && has('f4a4b4c4')) {
    answer.groups.push({ sessions: ['f3a3b3c3', 'f4a4b4c4'], title: 'Products pagination (stand-in)', confidence: 'high', reason: 'The tests follow the pagination work.', evidence: [{ session: 'f3a3b3c3', turn: 0 }, { session: 'f4a4b4c4', turn: 0 }] });
  }
  if (has('fa1a1a1a')) {
    answer.splits.push({ session: 'fa1a1a1a', reason: 'Two jobs in one session.', parts: [
      { start: 0, end: 7, title: 'Anchors (stand-in)', evidence: [{ session: 'fa1a1a1a', turn: 1 }] },
      { start: 8, end: 15, title: 'Release notes (stand-in)', evidence: [{ session: 'fa1a1a1a', turn: 8 }] },
    ] });
  }
}
const text = JSON.stringify(answer);
const usage = { input_tokens: 3000 + ids.length * 100, output_tokens: 300 + ids.length * 20 };
const result = { type: 'result', subtype: 'success', is_error: false, result: text, usage, total_cost_usd: 0.0123 };
const stream = process.argv.includes('stream-json');
await new Promise((r) => setTimeout(r, 700)); // long enough to see the progress panel
if (stream) {
  const half = Math.floor(text.length / 2);
  for (const piece of [text.slice(0, half), text.slice(half)]) console.log(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: piece } } }));
  console.log(JSON.stringify(result));
} else {
  console.log(JSON.stringify(result));
}
