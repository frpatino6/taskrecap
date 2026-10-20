# taskrecap E2E tests

Playwright Test, **one configuration on purpose**: Chromium, desktop 1280x800, English UI, light theme, UTC. No language, theme, mobile or multi-browser variants. Demo data only (`--demo`); no real session is ever read and no real model is ever called.

## Run

```bash
cd test/e2e
npm install                      # once; reuses the Chromium of tools/screenshots (same Playwright version)
npx playwright install chromium  # only if Chromium of that version is missing
npm test                         # everything
npm run test:smoke               # only @smoke
npm run test:headed              # watch it
npx playwright test specs/home   # one area (any folder under specs/)
npx playwright test specs/search --repeat-each=3   # hunt flakiness in one area
npm run report                   # open the HTML report (.output/report)
```

The root `npm test` runs only `test/*.test.js` (node:test unit tests); e2e specs are never picked up by it, and `test/e2e` is not published (`files` in the root package.json is a whitelist).

## Structure

```
fixtures/app.js        the `test` every spec imports (servers, options)
fixtures/presets.js    server variations: default, noClaude, fakeClaude, emptySessions (no --demo, empty projects dir), corruptedStore
pages/                 page objects: home, task, evidence.panel, organize.panel, timeline, components (menu, dialog, toast)
specs/<area>/         specs grouped by app area (see the inventory below)
.output/               results, traces, HTML report (git-ignored)
```

## Inventory by area

| Folder | What it covers | Server preset |
|---|---|---|
| `smoke/` | the app starts, home, a task, evidence | default |
| `home/` | cards, filters, unsorted group, free search on the home | default |
| `tasks/` | capsule content, outdated notice, unit kinds | default |
| `units/` | corrections: rename, merge, move, split, hide, undo | default (`freshPage`) |
| `organize-ai/` | proposals review (accept, accept all, reject, edit title, cut), running Organize with the stand-in claude, "Name with AI", no claude | default / `fakeClaude` / `noClaude` |
| `capsules/` | generate (estimate, confirm, progress, cancel, ready), key unit vs session unit, outdated + "Reuse that capsule", claude missing | `fakeClaude` / `noClaude` |
| `search/` | free search (key, title, capsule, messages, cap "+N more", no results), AI search flow | default / `fakeClaude` |
| `evidence/` | evidence panel: messages, markdown, file links, "Files Claude created", copy path, open folder, resume copy, close | default |
| `files/` | file to tasks lookup from the home and from a task | default |
| `timeline/` | lanes (newest first, 12 + more), filters, tooltips, marks, coverage ring, hidden and empty sessions | default |
| `states/` | empty sessions dir, corrupted stores, unknown task/route, API errors | `emptySessions` / `corruptedStore` / default |
| `api/` | HTTP contracts: `/api/search` shape, `/api/reveal` 400, foreign Origin 403, non-JSON 415 | default |

`test.fixme` marks scenarios that cannot be asserted reliably (with the reason in the test body): the "Indexing messages..." note (the demo index is ready in milliseconds).

## Debugging a failure

```bash
npx playwright test specs/search --trace on          # record a trace for every test of one area
npx playwright show-trace .output/results/<test-folder>/trace.zip
npx playwright test -g "should open the evidence" --headed --debug   # step through one test
```

Failures also leave a screenshot and, on retry (CI), a trace under `.output/results/`; `npm run report` opens them in the HTML report.

## Fixtures and isolation

- `server` (worker): a real `node bin/taskrecap.js --demo --no-open --port <free port>` with its own temporary `TASKRECAP_HOME`; killed on teardown. `baseURL` points at it, so `page.goto('/#/')` works.
- Playwright starts one worker per parallel lane, so each worker has its own server. Within a worker, tests of a file share that server.
- Tests that **change state** (rename, merge, hide, move, split, undo) must use `freshPage` (test-scoped: a brand new server and page). Read-only tests use `page`.
- `serverConfig` (worker option): `test.use({ serverConfig: presets.noClaude })` starts the server with other env/args (no `claude`, `claude` -> `tools/screenshots/fake-claude.mjs`). A preset may also set `demo: false` and a `prepare(root)` that seeds files in the temporary folder and returns extra CLI args (`emptySessions`, `corruptedStore`). `test.use({ serverConfig })` must be at the top level of a spec file (one preset per file). Add new variations in `fixtures/presets.js`.
- The home view is forced to `cards` (the timeline tests click `#view-timeline`).

## Conventions

- File name `area.feature.spec.js`, inside the area folder. Titles start with `should ...` and end with a tag: `@smoke` (the few that prove the app works; run on every change) or `@regression`.
- Selectors live in page objects, never in specs. Use roles/text first, then the app's stable ids and `data-*` attributes (`#q`, `.card[data-key]`, `#unit-menu`...). **No `data-testid` was needed so far**; add one in `web/` only where a selector would be fragile, and list it here: _none_.
- Assertions are web-first (`expect(locator)...`, `expect.poll`). No `waitForTimeout`.
- Tests are independent and order-agnostic; never rely on state left by another test.
- Expected values come from the demo data (`demo/`): if the demo changes, update the numbers here.

## Add a test

1. Pick (or create) the folder under `specs/` and a file `area.feature.spec.js`.
2. `import { test, expect } from '../../fixtures/app.js'` and the page objects you need.
3. Read-only: use `page`. Mutating: use `freshPage` and build the page object on it.
4. Missing locator? Add it to the page object, not the spec.

## CI snippet

```yaml
- uses: actions/setup-node@v4
  with: { node-version: 20 }
- run: npm ci || npm install
- run: cd test/e2e && npm install && npx playwright install --with-deps chromium && npm test
- uses: actions/upload-artifact@v4
  if: always()
  with: { name: e2e-report, path: test/e2e/.output/report }
```
