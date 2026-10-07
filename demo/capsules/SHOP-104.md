# Work capsule · SHOP-104

> Generated automatically from: `a7b8c9d0` (turns 0-2), `f6a7b8c9` (turns 0-4). Citations `session:turn` point to the evidence.

## Objective
Stop customers from being charged twice when they double-click 'Pay now' (SHOP-104), using an idempotency key that the orders service honours, without touching the payment provider code.

## Timeline
| Date | Repo | Result | Evidence |
|---|---|---|---|
| 09-16 | acme-shop | Reproduced the double charge: two clicks within 300 ms send two POST /api/orders requests and both are accepted. | `f6a7b8c9:0` |
| 09-16 | acme-shop | Disabled the Pay button while the request is in flight. | `f6a7b8c9:1` |
| 09-16 | acme-shop | Judged that not enough (slow network, page reload) and added an Idempotency-Key header, one per checkout attempt; the orders service returns the first result for a repeated key. Provider code untouched. | `f6a7b8c9:2` |
| 09-16 | acme-shop | Kept the key in sessionStorage so a reload reuses it; it is cleared only after a confirmed order. | `f6a7b8c9:3` |
| 09-16 | acme-shop | Checkout tests: 31 of 31 pass, including 4 new duplicate-submit cases. | `f6a7b8c9:4` |
| 09-17 | acme-shop | QA double-clicked 20 times on staging and got a single order. Added a 'we are confirming your order' message for timeouts; the retry reuses the same key. | `a7b8c9d0:0` |
| 09-17 | acme-shop | Committed and pushed the idempotency-key fix. | `a7b8c9d0:2` |

## Decisions and why
- **Send an Idempotency-Key header, generated once per checkout attempt, and let the orders service return the first result for a repeated key.** — Disabling the button alone does not stop duplicates on a slow network or after a page reload. `f6a7b8c9:1` `f6a7b8c9:2`
- **Leave the payment provider code untouched.** — The user said it belongs to another team. `f6a7b8c9:2`
- **Keep the key in sessionStorage.** — A page reload reuses the same key instead of creating a second order. `f6a7b8c9:3`
- **On a timeout, show 'We are confirming your order, do not pay again' and retry with the same key.** — Keeps the customer from paying again while the first request is still slow. `a7b8c9d0:0`
- **No automatic retries with backoff in this branch.** — The user considered it a bigger change and wants it later. `a7b8c9d0:1`

## Files touched
**Final**
- `acme-shop/services/orders/create.js` (1x)
- `acme-shop/src/checkout/CheckoutError.js` (1x)
- `acme-shop/src/checkout/PayButton.js` (1x)
- `acme-shop/src/checkout/idempotency.js` (3x)
- `acme-shop/src/checkout/submit.test.js` (1x)

## Commits
- `5d2f7a1` `fix/SHOP-104-double-submit` · SHOP-104: idempotency key prevents duplicate orders · _pushed_ · main

## Dead ends
- Disabling the Pay button after the first click was tried first and judged not enough on its own (slow network, page reload). `f6a7b8c9:1` `f6a7b8c9:2`

## Left out
- Automatic retries with backoff were deliberately left for a later change. `a7b8c9d0:1`

## Pending
- Plan the automatic retry with backoff as a follow-up change.

## Briefing to resume
> Task SHOP-104 in acme-shop (branch fix/SHOP-104-double-submit, pushed): customers could be charged twice by double-clicking 'Pay now'. The fix sends an Idempotency-Key header, generated once per checkout attempt and kept in sessionStorage so a reload reuses it; the orders service (services/orders/create.js) returns the first result for a repeated key. The Pay button is also disabled while the request is in flight, but that alone was not enough. On a timeout the customer sees 'We are confirming your order, do not pay again' and the retry reuses the same key. Rule from the user: do not touch the payment provider code (another team owns it). QA double-clicked 20 times on staging and got one order; 31 of 31 checkout tests pass. Open item: automatic retries with backoff were left for a follow-up.
