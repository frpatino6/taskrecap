# Contributing

Thanks for helping! The project is small on purpose: Node.js standard library only (zero runtime dependencies), plain ES modules, no build step.

- **Run the tests:** `npm test` (the LLM is always mocked; tests never spend tokens).
- **Try it without your own sessions:** `npm run demo`.
- **Style:** match the surrounding code (plain functions, short doc comments, no new dependencies).
- **Every new function ships with a unit test** (`node:test`, files in `test/`).
- **Privacy:** never commit real sessions, capsules, usage files or screenshots of them. Demo data in `demo/` is fictional.
- **Normal vs AI:** anything that calls Claude must go through `App.ask` (so it is counted in the usage counter), must show an estimate first and must require an explicit confirmation. Free, local features must never call the LLM.
- **UI text** lives in `web/strings.en.json`. To translate, add `web/strings.<lang>.json` with the keys you change (missing keys fall back to English) and run with `--lang <lang>`.
- **The product name** is defined in `src/config.js` (and `package.json`), so renaming is a two-file change.

Ideas that would help most: more real-world testing of task detection, connectors (Jira / GitHub Issues / Linear) that add a title and status to a task, and support for other session formats.
