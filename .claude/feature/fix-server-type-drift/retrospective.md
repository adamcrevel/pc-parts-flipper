# Retrospective

## What happened

- This was a clean, single-cycle run: the header records `Cycle: 0 / 3` and the Cycle Log contains
  only `### Cycle 0`. No task was ever reworked across a cycle boundary, no `must_fix` was raised by
  any reviewer/tester, and UAT (`U0`) passed on its first pass. The only "cycle"-shaped event is a
  plan *revision that happened before any build task ran* (Assumption A1): the user asked why
  `apps/server/src/db/types.ts` duplicated 8 of `packages/shared`'s row shapes at all, and whether
  it could be collapsed to one copy, rather than just accepting the original narrower plan ("re-sync
  the stale mirror, add a typecheck tripwire"). The PM investigated directly — read every one of the
  12 exported entity types' real `mapRow` functions against `packages/shared`'s shapes — and found 8
  were exact duplicates with nothing deliberately different, 1 (`ExpectedPart`) had one documented,
  safely-collapsible difference, and 4 genuinely had to stay local. That answer reshaped Requirements
  1–5 from "resync" to "delete the duplicate declaration and re-export from shared," which is why the
  final diff removed 15 names from `db/types.ts` rather than just correcting their fields in place.
  Because this happened pre-build (T1 never ran against the narrower version), it cost zero rework
  cycles — a case where the extra investigation depth before dispatching the builder paid for itself
  by changing the plan's shape instead of changing the diff after the fact.

- Every task's `actual_tokens` came in far above its `estimated_tokens`, while every task's real
  wall-clock duration came in at or under its `expected_minutes` — a consistent pattern, not one
  outlier:
  - T1 (builder): `expected_minutes` 60, ran ~8 min (16:24:02→16:31:58) — well under time — but
    `actual_tokens` is recorded as `null`. This is a measurement gap, not a cost data point: the
    builder's real token cost for the largest task in the plan (21 files touched) was never
    captured.
  - R1 (reviewer): estimated 48,000 tokens, actual 202,340 — 4.2x over.
  - TE1 (tester): estimated 10,300 tokens, actual 116,358 — 11.3x over, the worst ratio in the plan.
  - T2 (builder): estimated 5,600 tokens, actual 29,804 — 5.3x over.
  - R2 (reviewer): estimated 11,800 tokens, actual 39,464 — 3.3x over.
  - TE2 (tester): estimated 10,800 tokens, actual 29,103 — 2.7x over.
  - U0 (uat): estimated 26,000 tokens, actual 119,149 — 4.6x over.
  Every single task with a recorded `actual_tokens` overran its estimate by 2.7x–11.3x, while every
  task's real duration stayed within or close to its `expected_minutes`. Time budgeting was accurate;
  token budgeting was systematically low across every role (builder, reviewer, tester, uat) in this
  plan.

- Assumption A11 documents a real tooling defect, not an estimation error: `measure-child-cost.py
  child-cost --tag "<label>"` false-matched the *validator's own live session* for both R2 and TE2,
  because its tag search depends on a literal `AGENT_TAG: <tag>` line that the dispatch tool actually
  used in this run (`_task`) has no field to write into a child's prompt. The validator worked around
  it by reading each child's own transcript file directly and replicating the script's
  last-`totalTokens` logic by hand. This is the same root cause likely behind T1's missing
  `actual_tokens`: if no `AGENT_TAG` line was ever written for T1 either, and no one did the same
  manual transcript lookup for it, the number was simply never recorded rather than computed as 0.

- The plan's own Requirement 3 hardcoded a 14-file list of "every file that imports one of the 15
  collapsed names directly from `'../types.js'`," pre-qualified with a caveat that the list "could
  itself be stale by the time this task runs." That caveat earned its place twice in the same
  feature, in opposite directions: Assumption A4 found 2 of the 14 listed files (`ebayConnector.ts`,
  `registry.ts`) needed zero edits (false positives in the plan's own grep), and Assumption A5 found
  a 19th file, `jobs/identifyPartsWorkerPool.ts`, that the Requirement 3 list missed entirely (a
  false negative), caught only because the builder ran a broader grep for any `db/types.js` import
  depth rather than trusting the plan's literal list. Both were caught and fixed correctly inside T1,
  with no extra cycle — but the list itself did no useful work once a fresh grep was required anyway.

- The standing-check test suite showed the same resource-contention flakiness signature on different
  files on different runs within this single feature: the T1 validation pass saw
  `test/identifyPartsRoute.test.ts` time out; the T2 validation pass saw `test/photoServing.test.ts`
  and `test/gracefulShutdown.test.ts` time out instead (not the same file as before, and not
  `listingPhotos.test.ts`, the file named in the plan's own standing-check carve-out). All three were
  isolated and reran clean, correctly treated as non-regressions per the plan's documented
  carve-out — this cost no extra cycle, but it is now the fourth or fifth distinct file this flakiness
  pattern has hit "across every one of the last 5 features in this session" per the plan's own
  Standing Checks text.

## Proposals

- Fix or stop relying on `measure-child-cost.py`'s tag-based lookup under the `_task` dispatch tool:
  either have the dispatch tool write the literal `AGENT_TAG: <tag>` line the script searches for, or
  change the script to accept a direct transcript path (the validator's own A11 workaround) as a
  first-class argument instead of a fallback improvised mid-run. As written, it silently returns the
  wrong number (the parent's own session) rather than failing loudly, which is how T1's `actual_tokens`
  likely ended up `null` instead of measured.
- Recalibrate `estimated_tokens` upward for every role in this plan's shape (type-only refactor across
  ~15–20 files plus review/test/UAT passes that each re-run the full build+lint+suite): reviewer and
  tester estimates were off by 3–11x here, not just once but in every one of 5 recorded tasks, which
  points at a systematic sizing miscalibration for "re-run the build and suite as the pass/fail bar"
  tasks specifically, not a one-off estimation miss on a single task.
- Drop hardcoded file-enumeration lists from Requirements when the task already instructs a fresh grep
  before editing (Requirement 3 here): the list added no value once A4/A5 show a fresh grep was
  required anyway to catch both its stale entries and its omission, and a wrong-but-specific list
  invites exactly the kind of mismatch both assumptions had to resolve by hand.

---
This report cost approximately 8,500 tokens (self-reported estimate) /
not available (measured — the dispatching agent should report the figure measured from this run's
own tag) tokens. Not counted in the feature's own total — this analysis happened after the feature
was already done.
