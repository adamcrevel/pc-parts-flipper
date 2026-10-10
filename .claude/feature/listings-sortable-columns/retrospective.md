# Retrospective

## What happened
- This was a clean, single-cycle feature: Cycle 0 only (`Cycle: 0 / 3`), Trigger: initial, UAT
  passed on the first attempt. No `must_fix` review finding ever blocked a task — R2 and R3 each
  returned a `FAIL` line but both were on the same non-project cyclomatic-complexity rule (score
  12 on `GET /api/listings`'s handler and on `ListingsPage`), and `feature-validate-lead` overruled
  both as non-blocking (A5), so no rework task was ever added. No assumption was corrected through
  the dashboard after the fact — A1–A5 all read as decisions made once and never revisited.
- Builder-phase durations were close to estimate on the server side and ran slightly over on one
  task: T1 (shared types) took ~19 min against an expected 15; T2 (server-side sort) took ~47 min
  against an expected 40 — both modest overruns, not escalations. T3 (client wiring) shows a
  `completed_at` of `08:01:59Z`, identical to T2's `completed_at`, even though T3's own
  `started_at` (`07:54:41Z`) is ~7 minutes before that — i.e. the plan's timestamps say T3 finished
  in ~7 minutes against a 35-minute estimate, which is implausible for the scope described (3
  files, new prop threading, new tests). This reads as a timestamp-recording artifact (both tasks'
  completion logged at the same moment the orchestrator next updated the plan) rather than T3
  genuinely finishing that fast.
- All six review/test tasks (R1, TE1, R2, TE2, R3, TE3) share the identical `started_at`
  (`08:03:51Z`) and `completed_at` (`08:23:12Z`) — a 19-minute window applied uniformly across six
  tasks that ran, per their digests, substantively different amounts of work (TE2 independently
  re-ran real seed data and added a mutation-proven test; R1 only inspected one type-only file).
  This is confirmed as a real recording gap, not just a coincidence: commit `3ab0eae` ("fix:
  restore 5 plan.md rows (R1/TE1/R2/R3/TE3) missing their trailing table-closing pipe") shows these
  five rows were written in one batch edit that initially broke the markdown table and needed a
  dedicated fixup commit — the batch-write is what produced the identical timestamps.
- `TE2`'s `actual_tokens` (62,000) is 2.6x–10.9x every other review/test task in this feature (R1:
  5,700; TE1: 16,000; R2: 9,600; R3: 24,000; TE3: 20,000; U0: 26,000), despite TE2's own
  `expected_minutes` (15) being identical to R2/R3/TE3's. TE2's digest explains the cost: it
  "independently re-ran the real Source/comparison seed data (not just trusted the comments)" and
  found and closed one real gap (direction reversal never tested against a genuine tie). That is
  real, justified work, not waste — but it means the task's token cost was driven by its content,
  not its nominal size class, and the plan's flat 15-minute estimate for all four review/test tasks
  undersold TE2 specifically.
- R3's digest flags, as a non-blocking note, that `apps/web/test/bulk-identify-parts-ui.test.tsx`
  is a real consequence of T3 (it needed a scoping fix because the new header button now shares the
  "Identify Parts" label with an existing button) but was never listed in T3's `files_touched`
  column. The plan's own task table under-reports T3's true blast radius; only review caught it.
- The same non-project ESLint `complexity` rule has now produced a non-blocking `FAIL` on four
  consecutive features in this project (per A5's own citation: consolidate-listings-views,
  listing-open-link-source-readonly, part-price-estimation, and now this one), always overruled the
  same way, never once changing an outcome.

## Proposals
- Fix the plan-tooling's timestamp recording so batched review/test task rows get real per-task
  `started_at`/`completed_at` values instead of the single moment the orchestrator next wrote the
  table — otherwise duration data for R*/TE* tasks (as seen here, and likely in other features) is
  unusable for exactly this kind of retrospective.
- Add a lint/pre-commit check on `plan.md`'s task table (e.g. verifying every row has the same
  pipe count as the header) so a malformed row needs its own fixup commit (`3ab0eae`) only once,
  not again in a future feature.
- Stop reviewers from invoking the un-wired ESLint `complexity` rule at all. It has now fired on
  four features in a row (R2/R3 here, plus three prior features per A5) and been overruled every
  time with the identical reasoning. Either wire a real complexity budget into
  `eslint.config.mjs` with an actual threshold the team intends to enforce, or instruct
  `feature-reviewer` to drop this check entirely — the current state spends review tokens
  producing a `FAIL` line that is never actionable.
- When a builder task's description implies a cross-cutting UI change (here: a header `<th>`
  becoming a `<button>` with the same visible label as an existing button elsewhere on the page),
  add "grep for existing tests selecting by this label/role" as an explicit sub-step in the task,
  so the task's own `files_touched` captures incidental test fixes like
  `bulk-identify-parts-ui.test.tsx` up front instead of relying on the reviewer to catch the gap.
- When sizing review/test tasks that call for independently re-deriving ground truth from seed
  data (as TE2's prompt explicitly asked for), size that one task's `expected_minutes`/budget apart
  from its sibling review/test tasks rather than giving all four a flat 15 minutes — TE2's
  10x token cost relative to R1 here was a predictable consequence of its prompt, not a surprise.

---
This report cost approximately 11,900 tokens (self-reported estimate) /
not available (measured — the caller measures actual token usage from the dispatch tag; a
sub-agent's own transcript search returns the parent session's whole conversation, not this run in
isolation). Not counted in the feature's own total — this analysis happened after the feature was
already done.
