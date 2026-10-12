# Retrospective

## What happened

- **Cycle 0, T1 in-place retry #1** (still cycle 0, not yet a new cycle): R1's first pass found the
  new backdrop-click test (`photo-upload.test.tsx`) intermittently flaky (~10% across 31 reruns) —
  a timing race in the test's own synchronous `expect(...).toBeNull()` check right after an `act()`
  block, not a source defect (TE1 independently confirmed the source wiring correct against all 5
  Requirements). T1 was reopened in place with a `MUST_FIX` appended to its own description
  (stabilize with the codebase's existing `waitFor(predicate, timeoutMs)` polling helper, per
  `bulk-identify-parts-ui.test.tsx`/`listings-page.test.tsx`), and T1/R1/TE1 reset to
  `not_started`, still inside cycle 0.

- **Cycle 0 → Cycle 1 transition**: R1's second pass (after the flakiness fix) verified the fix
  itself was correct and stable (44/44 clean reruns), but surfaced a second, independent gap:
  Requirement 3's "Close does not fire the close logic twice" guard had zero test coverage, because
  `PhotoUpload`'s `onClose={() => setLightboxIndex(null)}` is idempotent — a single call and a
  double call produce an identical DOM outcome, so no existing test (including the pre-existing
  Close-button test) could distinguish them. Because T1 had already consumed its one free in-place
  retry this cycle (for the flakiness fix), this second finding could not be folded into a third
  in-place attempt and instead opened Cycle 1. Cost of Cycle 1: two new tasks, T2 (builder,
  `expected_minutes` 10, `actual_tokens` 39,843) and its paired R2/TE2 reviews
  (`expected_minutes` 10 each, `actual_tokens` 51,094 and 38,576) — all three completed in a single
  4-minute window (22:26–22:48), i.e. the fix itself was trivial (a test-only addition, zero
  `photo-lightbox.tsx` change per T2's own description) but still required a full
  builder→reviewer→tester lap plus a fresh UAT pass (U0, `actual_tokens` 91,931) because UAT had
  not yet run against the feature.

- **T1's real cost dwarfed every other task in the table.** T1 itself (`expected_minutes` 30,
  `actual_tokens` 34,757) looks ordinary, but R1's review of that same T1 state (`expected_minutes`
  15, `actual_tokens` 202,340) ran roughly 13x its token estimate and was, by token count, the single
  most expensive task in the whole feature — larger than T1, TE1, T2, R2, and TE2 combined. This is
  the direct cost of R1 having to re-verify all 5 Requirements from scratch twice (once after the
  flakiness fix, landing the Requirement-3 gap) rather than the flakiness retry being scoped
  narrowly enough for R1 to re-check only the changed test.

- **No `model` escalation occurred.** Every build/review/test task ran at the plan's default model
  tier; the two retries were absorbed as scope/retry events, not capability failures — the issues
  found (a test timing race, then a coverage gap) were review-depth findings, not mistakes a bigger
  model would have prevented.

- **No `context_split` pattern.** Each task row maps to one bounded unit of work; T2's scope (one
  dedicated spy-based unit test) stayed a single row through build, review, and test.

- **Assumptions A1–A3 held without correction.** All three (literal backdrop interpretation scoping
  the three control buttons as an exception, no change to the shared `Dialog` primitives, combining
  the two new tests into one `it` block) were recorded in cycle 0 and never revisited or corrected
  by either cycle's review — the thing that needed a second pass was test *coverage*, not the
  plan's own assumptions about scope.

- Commit history adds no signal here: this feature's two source/test file changes are still
  uncommitted on `feat/lightbox-click-outside-close` (checked via `git log --oneline --all | grep
  lightbox`, which returns only the prior feature that introduced the lightbox component) — there
  is no fixup-commit trail to read a pattern from.

## Proposals

- **Have T1's own task description require a Requirement-3 double-fire test up front, not just the
  stopPropagation() code change.** The gap R1 found in cycle 1 — that `PhotoUpload`'s idempotent
  `onClose` makes a single vs. double call indistinguishable through any `PhotoUpload`-mounted test —
  was knowable from the Requirements alone (R3 explicitly says "does not fire the close logic
  twice") without touching the implementation first. Future plans for components with an idempotent
  callback prop should add a line to the builder task like: "if the callback bound to the
  no-double-fire guard is itself idempotent, write the regression test by mounting the component
  directly with a spy, not through its idempotent caller" — this would have produced T2's test as
  part of T1 and skipped Cycle 1 entirely (saving roughly the T2+R2+TE2+U0 token cost, ~221,000
  tokens, and the 4-minute build-review-test lap plus a second UAT pass).

- **Size `R1`-equivalent review tasks that re-verify all N requirements after an in-place retry at a
  slightly higher `expected_minutes`/token budget than a first-pass review**, since this plan's data
  point (15 expected minutes, 202,340 actual tokens — by far the feature's largest single cost) shows
  full-requirement re-verification after a retry costs materially more than a first pass over fresh
  code; the estimate didn't anticipate that a retry review re-walks every requirement, not just the
  one that changed.

---
This report cost approximately 8900 tokens (self-reported estimate) / not available (measured —
whoever dispatched this retrospective can report the measured figure from its own tracking).
Not counted in the feature's own total — this analysis happened after the feature was already done.
