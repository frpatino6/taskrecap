// Layout of the home-page timeline (one lane per task, one dot per day with prompts). Pure functions: no I/O, no LLM.

export const DEFAULT_LIMIT = 12;
export const MAX_REPO_COLORS = 3; // the first three categorical slots are the ones validated for all-pairs use; later repos share one neutral colour
export const MIN_SPAN_DAYS = 14;
export const MARK_MIN = 8; // dot diameter in px for a day with one prompt
export const MARK_MAX = 16;
const DAY_MS = 86400000;
const MAX_TICKS = 8;
const TICK_STEPS = [1, 2, 7, 14, 30, 60, 90, 180, 365];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar day: it must also format back to itself, because Date.parse rolls '2026-02-30' over to March 2. */
export const isDay = (v) => {
  if (typeof v !== 'string' || !DAY_RE.test(v)) return false;
  const ms = Date.parse(`${v}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === v;
};
/** 'YYYY-MM-DD' -> whole days since 1970-01-01 (UTC arithmetic, so daylight saving time never shifts it). */
export const dayNumber = (day) => Math.round(Date.parse(`${day}T00:00:00Z`) / DAY_MS);
export const dayFromNumber = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);

/** Colour slot of each repo: its place in the alphabetical list of ALL repos, so a filter never repaints the survivors. -1 = neutral "other". */
export function repoSlots(repos) {
  const names = [...new Set(repos)].sort();
  return new Map(names.map((name, i) => [name, i < MAX_REPO_COLORS ? i : -1]));
}

/** Position, in percent of the chart width, of the middle of `day` inside [from, to]. */
export function xPercent(day, from, to) {
  const days = dayNumber(to) - dayNumber(from) + 1;
  return Math.round(((dayNumber(day) - dayNumber(from) + 0.5) / days) * 10000) / 100;
}

/** Axis ticks: the smallest "nice" step that gives at most MAX_TICKS of them. */
export function pickTicks(from, to) {
  const start = dayNumber(from);
  const days = dayNumber(to) - start + 1;
  const step = TICK_STEPS.find((s) => Math.ceil(days / s) <= MAX_TICKS) || TICK_STEPS[TICK_STEPS.length - 1];
  const ticks = [];
  for (let d = 0; d < days; d += step) {
    const day = dayFromNumber(start + d);
    ticks.push({ day, x: xPercent(day, from, to) });
  }
  return ticks;
}

/** Dot diameter (px): grows with the square root of the day's prompts, so area follows the count; 1 prompt is always MARK_MIN. */
export function markSize(n, maxN) {
  if (!(maxN > 1) || n <= 1) return MARK_MIN;
  return Math.round(MARK_MIN + (MARK_MAX - MARK_MIN) * Math.sqrt((n - 1) / (maxN - 1)));
}

/** Repo with the most prompts in a list of activity cells ('' when empty); ties go to the first alphabetically. */
export function primaryRepo(cells) {
  const totals = new Map();
  for (const c of cells) totals.set(c.project, (totals.get(c.project) || 0) + c.n);
  let best = '';
  for (const [name, n] of [...totals].sort((a, b) => (a[0] < b[0] ? -1 : 1))) if (!best || n > totals.get(best)) best = name;
  return best;
}

const parseLimit = (v) => (v === 'all' ? Infinity : Number.isInteger(v) && v > 0 ? v : DEFAULT_LIMIT);

/**
 * tasks: [{key, kind, activity: [{day, n, project}], has_capsule, generatable, ...}] in display order (newest first).
 * opts: {repo, from, to, limit (number | 'all'), keys: [..] (exactly these tasks, e.g. search hits), capsule: 'none' | 'ready'}
 */
export function buildTimeline(allTasks, opts = {}) {
  // sessions with no real content are folded away on the page: they never get a lane (their count is reported separately)
  const tasks = allTasks.filter((t) => !t.noise);
  const empty = allTasks.length - tasks.length;
  const slots = repoSlots(tasks.flatMap((t) => (t.activity || []).map((c) => c.project)));
  const generatable = tasks.filter((t) => t.generatable);
  const coverage = { ready: generatable.filter((t) => t.has_capsule).length, total: generatable.length, outdated: generatable.filter((t) => t.has_capsule && t.outdated).length };
  let from = isDay(opts.from) ? opts.from : null;
  let to = isDay(opts.to) ? opts.to : null;
  if (from && to && from > to) [from, to] = [to, from]; // a reversed range means the same days: never an empty chart for it
  const wanted = Array.isArray(opts.keys) ? new Set(opts.keys) : null;

  const matching = [];
  let undated = 0;
  for (const t of tasks) {
    if (wanted && !wanted.has(t.key)) continue;
    if (opts.capsule === 'none' && !(t.generatable && !t.has_capsule)) continue;
    if (opts.capsule === 'ready' && !t.has_capsule) continue;
    if (!(t.activity || []).length) { undated += 1; continue; }
    const cells = t.activity.filter((c) => (!opts.repo || c.project === opts.repo) && (!from || c.day >= from) && (!to || c.day <= to));
    if (cells.length) matching.push({ task: t, cells });
  }

  const shown = wanted ? matching : matching.slice(0, parseLimit(opts.limit));
  const days = shown.flatMap((m) => m.cells.map((c) => c.day)).sort();
  let rangeFrom = from || days[0] || to || new Date().toISOString().slice(0, 10);
  let rangeTo = to || days[days.length - 1] || rangeFrom;
  if (rangeTo < rangeFrom) rangeTo = rangeFrom;
  const short = MIN_SPAN_DAYS - (dayNumber(rangeTo) - dayNumber(rangeFrom) + 1);
  if (short > 0) rangeTo = dayFromNumber(dayNumber(rangeTo) + short);
  const maxN = Math.max(1, ...shown.flatMap((m) => m.cells.map((c) => c.n)));

  const lanes = shown.map(({ task, cells }) => {
    const marks = cells.map((c) => ({
      day: c.day, x: xPercent(c.day, rangeFrom, rangeTo), n: c.n, project: c.project,
      slot: slots.has(c.project) ? slots.get(c.project) : -1, size: markSize(c.n, maxN),
    }));
    const project = primaryRepo(cells);
    return {
      key: task.key, kind: task.kind || 'key', label: task.label || null, unsorted: !!task.unsorted,
      related: (task.related || []).map((r) => ({ key: r.key, label: r.label })),
      project, slot: slots.has(project) ? slots.get(project) : -1,
      projects: [...new Set(cells.map((c) => c.project))].sort(),
      has_capsule: !!task.has_capsule, outdated: !!(task.has_capsule && task.outdated), new_messages: task.has_capsule ? task.new_messages || 0 : 0,
      generatable: task.generatable !== false,
      prompts: cells.reduce((a, c) => a + c.n, 0), active_days: new Set(cells.map((c) => c.day)).size,
      first: cells[0].day, last: cells[cells.length - 1].day,
      line: { x1: marks[0].x, x2: marks[marks.length - 1].x }, marks,
    };
  });

  const present = [...new Set(lanes.flatMap((l) => l.marks.map((m) => m.project)))].sort();
  return {
    range: { from: rangeFrom, to: rangeTo, days: dayNumber(rangeTo) - dayNumber(rangeFrom) + 1 },
    ticks: pickTicks(rangeFrom, rangeTo),
    repos: present.map((name) => ({ name, slot: slots.has(name) ? slots.get(name) : -1 })),
    all_repos: [...slots.keys()],
    lanes, total: matching.length, shown: lanes.length, hidden: matching.length - lanes.length, undated, coverage,
    // what is counted: every unit that has activity and real content (task keys, branches, single sessions, groups of the user's);
    // sessions without content are not tasks: their number is `empty_total` (the page folds them into one group).
    // The coverage ring is narrower on purpose: it counts only the units that CAN have a capsule (`coverage`).
    task_total: matching.length,
    task_shown: lanes.length,
    empty_total: empty,
    applied: { from, to },
  };
}
