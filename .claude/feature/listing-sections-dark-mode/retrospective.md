# Retrospective

## What happened
- This feature ran a single cycle (Cycle 0) with no new cycle opened — one in-place retry
  (MF-1) inside Cycle 0 handled the only defect found, and nothing else escalated the plan.
  That is a clean run by this project's own standard: one prototype, five builder tasks,
  five paired review/test tasks, one UAT pass, all complete.
- The one retry: T3's `expectedPartToRow` originally carved out an exception — leaving an
  AI-suggested Expected Part row expanded rather than collapsed by default — to satisfy 9
  existing `identify-parts.test.tsx` assertions (A7). R3's independent review (A10) caught
  this as a genuine Req 4 violation (Req 5's "starts expanded" text is scoped to the Add-Part
  button, not to AI-suggested rows) and proved the carve-out was unnecessary: reverting to
  unconditional `collapsed: true` and re-running `identify-parts.test.tsx` in isolation left
  all 15 assertions passing anyway, because that test file's own `descriptionValues()` helper
  already expands closed rows before reading values. MF-1 fixed this with one line
  (`listing-form-state.ts:60`) plus doc/test updates (A14) — cheap to fix, but it existed only
  because T3's own build pass trusted a shortcut instead of first checking whether the
  existing tests' helper already handled the collapsed case.
- A11 names a reviewer/tester file race: R3 ran its own break-run-restore experiment against
  `listing-form-state.ts` at the same time TE3 was mutation-testing that same file, each
  observing the other's transient edits as a flaky failure before both self-healed. No lasting
  damage, but it cost both agents time chasing a false signal. The harness's standing rule only
  names tester-tester races as needing serialization; reviewers also carry Edit/Write in
  practice and this pairing (reviewer + tester, same production file, same cycle) was not
  covered.
- A12: every dispatched child task's `actual_tokens` came back `null` — exact-tag lookup via
  `measure-child-cost.py child-cost --tag <id>` finds no transcript on this host, and the
  fallback (a guessed/looser tag) returned numbers that were both inconsistent across repeated
  calls and collapsed several unrelated task ids to the same value. This is the second
  feature in this codebase to hit exactly this (the plan cites `identify-parts-queue/plan.md`
  A19), so every `actual_tokens` cell in the task table above is `null` — not a one-off gap,
  a standing measurement blind spot on this host.
- A13/A15: the whole-suite standing gate hit the same real-server-spawn concurrency flake
  twice across two separate validate passes within this one cycle (`sales.test.ts` once,
  `purchases.test.ts` once) — different files losing the same resource race each time, both
  confirmed non-regressions by isolated re-run. This is also a repeat of a pattern already
  documented in `identify-parts-queue/plan.md` (A13/A18): vitest's own file-level parallelism
  across many real-server-spawning test files contends for the same resource under concurrent
  load, and each feature that validates on this host re-discovers and re-diagnoses it from
  scratch.
- No `context_split` and no reactive model escalation appear anywhere in the task table — every
  task finished within its original row, and no `model` column entry shows an upgrade mid-task.

## Proposals
- Add a standing instruction to `feature-build-lead` (or the builder role generally): before
  carving out an exception to satisfy an existing test, first check whether the existing test's
  own helper functions already accommodate the new behavior — T3's A7 exception was invented to
  avoid breaking `identify-parts.test.tsx`, but the breakage never actually existed once checked.
  This would have skipped MF-1 entirely.
- Extend the harness's reviewer/tester file-conflict rule beyond "testers never conflict" to
  cover "a reviewer running break-run-restore and a tester running mutation testing on the same
  file in the same cycle must not run concurrently" — A11's near-miss came from exactly this
  uncovered pairing, and the current rule's wording only protects against tester-tester overlap.
- File (or escalate) the `measure-child-cost.py --tag` null-lookup gap as a standing
  infrastructure ticket rather than re-documenting it per-feature: this is the second plan
  (`identify-parts-queue` then `listing-sections-dark-mode`) to independently rediscover that
  exact-tag lookup returns `null` on this host and that the guessed-tag fallback is unreliable.
  A one-time fix to the measurement tool would remove a recurring per-feature investigation cost.
- File the real-server-spawn concurrent-vitest flake (seen now in both `sales.test.ts` and
  `purchases.test.ts`, across two different features) as a standing known-issue, e.g. a note in
  the test suite's own README or a `vitest.config` change (reduced file-level parallelism for
  suites that spawn a real server, or a shared setup/teardown lock) — rather than each feature's
  validate pass re-running the full suite 3 times to re-prove the same non-regression.

---
This report cost approximately 8900 tokens (self-reported estimate) /
not available tokens (measured). Not counted in the feature's own total —
this analysis happened after the feature was already done.
