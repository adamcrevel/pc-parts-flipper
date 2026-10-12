# Retrospective

## What happened

- **Cycle 0** (initial): built T1 (eBay connector fetch/format), T2 (scan-time capture), T3
  (backfill script) plus their R/TE pairs, then U0. UAT failed not on correctness but on scope:
  Requirement 4's "run once against the real production database" clause had no record of having
  happened — A3 recorded only future intent, and `feature-uat-tester`'s own scope forbids live-prod
  access, so it correctly flagged this as an unperformed must_fix rather than a code defect.
- **T2 required an in-place retry within Cycle 0.** R2's must_fix: the `scanSource photo download
  call budget` test's two scenarios both had `foundCount === newCount` (zero duplicates), so they
  couldn't distinguish "one detail call per new candidate" (Req 7, correct) from "one per search
  result" (the regression Req 7 forbids) — see A15. The retry added a duplicate+new mixed scenario
  (A17) and both R2/TE2 then passed. Cost: T2's row spans 03:24:25-04:24:00 (~59.5 min real) against
  a 40-minute `expected_minutes` (~49% over), and its `actual_tokens` cell is permanently blank
  because the retry's own dispatch was interrupted by an environment crash before reporting (T2's
  own "Retry note").
- **Cycle 1** (trigger: Req 4's production-run gap). Per A19, the orchestrator correctly judged this
  an operational action, not a code defect, and dispatched **no `feature-build-lead` task** — the
  only new task row was U1 (independent recheck), `expected_minutes: 10`, which ran in ~9 real
  minutes (on budget) but cost 60,182 `actual_tokens` against a 10,000-token estimate (6x over). The
  backfill itself (`npm run backfill-descriptions` against production, A20) was run directly by the
  orchestrator with no task row at all — its real-world cost shows up only as the ~24-minute gap
  between U0's completion (05:26) and U1's start (05:50).
- **Token estimation was systematically wrong for every reviewer/tester/uat task, while time
  estimates were roughly right.** Every one of R1, R2, R3, TE1, TE2, TE3, U0, U1 ran well past its
  own `estimated_tokens`: R1 21,800→202,340 (9.3x, the single largest miss in the feature), U1
  10,000→60,182 (6x), TE3 15,000→82,100 (5.5x), U0 22,500→119,313 (5.3x), TE2 12,500→64,634 (5.2x),
  R2 47,300→163,833 (3.5x), R3 14,900→50,184 (3.4x), TE1 52,900→116,358 (2.2x). By contrast,
  `expected_minutes` vs. real elapsed time was close or under for 8 of the 10 scheduled task rows —
  only T2 (above) overran on time.
- **`measure-child-cost.py`'s tag-based session search returned wrong `actual_tokens` twice in this
  one feature**, both documented rather than silently trusted: A16 (R2/TE2/R3/TE3's first pass, all
  four matched unrelated stale sessions from other features reusing the same generic tag text) and
  A17 (the R2/TE2 retry pass, both again matched an identical stale value, 148,958, for two
  different tags). Both times the orchestrator worked around it by reading the dispatching child's
  own transcript file directly.

## Proposals

- Schedule a known-up-front "run this once in production" deliverable (Req 4's backfill here) as
  its own owned, timed task in the Cycle 0 plan itself — not as an assumption of future intent (A3)
  with no slot or owner. Doing so would have let Cycle 0's own UAT pass, avoiding a dedicated second
  cycle whose only job was to execute and re-verify a step that was foreseeable on day one.
- When a call-budget/scaling test is specified (e.g. "bounded to new imports, not total results"),
  require at least one scenario mixing duplicates with new items in the task spec itself, not added
  reactively after a reviewer catches the gap — T2's own must_fix (A15) was exactly this: the
  original scenarios all had zero duplicates and so could not falsify a per-search-result regression.
- Raise the default `estimated_tokens` sizing for `reviewer`/`tester`/`uat` roles specifically — this
  feature's 8 such tasks ran 2.2x-9.3x over their own token estimate while their time estimates
  stayed accurate, indicating the token heuristic is calibrated for builder work and under-sizes
  verification work by roughly 3-5x as a rule.
- When a retry dispatch is interrupted before reporting (T2's case here), have the orchestrator
  immediately read the interrupted child's own transcript file for its last `totalTokens` (the same
  fallback A16/A17 already use for the tag-search tool's wrong answers) rather than leaving
  `actual_tokens` permanently blank — the cost was real and incurred, just unrecorded.
- Fix `measure-child-cost.py`'s lookup key: it returned a wrong, stale-session value on two separate
  passes in this one feature (A16, A17) because free-text tag grepping collides across unrelated
  sessions that happen to reuse generic tags like "review T2"/"test T2". Key the lookup on the
  dispatch's own unique transcript filename/session id instead, which is already the manual fallback
  being used to catch its errors.

---
This report cost approximately 6,500 tokens (self-reported estimate) / not available (measured —
the caller measures this from the tag it gave this dispatch) tokens. Not counted in the feature's
own total — this analysis happened after the feature was already done.
