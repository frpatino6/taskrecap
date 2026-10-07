# Work capsule · SHOP-101

> Generated automatically from: `a1b2c3d4` (turns 0-6). Citations `session:turn` point to the evidence.

## Objective
Find and fix why the checkout total is sometimes one cent higher than the cart total (SHOP-101), by replacing float arithmetic with integer cents in the cart module, and later extending the fix to gift cards.

## Timeline
| Date | Repo | Result | Evidence |
|---|---|---|---|
| 09-07 | acme-shop | Diagnosed float summing (19.99*3 = 59.97000000000001) plus a second Math.round at checkout; added a reproducing test in total.test.js. | `a1b2c3d4:0` |
| 09-07 | acme-shop | First attempt rounded the badge in the UI (CartBadge.js); the user rejected it and it was reverted via git checkout. | `a1b2c3d4:1` `a1b2c3d4:2` |
| 09-07 | acme-shop | Converted cart prices to integer cents in price.js and total.js, updated tests; all 14 cart tests passed. | `a1b2c3d4:2` `a1b2c3d4:3` |
| 09-07 | acme-shop | Committed 3f9a2c1 'SHOP-101: use integer cents in cart totals' on fix/SHOP-101-checkout-rounding, not pushed, as requested. | `a1b2c3d4:4` |
| 09-08 | acme-shop | QA reported gift cards still showed a float total; giftcard.js moved to the same integer-cents helper and tests updated. | `a1b2c3d4:5` |
| 09-08 | acme-shop | Committed 7be4d90 'SHOP-101: gift cards use integer cents' and pushed fix/SHOP-101-checkout-rounding to origin, as the user asked. | `a1b2c3d4:6` |

## Decisions and why
- **Keep the fix inside src/cart and do not touch the payment provider code.** — The user said the payment provider code belongs to another team. `a1b2c3d4:1`
- **Use integer cents everywhere in the cart instead of rounding in the UI.** — The user said UI rounding only hides the problem; floats must never be used in the cart. `a1b2c3d4:2`
- **Run only the cart module tests.** — The user asked for cart module tests only. `a1b2c3d4:3`
- **First commit made without pushing.** — The user explicitly said not to push yet. `a1b2c3d4:4`
- **Gift cards reuse the same integer-cents helper rather than their own sum.** — Gift cards had their own float sum, which caused the QA-reported float total. `a1b2c3d4:5`
- **Commit and push the gift card change.** — The user explicitly asked to commit and push this time. `a1b2c3d4:6`

## Files touched
**Final**
- `acme-shop/src/cart/giftcard.js` (1x)
- `acme-shop/src/cart/price.js` (1x)
- `acme-shop/src/cart/total.js` (2x)
- `acme-shop/src/cart/total.test.js` (3x)

**Reverted or discarded** (attempt that did not stay)
- `acme-shop/src/ui/CartBadge.js` (1x)

## Commits
- `3f9a2c1` `fix/SHOP-101-checkout-rounding` · SHOP-101: use integer cents in cart totals · main
- `7be4d90` `fix/SHOP-101-checkout-rounding` · SHOP-101: gift cards use integer cents · _pushed_ · main

## Dead ends
- Rounding the displayed badge in the UI (src/ui/CartBadge.js) only masked the problem; it was rejected by the user and reverted with git checkout. `a1b2c3d4:1` `a1b2c3d4:2`

## Left out
- The 'sale' coupon path is still untested and was left out of this branch. `a1b2c3d4:6`
- Payment provider code was left untouched because it belongs to another team. `a1b2c3d4:1`

## Pending
- Add tests for the 'sale' coupon path, which is still untested.

## Briefing to resume
> Task SHOP-101 (repo acme-shop, branch fix/SHOP-101-checkout-rounding): the checkout total was sometimes one cent higher than the cart total because the cart summed prices as floats and checkout rounded again with Math.round. The fix converts cart prices to integer cents in src/cart/price.js and total.js, and gift cards (giftcard.js) now use the same helper; tests are in total.test.js (14 cart tests passed after the first fix). A UI-only rounding attempt in CartBadge.js was rejected and reverted. Two commits exist: 3f9a2c1 (cart totals, not pushed at the time) and 7be4d90 (gift cards), and the branch was pushed on 09-08 at the user's request. User rules: keep changes inside src/cart, do not touch the payment provider code (another team's), use integer cents and never floats in the cart, run only cart module tests, and commit or push only when asked. Remaining: the 'sale' coupon path is untested and was left out of the branch.
