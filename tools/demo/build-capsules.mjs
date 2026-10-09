// Maintainer tooling (not published to npm): writes the FICTIONAL sample capsules in demo/capsules/.
// The capsule text below is hand-written. Everything else (files, commits, sources, citations check, markdown) comes
// from the real pipeline (generate() in src/capsule.js) run against the fictional demo sessions with a scripted
// "model", so the sample capsules always match what the app itself would produce. No LLM is called, no tokens are spent.
//   node tools/demo/build-capsules.mjs [unit key ...]     (no key: all of them; with keys: only those, the other files stay as they are)
// Two of the samples are for units WITHOUT a task key: one session, and a group of two sessions that the sample corrections
// (demo/capsules/.index/overrides.json, written by this script) merge into "Search for the docs site".
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO_DIR } from '../../src/app.js';
import { generate } from '../../src/capsule.js';
import { DEFAULT_KEY_REGEX } from '../../src/config.js';
import { CapsuleStore, SessionIndex, planTask, unitMeta } from '../../src/tasks.js';
import { Overrides } from '../../src/units.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'demo', 'capsules');
const c = (session, ...turns) => turns.map((turn) => ({ session, turn }));

// the sample corrections: two key-less docs sessions merged by the user into one group (fixed ids, so the sample never changes by itself)
const DEMO_GROUP = 'user:3f2b6c1e-8d4a-4b7e-9a51-0c6d2e7f1a90';
const OVERRIDES = {
  version: 1,
  ops: [{
    id: '0b6e1c52-7a3d-4c1f-9e08-5d2a7b9c4e11', batch: '9c1d4e7a-2b5f-4a38-8d60-1e3f5a7b9c20', ts: '2026-10-02T09:00:00.000Z',
    type: 'merge', unit: DEMO_GROUP, members: ['session:c8d8e8f8', 'session:c9d9e9f9'], label: 'Search for the docs site',
  }],
};

// Which turns of each session belong to each task (what the LLM vote would answer for a mixed session).
const RANGES = {
  'SHOP-103': { b2c3d4e5: [[6, 9]] },
  'SHOP-104': { f6a7b8c9: [[0, 4]], a7b8c9d0: [[0, 2]] },
  'SHOP-105': { b8c9d0e1: [[0, 4]] },
};

const CAPSULES = {
  'SHOP-103': {
    objective: 'Find out why the checkout test suite is flaky on CI (SHOP-103) and make it stable by isolating the fake timer per test.',
    timeline: [
      { date: '09-10', repo: 'acme-shop', result: 'Investigated the flaky checkout suite on CI: tests fail when two of them share one mocked clock (tests/checkout/setup.js).', cites: c('b2c3d4e5', 6) },
      { date: '09-10', repo: 'acme-shop', result: 'Concluded the shared fake timer was the cause, not the checkout code; each test now creates its own timer and restores it in afterEach.', cites: c('b2c3d4e5', 7) },
      { date: '09-10', repo: 'acme-shop', result: 'Ran the suite 20 times in a row: 20 of 20 green.', cites: c('b2c3d4e5', 8) },
      { date: '09-10', repo: 'acme-shop', result: "Moved the change to its own branch fix/SHOP-103-flaky-checkout-tests so it stays out of the dark mode work.", cites: c('b2c3d4e5', 9) },
    ],
    decisions: [
      { decision: 'Isolate the fake timer per test (create it in each test, restore it in afterEach).', why: 'The flakiness came from two tests sharing one mocked clock, not from the checkout code.', cites: c('b2c3d4e5', 6, 7), uncertain: false },
      { decision: 'Prove the fix by running the suite 20 times.', why: 'One green run does not show that a flaky test is fixed; the user asked for 20 runs.', cites: c('b2c3d4e5', 8), uncertain: false },
      { decision: 'Commit on its own branch (fix/SHOP-103-flaky-checkout-tests), not on the dark mode branch.', why: 'The user wanted SHOP-103 kept separate from the SHOP-102 work.', cites: c('b2c3d4e5', 9), uncertain: false },
    ],
    dead_ends: [],
    left_out: [{ text: 'The 20 green runs were local; no CI run of the fix is recorded in the session.', cites: c('b2c3d4e5', 8) }],
    pending: [{ text: 'Confirm on CI that the suite stays green after merging; no CI run is recorded.', cites: [] }],
    briefing: "Task SHOP-103 in acme-shop: the checkout test suite was flaky on CI because two tests shared one mocked clock (tests/checkout/setup.js). Each test now creates its own fake timer and restores it in afterEach (checkout.test.js, setup.js and cart/total.test.js were touched). The suite ran 20 of 20 green locally. The commit is on its own branch, fix/SHOP-103-flaky-checkout-tests, as the user asked. Open item: confirm the fix on CI.",
  },
  'SHOP-104': {
    objective: "Stop customers from being charged twice when they double-click 'Pay now' (SHOP-104), using an idempotency key that the orders service honours, without touching the payment provider code.",
    timeline: [
      { date: '09-16', repo: 'acme-shop', result: 'Reproduced the double charge: two clicks within 300 ms send two POST /api/orders requests and both are accepted.', cites: c('f6a7b8c9', 0) },
      { date: '09-16', repo: 'acme-shop', result: 'Disabled the Pay button while the request is in flight.', cites: c('f6a7b8c9', 1) },
      { date: '09-16', repo: 'acme-shop', result: 'Judged that not enough (slow network, page reload) and added an Idempotency-Key header, one per checkout attempt; the orders service returns the first result for a repeated key. Provider code untouched.', cites: c('f6a7b8c9', 2) },
      { date: '09-16', repo: 'acme-shop', result: 'Kept the key in sessionStorage so a reload reuses it; it is cleared only after a confirmed order.', cites: c('f6a7b8c9', 3) },
      { date: '09-16', repo: 'acme-shop', result: 'Checkout tests: 31 of 31 pass, including 4 new duplicate-submit cases.', cites: c('f6a7b8c9', 4) },
      { date: '09-17', repo: 'acme-shop', result: "QA double-clicked 20 times on staging and got a single order. Added a 'we are confirming your order' message for timeouts; the retry reuses the same key.", cites: c('a7b8c9d0', 0) },
      { date: '09-17', repo: 'acme-shop', result: 'Committed and pushed the idempotency-key fix.', cites: c('a7b8c9d0', 2) },
    ],
    decisions: [
      { decision: 'Send an Idempotency-Key header, generated once per checkout attempt, and let the orders service return the first result for a repeated key.', why: 'Disabling the button alone does not stop duplicates on a slow network or after a page reload.', cites: c('f6a7b8c9', 1, 2), uncertain: false },
      { decision: 'Leave the payment provider code untouched.', why: 'The user said it belongs to another team.', cites: c('f6a7b8c9', 2), uncertain: false },
      { decision: 'Keep the key in sessionStorage.', why: 'A page reload reuses the same key instead of creating a second order.', cites: c('f6a7b8c9', 3), uncertain: false },
      { decision: "On a timeout, show 'We are confirming your order, do not pay again' and retry with the same key.", why: 'Keeps the customer from paying again while the first request is still slow.', cites: c('a7b8c9d0', 0), uncertain: false },
      { decision: 'No automatic retries with backoff in this branch.', why: 'The user considered it a bigger change and wants it later.', cites: c('a7b8c9d0', 1), uncertain: false },
    ],
    dead_ends: [{ text: 'Disabling the Pay button after the first click was tried first and judged not enough on its own (slow network, page reload).', cites: c('f6a7b8c9', 1, 2) }],
    left_out: [{ text: 'Automatic retries with backoff were deliberately left for a later change.', cites: c('a7b8c9d0', 1) }],
    pending: [{ text: 'Plan the automatic retry with backoff as a follow-up change.', cites: [] }],
    briefing: "Task SHOP-104 in acme-shop (branch fix/SHOP-104-double-submit, pushed): customers could be charged twice by double-clicking 'Pay now'. The fix sends an Idempotency-Key header, generated once per checkout attempt and kept in sessionStorage so a reload reuses it; the orders service (services/orders/create.js) returns the first result for a repeated key. The Pay button is also disabled while the request is in flight, but that alone was not enough. On a timeout the customer sees 'We are confirming your order, do not pay again' and the retry reuses the same key. Rule from the user: do not touch the payment provider code (another team owns it). QA double-clicked 20 times on staging and got one order; 31 of 31 checkout tests pass. Open item: automatic retries with backoff were left for a follow-up.",
  },
  'SHOP-105': {
    objective: 'Cut the product page LCP on mobile from 3.4 s (SHOP-105) by lazy-loading the gallery images and prioritising the hero image.',
    timeline: [
      { date: '09-18', repo: 'acme-shop', result: 'Measured LCP 3.4 s on mobile: the hero image weighs 1.8 MB and 11 gallery images below the fold load immediately.', cites: c('b8c9d0e1', 0) },
      { date: '09-18', repo: 'acme-shop', result: 'Lazy-loaded the gallery with the native loading attribute; an IntersectionObserver wrapper (+12 kB) was tried first.', cites: c('b8c9d0e1', 1) },
      { date: '09-18', repo: 'acme-shop', result: 'Dropped the wrapper (LazyImage.js reverted) and kept the hero eager with fetchpriority="high" and a preload link.', cites: c('b8c9d0e1', 2) },
      { date: '09-18', repo: 'acme-shop', result: 'Measured again: LCP 2.1 s (was 3.4 s).', cites: c('b8c9d0e1', 3) },
      { date: '09-18', repo: 'acme-shop', result: 'Committed locally and did not push, to check it on a real phone first.', cites: c('b8c9d0e1', 4) },
    ],
    decisions: [
      { decision: 'Use the native loading="lazy" attribute for the gallery images, with no new library.', why: 'The user asked for no new libraries; the observer wrapper added 12 kB and was dropped.', cites: c('b8c9d0e1', 1, 2), uncertain: false },
      { decision: 'Keep the hero image eager, with fetchpriority="high" and a preload link.', why: 'The hero is the main above-the-fold image, so delaying it would hurt LCP (reason inferred; the session does not state it).', cites: c('b8c9d0e1', 0, 2), uncertain: true },
      { decision: 'Commit locally and do not push yet.', why: 'The user wants to check the page on a real phone first.', cites: c('b8c9d0e1', 4), uncertain: false },
    ],
    dead_ends: [{ text: 'An IntersectionObserver-based LazyImage wrapper (+12 kB) was tried and reverted in favour of the native attribute.', cites: c('b8c9d0e1', 1, 2) }],
    left_out: [{ text: 'The branch is not pushed: it waits for a check on a real phone.', cites: c('b8c9d0e1', 4) }],
    pending: [{ text: 'Check the page on a real phone, then push the branch.', cites: c('b8c9d0e1', 4) }],
    briefing: "Task SHOP-105 in acme-shop (branch perf/SHOP-105-lazy-images, committed locally, NOT pushed): the product page had an LCP of 3.4 s on mobile because the hero image is 1.8 MB and 11 gallery images loaded eagerly. The gallery now uses the native loading=\"lazy\" attribute (an observer-based wrapper was tried and reverted: +12 kB, and the user wants no new libraries). The hero stays eager with fetchpriority=\"high\" and a preload link in public/product.html. Lighthouse now reports an LCP of 2.1 s. Open item: the user wants to check the page on a real phone before pushing.",
  },
  'feature/search-autocomplete': {
    objective: 'Add autocomplete to the acme-shop product search box, reusing the existing /api/suggest endpoint, with keyboard navigation and tests.',
    timeline: [
      { date: '09-14', repo: 'acme-shop', result: 'Started the autocomplete in SearchBox.js with a 200 ms debounce that queries /api/suggest.', cites: c('c3d4e5f6', 0) },
      { date: '09-14', repo: 'acme-shop', result: 'Reused the existing suggest endpoint (no new one) and added keyboard navigation (up/down/enter) for accessibility.', cites: c('c3d4e5f6', 1) },
      { date: '09-14', repo: 'acme-shop', result: 'Added 6 tests covering arrows, enter and escape (SearchBox.test.js).', cites: c('c3d4e5f6', 2) },
      { date: '09-14', repo: 'acme-shop', result: "Agreed to leave the 'recent searches' idea for later; nothing implemented.", cites: c('c3d4e5f6', 3) },
    ],
    decisions: [
      { decision: 'Reuse the existing /api/suggest endpoint instead of creating a new one.', why: 'The user explicitly asked not to create a new endpoint.', cites: c('c3d4e5f6', 1), uncertain: false },
      { decision: 'Debounce the input by 200 ms before querying suggestions.', why: 'Reason not stated in the session; most likely to avoid one request per keystroke.', cites: c('c3d4e5f6', 0), uncertain: true },
      { decision: 'Add keyboard navigation (up/down/enter) to the suggestions.', why: 'The assistant added it for accessibility.', cites: c('c3d4e5f6', 1), uncertain: false },
    ],
    dead_ends: [],
    left_out: [{ text: "The 'recent searches' idea was postponed; nothing was implemented.", cites: c('c3d4e5f6', 3) }],
    pending: [
      { text: "Decide when to build 'recent searches'.", cites: c('c3d4e5f6', 3) },
      { text: 'No commit is recorded for this branch yet.', cites: [] },
    ],
    briefing: "Task feature/search-autocomplete in acme-shop: autocomplete for the product search box (src/search/SearchBox.js) with a 200 ms debounce, reusing the existing /api/suggest endpoint as the user required (do not create a new endpoint). Keyboard navigation (up/down/enter) was added and covered by 6 tests in SearchBox.test.js. The 'recent searches' idea was postponed on purpose. No commit is recorded for this branch yet, so the work may still be uncommitted.",
  },
  'session:c7d7e7f7': {
    objective: 'Replace the three hand-written price formats of the shop with one helper built on Intl.NumberFormat that reads the currency from the store settings.',
    timeline: [
      { date: '09-28', repo: 'acme-shop', result: 'Found three places that format prices by hand: formatPrice in the cart, toMoney in the product list and a template string in the order email.', cites: c('c7d7e7f7', 0) },
      { date: '09-28', repo: 'acme-shop', result: 'Added one helper, formatMoney(cents, currency) in src/lib/money.js, built on Intl.NumberFormat, and replaced the three call sites.', cites: c('c7d7e7f7', 1) },
      { date: '09-28', repo: 'acme-shop', result: 'Checked that the mailer runs Node 18, which supports Intl.NumberFormat with currencies, so no polyfill is needed.', cites: c('c7d7e7f7', 2) },
      { date: '09-28', repo: 'acme-shop', result: 'Added tests for euros, dollars and yen (a currency with no decimals); all of them pass.', cites: c('c7d7e7f7', 3) },
      { date: '09-28', repo: 'acme-shop', result: 'Confirmed that totals stay integer cents in the orders service: only the display changes.', cites: c('c7d7e7f7', 4) },
      { date: '09-28', repo: 'acme-shop', result: 'Committed locally on main and did not push; the pull request is for the next day.', cites: c('c7d7e7f7', 5) },
    ],
    decisions: [
      { decision: 'Use one helper (formatMoney) built on Intl.NumberFormat instead of three hand-written formatters.', why: 'The three formats were inconsistent across the shop; the helper reads the currency from the store settings.', cites: c('c7d7e7f7', 0, 1), uncertain: false },
      { decision: 'Keep money as integer cents everywhere and format only for display.', why: 'The user did not want any rounding on the server.', cites: c('c7d7e7f7', 4), uncertain: false },
      { decision: 'No polyfill for Intl in the mailer.', why: 'The mailer runs Node 18, which already supports currency formatting.', cites: c('c7d7e7f7', 2), uncertain: false },
    ],
    dead_ends: [],
    left_out: [{ text: 'The pull request was not opened in the session: the commit is local and was not pushed.', cites: c('c7d7e7f7', 5) }],
    pending: [{ text: 'Open the pull request for the price formatter.', cites: [] }],
    briefing: 'Work on the price formats of acme-shop (no task key, branch main, committed locally, NOT pushed): three hand-written formatters (formatPrice in the cart, toMoney in the product list, a template string in the order email) were replaced by one formatMoney(cents, currency) helper in src/lib/money.js, built on Intl.NumberFormat with the currency taken from the store settings. Rule from the user: money stays as integer cents everywhere and only the display changes. The mailer runs Node 18, which supports this without a polyfill. Tests cover euros, dollars and yen. Open item: open the pull request.',
  },
  [DEMO_GROUP]: {
    objective: 'Add search to the docs site with a local index built when the docs are built (no external service) and a keyboard-friendly search box in the navbar.',
    timeline: [
      { date: '09-29', repo: 'acme-docs', result: 'Compared Algolia DocSearch with a local index: DocSearch needs an application, a local index works offline with no account.', cites: c('c8d8e8f8', 0) },
      { date: '09-29', repo: 'acme-docs', result: 'Chose the local index, built by scripts/build-search-index.js when the docs are built.', cites: c('c8d8e8f8', 1) },
      { date: '09-29', repo: 'acme-docs', result: 'Kept the index small: titles, headings and one paragraph per page (84 kB for 120 pages).', cites: c('c8d8e8f8', 2) },
      { date: '10-01', repo: 'acme-docs', result: 'Added the search box component to the navbar; it loads search-index.json the first time it gets focus.', cites: c('c9d9e9f9', 0) },
      { date: '10-01', repo: 'acme-docs', result: 'Results open with the keyboard and the matching words are highlighted.', cites: c('c9d9e9f9', 1) },
      { date: '10-01', repo: 'acme-docs', result: 'Added a test: a query for webhooks finds the three webhook pages.', cites: c('c9d9e9f9', 2) },
      { date: '10-01', repo: 'acme-docs', result: 'Committed locally on main without pushing, so the docs lead can review first.', cites: c('c9d9e9f9', 3) },
    ],
    decisions: [
      { decision: 'Use a local search index and no external service.', why: 'The user wanted no external service; a local index works offline and needs no account.', cites: c('c8d8e8f8', 0, 1), uncertain: false },
      { decision: 'Index only titles, headings and the first paragraph of each page.', why: 'Keeps search-index.json small: 84 kB for 120 pages.', cites: c('c8d8e8f8', 2), uncertain: false },
      { decision: 'Do not push the commit; the docs lead reviews first.', why: 'The user asked for a local commit only and wants the docs lead to review it.', cites: c('c9d9e9f9', 3), uncertain: false },
    ],
    dead_ends: [],
    left_out: [{ text: 'The branch is not pushed: the commit stays local until the docs lead has reviewed it.', cites: c('c9d9e9f9', 3) }],
    pending: [{ text: 'Push the commit after the review of the docs lead.', cites: [] }],
    briefing: 'Docs search of acme-docs (no task key, two sessions grouped by the user, branch main, committed locally, NOT pushed): search runs on a local index, search-index.json, written by scripts/build-search-index.js when the docs are built (titles, headings and the first paragraph of each page, 84 kB for 120 pages). The navbar search box (src/components/SearchBox.js) loads it on first focus, opens results with the keyboard and highlights the matching words. The user ruled out external services such as Algolia DocSearch. A test checks that a query for webhooks finds the three webhook pages. Open item: the docs lead reviews the commit before it is pushed.',
  },
};

const overridesFile = path.join(OUT, '.index', 'overrides.json');
fs.mkdirSync(path.dirname(overridesFile), { recursive: true });
fs.writeFileSync(overridesFile, JSON.stringify(OVERRIDES, null, 1));
const index = new SessionIndex(path.join(DEMO_DIR, 'sessions'), DEFAULT_KEY_REGEX, { overrides: new Overrides(overridesFile) });
const store = new CapsuleStore(OUT);
const META = { input_tokens: 0, output_tokens: 0, cost_usd: 0 };
const only = process.argv.slice(2);

for (const [key, capsule] of Object.entries(CAPSULES)) {
  if (only.length && !only.includes(key)) continue;
  const ask = async (prompt) => {
    if (prompt.includes('State which turn ranges')) {
      const sid = /\(([0-9a-f]{8}), \d+ turns\)/.exec(prompt)[1];
      const ranges = (RANGES[key] || {})[sid] || [];
      return [JSON.stringify({ ranges: ranges.map(([start, end]) => ({ start, end, reason: 'hand-written demo ranges' })) }), META];
    }
    return [JSON.stringify(capsule), META];
  };
  const unit = unitMeta(index, key);
  const result = await generate(key, planTask(index, key), ask, { votes: 3, unit });
  result.unit = unit;
  result.info.llm_calls = 0; // hand-written sample: nothing was spent
  result.info.cost_usd = 0;
  const saved = store.save(key, result);
  const n = (result.capsule.decisions || []).length;
  console.log(`${key}: ${result.sources.join(', ')} | files ${result.files.length} | commits ${result.commits.confirmed.length}+${result.commits.possible.length} | decisions kept ${n}/${capsule.decisions.length} | ${saved.generated_at}`);
}
