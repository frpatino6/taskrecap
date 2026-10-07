// Token / dollar counter for every AI action. `session` = since the app started; `total` = persisted forever.
import fs from 'node:fs';
import path from 'node:path';

const zero = () => ({ calls: 0, input_tokens: 0, output_tokens: 0, usd: 0 });

function normalize(v) {
  const z = zero();
  if (!v || typeof v !== 'object') return z;
  for (const k of Object.keys(z)) z[k] = Number.isFinite(Number(v[k])) ? Number(v[k]) : 0;
  return z;
}

export const totalTokens = (u) => u.input_tokens + u.output_tokens;

export class UsageTracker {
  /** @param {string|null} file where the cumulative total is persisted (null = memory only) */
  constructor(file = null) {
    this.file = file;
    this.session = zero();
    this.total = zero();
    if (file) {
      try {
        this.total = normalize(JSON.parse(fs.readFileSync(file, 'utf8')).total);
      } catch {
        /* first run or unreadable file: start from zero */
      }
    }
  }

  /** Add the real usage of one `claude -p` call (meta = {cost_usd, input_tokens, output_tokens}). */
  record(meta) {
    const m = meta || {};
    for (const bucket of [this.session, this.total]) {
      bucket.calls += 1;
      bucket.input_tokens += m.input_tokens || 0;
      bucket.output_tokens += m.output_tokens || 0;
      bucket.usd += m.cost_usd || 0;
    }
    this.persist();
  }

  persist() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ total: this.total }, null, 1));
    } catch {
      /* the counter is informative: never fail an action because it cannot be saved */
    }
  }

  snapshot() {
    const view = (u) => ({ ...u, tokens: totalTokens(u), usd: Math.round(u.usd * 10000) / 10000 });
    return { session: view(this.session), total: view(this.total) };
  }
}

/** Sum the metas of several calls -> {calls, input_tokens, output_tokens, tokens, cost_usd}. */
export function sumMetas(metas) {
  const out = { calls: metas.length, input_tokens: 0, output_tokens: 0, cost_usd: 0 };
  for (const m of metas) {
    out.input_tokens += (m && m.input_tokens) || 0;
    out.output_tokens += (m && m.output_tokens) || 0;
    out.cost_usd += (m && m.cost_usd) || 0;
  }
  out.cost_usd = Math.round(out.cost_usd * 10000) / 10000;
  out.tokens = out.input_tokens + out.output_tokens;
  return out;
}
