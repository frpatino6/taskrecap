# Work capsule · SHOP-103

> Generated automatically from: `b2c3d4e5` (turns 6-9). Citations `session:turn` point to the evidence.

## Objective
Find out why the checkout test suite is flaky on CI (SHOP-103) and make it stable by isolating the fake timer per test.

## Timeline
| Date | Repo | Result | Evidence |
|---|---|---|---|
| 09-10 | acme-shop | Investigated the flaky checkout suite on CI: tests fail when two of them share one mocked clock (tests/checkout/setup.js). | `b2c3d4e5:6` |
| 09-10 | acme-shop | Concluded the shared fake timer was the cause, not the checkout code; each test now creates its own timer and restores it in afterEach. | `b2c3d4e5:7` |
| 09-10 | acme-shop | Ran the suite 20 times in a row: 20 of 20 green. | `b2c3d4e5:8` |
| 09-10 | acme-shop | Moved the change to its own branch fix/SHOP-103-flaky-checkout-tests so it stays out of the dark mode work. | `b2c3d4e5:9` |

## Decisions and why
- **Isolate the fake timer per test (create it in each test, restore it in afterEach).** — The flakiness came from two tests sharing one mocked clock, not from the checkout code. `b2c3d4e5:6` `b2c3d4e5:7`
- **Prove the fix by running the suite 20 times.** — One green run does not show that a flaky test is fixed; the user asked for 20 runs. `b2c3d4e5:8`
- **Commit on its own branch (fix/SHOP-103-flaky-checkout-tests), not on the dark mode branch.** — The user wanted SHOP-103 kept separate from the SHOP-102 work. `b2c3d4e5:9`

## Files touched
**Final**
- `acme-shop/src/cart/total.test.js` (1x)
- `acme-shop/tests/checkout/checkout.test.js` (1x)
- `acme-shop/tests/checkout/setup.js` (2x)

## Commits
- `c5d7f13` `fix/SHOP-103-flaky-checkout-tests` · SHOP-103: isolate fake timers per test · main

## Dead ends
_(none)_

## Left out
- The 20 green runs were local; no CI run of the fix is recorded in the session. `b2c3d4e5:8`

## Pending
- Confirm on CI that the suite stays green after merging; no CI run is recorded.

## Briefing to resume
> Task SHOP-103 in acme-shop: the checkout test suite was flaky on CI because two tests shared one mocked clock (tests/checkout/setup.js). Each test now creates its own fake timer and restores it in afterEach (checkout.test.js, setup.js and cart/total.test.js were touched). The suite ran 20 of 20 green locally. The commit is on its own branch, fix/SHOP-103-flaky-checkout-tests, as the user asked. Open item: confirm the fix on CI.
