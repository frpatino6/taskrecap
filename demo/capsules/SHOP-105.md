# Work capsule · SHOP-105

> Generated automatically from: `b8c9d0e1` (turns 0-4). Citations `session:turn` point to the evidence.

## Objective
Cut the product page LCP on mobile from 3.4 s (SHOP-105) by lazy-loading the gallery images and prioritising the hero image.

## Timeline
| Date | Repo | Result | Evidence |
|---|---|---|---|
| 09-18 | acme-shop | Measured LCP 3.4 s on mobile: the hero image weighs 1.8 MB and 11 gallery images below the fold load immediately. | `b8c9d0e1:0` |
| 09-18 | acme-shop | Lazy-loaded the gallery with the native loading attribute; an IntersectionObserver wrapper (+12 kB) was tried first. | `b8c9d0e1:1` |
| 09-18 | acme-shop | Dropped the wrapper (LazyImage.js reverted) and kept the hero eager with fetchpriority="high" and a preload link. | `b8c9d0e1:2` |
| 09-18 | acme-shop | Measured again: LCP 2.1 s (was 3.4 s). | `b8c9d0e1:3` |
| 09-18 | acme-shop | Committed locally and did not push, to check it on a real phone first. | `b8c9d0e1:4` |

## Decisions and why
- **Use the native loading="lazy" attribute for the gallery images, with no new library.** — The user asked for no new libraries; the observer wrapper added 12 kB and was dropped. `b8c9d0e1:1` `b8c9d0e1:2`
- **Keep the hero image eager, with fetchpriority="high" and a preload link.** _(uncertain)_ — The hero is the main above-the-fold image, so delaying it would hurt LCP (reason inferred; the session does not state it). `b8c9d0e1:0` `b8c9d0e1:2`
- **Commit locally and do not push yet.** — The user wants to check the page on a real phone first. `b8c9d0e1:4`

## Files touched
**Final**
- `acme-shop/public/product.html` (1x)
- `acme-shop/src/product/ProductGallery.js` (1x)
- `acme-shop/src/product/ProductHero.js` (1x)

**Reverted or discarded** (attempt that did not stay)
- `acme-shop/src/ui/LazyImage.js` (1x)

## Commits
- `2e8b6c4` `perf/SHOP-105-lazy-images` · SHOP-105: lazy-load gallery images, prioritise hero · main

## Dead ends
- An IntersectionObserver-based LazyImage wrapper (+12 kB) was tried and reverted in favour of the native attribute. `b8c9d0e1:1` `b8c9d0e1:2`

## Left out
- The branch is not pushed: it waits for a check on a real phone. `b8c9d0e1:4`

## Pending
- Check the page on a real phone, then push the branch. `b8c9d0e1:4`

## Briefing to resume
> Task SHOP-105 in acme-shop (branch perf/SHOP-105-lazy-images, committed locally, NOT pushed): the product page had an LCP of 3.4 s on mobile because the hero image is 1.8 MB and 11 gallery images loaded eagerly. The gallery now uses the native loading="lazy" attribute (an observer-based wrapper was tried and reverted: +12 kB, and the user wants no new libraries). The hero stays eager with fetchpriority="high" and a preload link in public/product.html. Lighthouse now reports an LCP of 2.1 s. Open item: the user wants to check the page on a real phone before pushing.
