# Core

Pure policy over contract values: Hacker News and changelog scoring, clustering, idempotency keys, delivery policy, and state helpers. It takes contract values and explicit scalar inputs.

| Import                                                       | Provides                                                                                                 |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `@ai-moves/core/scoring/hn`                                  | `scoreHn`, `computeHnHeat`, `heatLevel`, and `normalizeFeatures`: the Hacker News heat, level, and gates |
| `@ai-moves/core/scoring/changelog`                           | `scoreChangelog`: the changelog prior, the clamped sum of the points of its matched signals              |
| `@ai-moves/core/clustering`                                  | `clusterKey`: the cluster key derived from an item's kind, source, and normalized title                  |
| `@ai-moves/core/idempotency`                                 | `stableKey` and the item, revision, poll-schedule, analysis, alert, and delivery keys derived from it    |
| `@ai-moves/core/policy/delivery`                             | `decideAlert` (send or feed-only, with block reasons) and `decideDelivery` (send, expire, or suppress)   |
| `@ai-moves/core/state/item`, `@ai-moves/core/state/delivery` | Transition guards over the contract state diagrams                                                       |

## Hacker News scoring

Ingestion computes the features of each sample over the scoring window and scores them with `@ai-moves/core/scoring/hn`.

- Features per sample: `vp` and `vc` (points and comments per hour over the scoring window), `climb` (ranks gained over the window), `acc` (change in `vp` per elapsed hour since the earliest measured velocity in the scoring window), and total points. Each is normalized against fixed reference rates (`hn.reference`) and weighted into a heat score from 0 to 100 with levels H1, H2, and H3.
- Gates: **G1 burst** (young story with enough points and either one very hot sample or consecutive hot samples), **G2 discussion** (high normalized `vc` and enough comments), **G3 sustained** (six consecutive top-10 observations, at least 150 points, and age at most 24 hours). Any gate moves a newly qualified story directly to `triaged_pass` and queues Deep. The first two observations have zero acceleration.
- The scoring window is `hn.window_minutes` (30), with a floor of three observations or the burst sample count, whichever is larger. Sustained ranks have their own lookback.
