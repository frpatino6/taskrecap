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
npx playwright test specs/home   # one area
npm run report                   # open the HTML report (.output/report)
```

The root `npm test` runs only `test/*.test.js` (node:test unit tests); e2e specs are never picked up by it, and `test/e2e` is not published (`files` in the root package.json is a whitelist).

## Structure

```
fixtures/app.js        the `test` every spec imports (servers, options)
fixtures/presets.js    server variations: default, noClaude, fakeClaude
pages/                 page objects: home.page.js, task.page.js, evidence.panel.js, components.js (menu, dialog, toast)
specs/smoke|home|tasks|units/   specs grouped by app area
.output/               results, traces, HTML report (git-ignored)
```

## Fixtures and isolation

- `server` (worker): a real `node bin/taskrecap.js --demo --no-open --port <free port>` with its own temporary `TASKRECAP_HOME`; killed on teardown. `baseURL` points at it, so `page.goto('/#/')` works.
- Playwright starts one worker per parallel lane, so each worker has its own server. Within a worker, tests of a file share that server.
- Tests that **change state** (rename, merge, hide, move, split, undo) must use `freshPage` (test-scoped: a brand new server and page). Read-only tests use `page`.
- `serverConfig` (worker option): `test.use({ serverConfig: presets.noClaude })` starts the server with other env/args (no `claude`, `claude` -> `tools/screenshots/fake-claude.mjs`). Add new variations in `fixtures/presets.js`.
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
