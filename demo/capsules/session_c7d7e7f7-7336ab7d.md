# Work capsule · Prices are shown in three different formats across the shop. Find where each…

> Generated automatically from: `c7d7e7f7` (turns 0-5). Citations `session:turn` point to the evidence.

## Objective
Replace the three hand-written price formats of the shop with one helper built on Intl.NumberFormat that reads the currency from the store settings.

## Timeline
| Date | Repo | Result | Evidence |
|---|---|---|---|
| 09-28 | acme-shop | Found three places that format prices by hand: formatPrice in the cart, toMoney in the product list and a template string in the order email. | `c7d7e7f7:0` |
| 09-28 | acme-shop | Added one helper, formatMoney(cents, currency) in src/lib/money.js, built on Intl.NumberFormat, and replaced the three call sites. | `c7d7e7f7:1` |
| 09-28 | acme-shop | Checked that the mailer runs Node 18, which supports Intl.NumberFormat with currencies, so no polyfill is needed. | `c7d7e7f7:2` |
| 09-28 | acme-shop | Added tests for euros, dollars and yen (a currency with no decimals); all of them pass. | `c7d7e7f7:3` |
| 09-28 | acme-shop | Confirmed that totals stay integer cents in the orders service: only the display changes. | `c7d7e7f7:4` |
| 09-28 | acme-shop | Committed locally on main and did not push; the pull request is for the next day. | `c7d7e7f7:5` |

## Decisions and why
- **Use one helper (formatMoney) built on Intl.NumberFormat instead of three hand-written formatters.** — The three formats were inconsistent across the shop; the helper reads the currency from the store settings. `c7d7e7f7:0` `c7d7e7f7:1`
- **Keep money as integer cents everywhere and format only for display.** — The user did not want any rounding on the server. `c7d7e7f7:4`
- **No polyfill for Intl in the mailer.** — The mailer runs Node 18, which already supports currency formatting. `c7d7e7f7:2`

## Files touched
**Final**
- `acme-shop/src/cart/CartRow.js` (1x)
- `acme-shop/src/lib/money.js` (1x)
- `acme-shop/src/lib/money.test.js` (1x)
- `acme-shop/src/products/ProductCard.js` (1x)

## Commits
_(none)_

## Dead ends
_(none)_

## Left out
- The pull request was not opened in the session: the commit is local and was not pushed. `c7d7e7f7:5`

## Pending
- Open the pull request for the price formatter.

## Briefing to resume
> Work on the price formats of acme-shop (no task key, branch main, committed locally, NOT pushed): three hand-written formatters (formatPrice in the cart, toMoney in the product list, a template string in the order email) were replaced by one formatMoney(cents, currency) helper in src/lib/money.js, built on Intl.NumberFormat with the currency taken from the store settings. Rule from the user: money stays as integer cents everywhere and only the display changes. The mailer runs Node 18, which supports this without a polyfill. Tests cover euros, dollars and yen. Open item: open the pull request.
