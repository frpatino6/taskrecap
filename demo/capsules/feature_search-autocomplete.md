# Work capsule · feature/search-autocomplete

> Generated automatically from: `c3d4e5f6` (turns 0-3). Citations `session:turn` point to the evidence.

## Objective
Add autocomplete to the acme-shop product search box, reusing the existing /api/suggest endpoint, with keyboard navigation and tests.

## Timeline
| Date | Repo | Result | Evidence |
|---|---|---|---|
| 09-14 | acme-shop | Started the autocomplete in SearchBox.js with a 200 ms debounce that queries /api/suggest. | `c3d4e5f6:0` |
| 09-14 | acme-shop | Reused the existing suggest endpoint (no new one) and added keyboard navigation (up/down/enter) for accessibility. | `c3d4e5f6:1` |
| 09-14 | acme-shop | Added 6 tests covering arrows, enter and escape (SearchBox.test.js). | `c3d4e5f6:2` |
| 09-14 | acme-shop | Agreed to leave the 'recent searches' idea for later; nothing implemented. | `c3d4e5f6:3` |

## Decisions and why
- **Reuse the existing /api/suggest endpoint instead of creating a new one.** — The user explicitly asked not to create a new endpoint. `c3d4e5f6:1`
- **Debounce the input by 200 ms before querying suggestions.** _(uncertain)_ — Reason not stated in the session; most likely to avoid one request per keystroke. `c3d4e5f6:0`
- **Add keyboard navigation (up/down/enter) to the suggestions.** — The assistant added it for accessibility. `c3d4e5f6:1`

## Files touched
**Final**
- `acme-shop/src/search/SearchBox.js` (2x)
- `acme-shop/src/search/SearchBox.test.js` (1x)
- `acme-shop/src/search/suggest.js` (1x)

## Commits
_(none carrying the task key)_

## Dead ends
_(none)_

## Left out
- The 'recent searches' idea was postponed; nothing was implemented. `c3d4e5f6:3`

## Pending
- Decide when to build 'recent searches'. `c3d4e5f6:3`
- No commit is recorded for this branch yet.

## Briefing to resume
> Task feature/search-autocomplete in acme-shop: autocomplete for the product search box (src/search/SearchBox.js) with a 200 ms debounce, reusing the existing /api/suggest endpoint as the user required (do not create a new endpoint). Keyboard navigation (up/down/enter) was added and covered by 6 tests in SearchBox.test.js. The 'recent searches' idea was postponed on purpose. No commit is recorded for this branch yet, so the work may still be uncommitted.
