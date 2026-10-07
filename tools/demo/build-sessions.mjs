// Maintainer tooling (not published to npm): writes the FICTIONAL sample sessions of the acme-api and acme-docs repos
// (plus one more acme-shop task) into demo/sessions/. They give the home timeline something realistic to draw: three
// repos, about four weeks, a task spread over several days and sessions, and a pair of tasks interleaved in one session.
// Everything here is invented; no LLM is called. Run: node tools/demo/build-sessions.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'demo', 'sessions');
const t = (day, hhmm) => `2026-${day}T${hhmm}:00.000Z`; // day is 'MM-DD'

/** A session: prompts are [timestamp, what the user said, what Claude answered, tools?] with tools [[name, input]]. */
const SESSIONS = [
  { dir: 'acme-api', id: 'e1a1b1c1-1201-4201-8201-000000001201', repo: 'acme-api', branch: 'feature/API-212-rate-limit', prompts: [
    [t('09-01', '14:02'), 'API-212: we need rate limiting on POST /api/orders, 60 requests per minute per API key. Where should it live?', 'A small middleware in front of the orders router is enough; counters can live in memory for now and move to Redis later.'],
    [t('09-01', '14:20'), 'Go with the in-memory sliding window and write the middleware.', 'Added rateLimit(limit, windowMs) with a per-key sliding window; it answers 429 with a Retry-After header.', [['Edit', { file_path: '/home/demo/acme-api/src/middleware/rateLimit.js', old_string: 'x', new_string: 'y' }]]],
    [t('09-01', '15:10'), 'Add tests for the window edge: the 61st request in the same minute must fail, the next minute must pass.', 'Added rateLimit.test.js covering the 60/61 boundary and the reset after the window.', [['Edit', { file_path: '/home/demo/acme-api/src/middleware/rateLimit.test.js', old_string: 'x', new_string: 'y' }], ['Bash', { command: 'npm test -- src/middleware' }]]],
    [t('09-01', '15:40'), 'Good. Keep the limit in config, not hard-coded.', 'Moved the limit to config.rateLimit.ordersPerMinute with a default of 60.', [['Edit', { file_path: '/home/demo/acme-api/src/config.js', old_string: 'x', new_string: 'y' }]]],
  ] },
  { dir: 'acme-api', id: 'e2a2b2c2-1202-4202-8202-000000001202', repo: 'acme-api', branch: 'feature/API-212-rate-limit', prompts: [
    [t('09-03', '16:01'), 'API-212 again: the mobile app shares one API key across devices, so 60 per minute is too tight for it. Options?', 'Either a higher limit for keys flagged as mobile, or a second bucket per device id; the second is fairer but needs a header from the app.'],
    [t('09-03', '16:25'), 'Do the higher limit for mobile keys, 240 per minute. No new header from the app.', 'Added an allowlist of mobile key prefixes with a 240 per minute limit.', [['Edit', { file_path: '/home/demo/acme-api/src/middleware/rateLimit.js', old_string: 'x', new_string: 'y' }]]],
    [t('09-03', '16:50'), 'Add a test for a mobile key at 200 requests in a minute.', 'Added the mobile-key test; the suite passes.', [['Edit', { file_path: '/home/demo/acme-api/src/middleware/rateLimit.test.js', old_string: 'x', new_string: 'y' }], ['Bash', { command: 'npm test -- src/middleware' }]]],
  ] },
  { dir: 'acme-api', id: 'e3a3b3c3-1203-4203-8203-000000001203', repo: 'acme-api', branch: 'feature/API-212-rate-limit', prompts: [
    [t('09-08', '13:05'), 'API-212: QA says the 429 body is plain text. Make it JSON like our other errors.', 'The 429 response now returns {"error":"rate_limited","retryAfter":N} with the same Retry-After header.', [['Edit', { file_path: '/home/demo/acme-api/src/middleware/rateLimit.js', old_string: 'x', new_string: 'y' }]]],
    [t('09-08', '13:30'), 'Update the tests for the JSON body.', 'Updated the three affected tests to assert the JSON body.', [['Edit', { file_path: '/home/demo/acme-api/src/middleware/rateLimit.test.js', old_string: 'x', new_string: 'y' }]]],
    [t('09-08', '13:55'), 'Run everything.', 'All 58 tests pass.', [['Bash', { command: 'npm test' }]]],
    [t('09-08', '14:10'), 'Commit it locally, but do not push, I want a teammate to review first.', 'Committed a91c3e7 on feature/API-212-rate-limit. Not pushed.', [['Bash', { command: "git commit -am 'API-212: rate limit POST /api/orders (60/min, 240/min for mobile keys)'" }]]],
    [t('09-08', '14:25'), 'Write the PR description for the reviewer.', 'Drafted a PR description: what the limit is, why mobile keys get 240, and how to change it in config.'],
  ] },
  { dir: 'acme-api', id: 'e4a4b4c4-1204-4204-8204-000000001204', repo: 'acme-api', branch: 'fix/API-214-empty-cart-500', prompts: [
    [t('09-22', '15:03'), 'API-214: GET /api/cart/total returns a 500 when the cart is empty. Find out why.', 'The total is computed with reduce() without an initial value, which throws on an empty array.', [['Bash', { command: 'npm test -- src/cart' }]]],
    [t('09-22', '15:20'), 'Fix it and add a regression test.', 'Added the initial value 0 and a test for the empty cart; it returns {"total":0}.', [['Edit', { file_path: '/home/demo/acme-api/src/cart/total.js', old_string: 'x', new_string: 'y' }], ['Edit', { file_path: '/home/demo/acme-api/src/cart/total.test.js', old_string: 'x', new_string: 'y' }]]],
    [t('09-22', '16:00'), 'Does the same bug exist in the discount code?', 'Yes: applyDiscount() also reduces without an initial value; fixed there too with a test.', [['Edit', { file_path: '/home/demo/acme-api/src/cart/discount.js', old_string: 'x', new_string: 'y' }]]],
    [t('09-23', '10:10'), 'API-214: one more thing, the response for an empty cart should say currency too.', 'Added "currency" to the empty-cart response using the store default.', [['Edit', { file_path: '/home/demo/acme-api/src/cart/total.js', old_string: 'x', new_string: 'y' }]]],
    [t('09-23', '10:40'), 'Run the suite and commit locally, no push.', 'All green. Committed c52d18b on fix/API-214-empty-cart-500. Not pushed.', [['Bash', { command: 'npm test' }], ['Bash', { command: "git commit -am 'API-214: empty cart total returns 0 instead of a 500'" }]]],
  ] },
  { dir: 'acme-api', id: 'e5a5b5c5-1205-4205-8205-000000001205', repo: 'acme-api', branch: 'fix/API-216-currency-header', prompts: [
    [t('09-24', '14:01'), 'API-216: prices come back without the Content-Currency header on some routes. List which ones.', 'Three routes skip the shared response helper: /api/cart/total, /api/quote and /api/refunds.'],
    [t('09-24', '14:25'), 'Route them through the helper so the header is always set.', 'Moved the three routes to respondWithCurrency(); header present on all of them.', [['Edit', { file_path: '/home/demo/acme-api/src/http/respond.js', old_string: 'x', new_string: 'y' }], ['Edit', { file_path: '/home/demo/acme-api/src/routes/quote.js', old_string: 'x', new_string: 'y' }]]],
    [t('09-24', '15:05'), 'While you are in cart/total: API-214 is merged but its empty-cart response still lacks the header, fold that in here.', 'Done: the empty-cart response from API-214 now goes through the same helper and carries the header.', [['Edit', { file_path: '/home/demo/acme-api/src/cart/total.js', old_string: 'x', new_string: 'y' }]]],
    [t('09-24', '15:40'), 'API-216: add a test that fails if any route forgets the header.', 'Added a contract test that walks the route table and asserts Content-Currency on every price response.', [['Edit', { file_path: '/home/demo/acme-api/src/routes/contract.test.js', old_string: 'x', new_string: 'y' }]]],
    [t('09-24', '16:10'), 'Link API-214 in the PR so the reviewer sees both changes belong together.', 'Added a "Related: API-214" line to the PR description draft.'],
  ] },
  { dir: 'acme-docs', id: 'e6a6b6c6-1206-4206-8206-000000001206', repo: 'acme-docs', branch: 'docs/DOCS-31-webhooks', prompts: [
    [t('09-11', '17:02'), 'DOCS-31: we need a page that documents the checkout webhooks. Start with the list of events.', 'Listed the four events: order.created, order.paid, order.failed and order.refunded, each with its payload.', [['Edit', { file_path: '/home/demo/acme-docs/docs/webhooks/events.md', old_string: 'x', new_string: 'y' }]]],
    [t('09-11', '17:30'), 'Add one example payload per event.', 'Added JSON examples for each event, copied from the staging environment with the ids anonymised.', [['Edit', { file_path: '/home/demo/acme-docs/docs/webhooks/events.md', old_string: 'x', new_string: 'y' }]]],
    [t('09-11', '18:00'), 'How do customers verify the signature?', 'HMAC-SHA256 over the raw body with the shared secret, sent in the X-Signature header.'],
  ] },
  { dir: 'acme-docs', id: 'e7a7b7c7-1207-4207-8207-000000001207', repo: 'acme-docs', branch: 'docs/DOCS-31-webhooks', prompts: [
    [t('09-14', '17:05'), 'DOCS-31: write the signature verification section with a Node example.', 'Added a section with a verifySignature() example using crypto.timingSafeEqual.', [['Edit', { file_path: '/home/demo/acme-docs/docs/webhooks/security.md', old_string: 'x', new_string: 'y' }]]],
    [t('09-14', '17:40'), 'Add the retry policy: how often do we retry a failed delivery?', 'Documented 5 retries with exponential backoff over 24 hours, then the event is marked failed.', [['Edit', { file_path: '/home/demo/acme-docs/docs/webhooks/retries.md', old_string: 'x', new_string: 'y' }]]],
    [t('09-14', '18:10'), 'Link the three pages from the sidebar.', 'Added Events, Security and Retries under Webhooks in the sidebar.', [['Edit', { file_path: '/home/demo/acme-docs/sidebars.js', old_string: 'x', new_string: 'y' }]]],
    [t('09-14', '18:30'), 'Build the docs and check the links.', 'Build passes, no broken links.', [['Bash', { command: 'npm run build' }]]],
  ] },
  { dir: 'acme-docs', id: 'e8a8b8c8-1208-4208-8208-000000001208', repo: 'acme-docs', branch: 'docs/DOCS-31-webhooks', prompts: [
    [t('09-25', '16:02'), 'DOCS-31: engineering added an order.expired event. Document it.', 'Added order.expired with its payload and a note that it fires 30 minutes after an unpaid order is created.', [['Edit', { file_path: '/home/demo/acme-docs/docs/webhooks/events.md', old_string: 'x', new_string: 'y' }]]],
    [t('09-25', '16:25'), 'Commit locally and do not push, the docs lead will merge it.', 'Committed 7d02ae1 on docs/DOCS-31-webhooks. Not pushed.', [['Bash', { command: "git commit -am 'DOCS-31: document checkout webhooks'" }]]],
  ] },
  { dir: 'acme-docs', id: 'e9a9b9c9-1209-4209-8209-000000001209', repo: 'acme-docs', branch: 'docs/DOCS-33-readme-links', prompts: [
    [t('09-29', '15:03'), 'DOCS-33: the README has broken links after the folder rename. Find them.', 'Found 7 links that still point to docs/guides instead of docs/handbook.', [['Bash', { command: 'grep -rn "docs/guides" README.md docs' }]]],
    [t('09-29', '15:20'), 'Fix all of them.', 'Updated the 7 links to docs/handbook.', [['Edit', { file_path: '/home/demo/acme-docs/README.md', old_string: 'x', new_string: 'y' }]]],
    [t('09-29', '15:35'), 'Add a link checker to CI so this cannot happen again.', 'Added a link-check step to the docs workflow that fails on any broken relative link.', [['Edit', { file_path: '/home/demo/acme-docs/.github/workflows/docs.yml', old_string: 'x', new_string: 'y' }]]],
  ] },
  { dir: 'acme-shop', id: 'f1a1b1c1-1210-4210-8210-000000001210', repo: 'acme-shop', branch: 'feature/SHOP-107-gift-wrap', prompts: [
    [t('09-21', '14:03'), 'SHOP-107: customers want a gift wrap option at checkout for 3 dollars. Where does it go?', 'A checkbox in the shipping step; it adds a line item to the order with its own tax rule.'],
    [t('09-21', '14:30'), 'Build the checkbox and the line item.', 'Added GiftWrapOption and a gift_wrap line item priced at 300 cents.', [['Edit', { file_path: '/home/demo/acme-shop/src/checkout/GiftWrapOption.js', old_string: 'x', new_string: 'y' }], ['Edit', { file_path: '/home/demo/acme-shop/src/cart/total.js', old_string: 'x', new_string: 'y' }]]],
    [t('09-22', '14:08'), 'SHOP-107: the order email should mention the gift wrap.', 'Added a "Gift wrap" row to the order confirmation email template.', [['Edit', { file_path: '/home/demo/acme-shop/src/emails/orderConfirmation.js', old_string: 'x', new_string: 'y' }]]],
    [t('09-22', '14:35'), 'Add tests and run them.', 'Added tests for the line item and the email row; all pass.', [['Edit', { file_path: '/home/demo/acme-shop/src/cart/total.test.js', old_string: 'x', new_string: 'y' }], ['Bash', { command: 'npm test' }]]],
  ] },
];

function lines(session) {
  const out = [];
  const base = (ts) => ({ timestamp: ts, gitBranch: session.branch, cwd: `/home/demo/${session.repo}` });
  session.prompts.forEach(([ts, user, assistant, tools = []], i) => {
    out.push({ type: 'user', ...base(ts), message: { role: 'user', content: user } });
    const blocks = [{ type: 'text', text: assistant }];
    tools.forEach(([name, input], n) => blocks.push({ type: 'tool_use', id: `tu${i}${n}`, name, input }));
    out.push({ type: 'assistant', ...base(ts), message: { role: 'assistant', content: blocks } });
    if (tools.length) {
      out.push({ type: 'user', ...base(ts), message: { role: 'user', content: tools.map((_, n) => ({ type: 'tool_result', tool_use_id: `tu${i}${n}`, content: 'ok' })) } });
    }
  });
  return out;
}

for (const s of SESSIONS) {
  const dir = path.join(OUT, s.dir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${s.id}.jsonl`), lines(s).map((l) => JSON.stringify(l)).join('\n') + '\n');
}
console.log(`wrote ${SESSIONS.length} sessions under demo/sessions/`);
