# Work capsule · SHOP-102

> Generated automatically from: `b2c3d4e5` (turns 0-5). Citations `session:turn` point to the evidence.

## Objective
Build a dark theme for the acme-shop storefront (SHOP-102): extract hard-coded colors into CSS variables, add a theme toggle that follows prefers-color-scheme, fix buy-button contrast for WCAG AA in dark mode, and keep the toggle behind a darkMode feature flag.

## Timeline
| Date | Repo | Result | Evidence |
|---|---|---|---|
| 09-09 | acme-shop | Listed hard-coded colors in src/ui: 37 colors across 9 files, mostly in header.css and product-card.css. | `b2c3d4e5:0` |
| 09-09 | acme-shop | Created theme.css with --bg, --text, --accent variables and replaced literals in header.css and product-card.css, keeping light theme identical. | `b2c3d4e5:1` |
| 09-09 | acme-shop | Added ThemeToggle in header with prefers-color-scheme default; choice stored in localStorage. | `b2c3d4e5:2` |
| 09-09 | acme-shop | Changed dark accent to #7aa2ff (5.1:1 contrast on card background) to fix buy-button contrast for WCAG AA. | `b2c3d4e5:3` |
| 09-09 | acme-shop | Wrapped ThemeToggle in the darkMode feature flag, off by default (flags.js). | `b2c3d4e5:4` |
| 09-09 | acme-shop | Committed a41c8e2 on feature/SHOP-102-dark-mode: 'SHOP-102: dark theme behind darkMode flag'. | `b2c3d4e5:5` |

## Decisions and why
- **Move hard-coded colors into CSS variables in a new theme.css (--bg, --text, --accent).** — Prerequisite for a dark theme; user required the light theme remain pixel-identical. `b2c3d4e5:1`
- **Toggle follows prefers-color-scheme by default and stores the user's choice in localStorage.** — User asked for a toggle that follows system preference by default. `b2c3d4e5:2`
- **Use #7aa2ff as the dark accent color.** — Buy-button contrast was too low in dark mode; this gives 5.1:1 on the card background, passing WCAG AA. `b2c3d4e5:3`
- **Put ThemeToggle behind the darkMode feature flag, off by default.** — User did not want the toggle shipped yet. `b2c3d4e5:4`
- **Commit all work as a single commit a41c8e2 with message 'SHOP-102: dark theme behind darkMode flag'.** — User asked to commit the SHOP-102 work. `b2c3d4e5:5`

## Files touched
**Final**
- `acme-shop/src/flags.js` (1x)
- `acme-shop/src/ui/ThemeToggle.js` (2x)
- `acme-shop/src/ui/header.css` (2x)
- `acme-shop/src/ui/product-card.css` (1x)
- `acme-shop/src/ui/theme.css` (2x)

## Commits
- `a41c8e2` `feature/SHOP-102-dark-mode` · SHOP-102: dark theme behind darkMode flag · main

## Dead ends
_(none)_

## Left out
- The toggle is not shipped: it is gated behind the darkMode flag, off by default, at the user's request. The final decision on enabling the flag is not recorded in the evidence. `b2c3d4e5:4`

## Pending
- Decide when to enable the darkMode flag and ship the toggle; no decision is recorded.
- Evidence lists 37 hard-coded colors in 9 files but edits touch only header.css and product-card.css (plus theme.css); whether the remaining files were converted is not shown.

## Briefing to resume
> Task SHOP-102 in acme-shop (branch feature/SHOP-102-dark-mode, commit a41c8e2): implemented a dark theme. Hard-coded colors in src/ui were moved into CSS variables in src/ui/theme.css (--bg, --text, --accent) with the light theme kept pixel-identical; header.css and product-card.css were updated. A ThemeToggle (src/ui/ThemeToggle.js) in the header follows prefers-color-scheme by default and stores the choice in localStorage. The dark accent is #7aa2ff (5.1:1 contrast on the card background) to meet WCAG AA for the buy button. The toggle is wrapped in the darkMode flag (src/flags.js), off by default, because the user did not want it shipped yet. Open items: when to enable the flag, and whether the other files with hard-coded colors (37 colors in 9 files originally) were fully converted, since only a few files were edited. No explicit user rules beyond: keep light theme pixel-identical and keep the toggle behind the flag.
