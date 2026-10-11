# Retrospective

## What happened

- **Cycle 1 existed because Requirement 1's notes field never reached the HTTP route validation
  layer.** U0 (Cycle 0 UAT) found that `apps/server/src/routes/listingValidation.ts`'s
  `ExpectedPartRequestBody`/`validateExpectedPartInput` never declared or returned a `notes` field,
  so a note typed in the Expected Parts editor was silently discarded on both `POST
  /api/listings` and `PUT /api/listings/:id` before reaching the db layer. Every one of T1 (shared
  types), T2 (DB/query layer), T4 (AI write path), and T6 (editor UI) correctly touched its own
  layer, and R1/R2/R4/R6 each reviewed those files and passed — but no task in the plan named
  `listingValidation.ts` at all, and no reviewer's scope included it, so the gap in the
  create/update HTTP path was invisible to every one of the seven Cycle-0 builder/reviewer pairs.
  Only U0's end-to-end "type a note, save, reload" exercise caught it, which is exactly what UAT is
  for, but it is a four-task, fourth-layer requirement that a five-minute code-level check (grep for
  every caller of `ExpectedPartInput`) would have caught two hours earlier.
- **Cost of Cycle 1:** three new tasks (T8, R8, TE8) plus a full UAT re-run (U1). T8+R8+TE8 summed
  `expected_minutes` 10+10+15=35 min against `actual_tokens` 33,180+25,985+102,015=161,180; real
  elapsed from T8's start (09:09:10) to TE8's completion (09:33:29) was ~24 minutes. U1 alone was
  budgeted 25 `expected_minutes` but ran 09:44:20→10:48:00, ~64 minutes real elapsed (2.6× its own
  estimate) at 62,000 `actual_tokens`, because it re-verified every one of Requirements 1-13 (not
  just the one that broke) since T8 touched shared validation code. Cycle 1 in total — from T8's
  start to U1's completion — spans roughly 99 minutes of the feature's ~8h19m wall-clock total.
- **Token-accounting artifact in the Cycle-0 batch review/test phase.** R2, R4, R5, R6, TE2–TE7 all
  carry the identical `actual_tokens` value `250761` (and R1/R3 both carry `183347`), despite
  covering different files with different scopes. All of these rows also share the exact same
  `started_at`/`completed_at` window (07:43:17Z–08:16:39Z), meaning they were dispatched and logged
  as one batched session rather than isolated per-task runs. The repeated totals are the batch's
  cumulative session cost stamped onto every row in it, not a real per-task figure — so none of
  these individual numbers can be read as "R4 cost 250,761 tokens" without that caveat.
- **No task overran its `expected_minutes` by a damaging margin** once real elapsed time is read
  per-task rather than through the shared batch window: T4/T5 (07:24:43→07:29:21, ~4.6 min against
  15/20 min budgets), T6 (07:18:10→07:24:18, ~6 min against 35), T7 (07:29:31→07:30:32, ~1 min
  against 20) all landed comfortably inside estimate. U0 itself (25 min real against a 30 min
  budget) was on-target. The only real duration overrun in the whole feature is U1, covered above.
- **No `model` escalation** occurred anywhere in the task table — every task stayed at its
  originally-assigned model; the one reactive-looking event (R6's cyclomatic-complexity flag) was a
  reviewer running an ad hoc, unconfigured `eslint --rule complexity:10` check against code that
  passes the project's real `npm run lint` clean, and was correctly downgraded by validate-lead to a
  non-blocking recommendation (Assumption A9) rather than driving a fix task or an escalation.
- **No `context_split`** is visible in the task table — every task's `files_touched` list matches
  its own description's named files with no row that was later broken into more than one task to
  cover scope creep.
- **One assumption was corrected mid-feature, but by direct user confirmation up front, not by a
  later dashboard correction:** A1–A8 were all settled in Cycle 0 before any task started (per the
  Goal section's "confirmed with the user across four clarifying questions"), and none of A1-A9 was
  revised in Cycle 1. The plan's one post-hoc assumption, A9 (the complexity-flag downgrade), was
  added *because* of a Cycle-0 reviewer finding, not corrected after being wrong — it's a recorded
  decision, not a guess that missed.

## Proposals

- **Add an explicit "name every layer a new request-body field must cross" step to task-planning
  for any field addition that touches both a stored-entity type and an HTTP write path.** This
  feature's own Requirements section named four touch points for `notes` (shared type, DB, AI write
  path, editor UI) but never named `listingValidation.ts`/`ExpectedPartRequestBody` as a fifth. A
  concrete fix: when a plan adds a field to `ExpectedPart`/`ExpectedPartInput` (or any shared type
  with a corresponding `*RequestBody` validator), require one task or one reviewer's explicit scope
  line naming `apps/server/src/routes/listingValidation.ts` (or the equivalent validator file for
  the type in question) — the same way T2 already explicitly named both of `migrate.ts`'s two
  column lists after that exact class of mistake had bitten this project twice before. This is
  precisely that pattern recurring at a different layer.
- **Give R1 (reviewer of the shared-type task) a standing cross-check: "grep every production
  caller of the type/interface this task modified for the new field's name; confirm each either
  threads it through or is explicitly out of scope."** Had R1 (or any Cycle-0 reviewer) grepped for
  `ExpectedPartInput` across `apps/server/src/routes/`, the missing `notes` entry in
  `listingValidation.ts` would have surfaced before U0 rather than in it — the same 24 minutes
  Cycle 1 spent fixing and re-testing it, plus the 64-minute full UAT re-run U1 had to do out of
  caution once a shared validation file was touched late.
- **Stop batching review/test tasks into one shared-session dispatch if per-task `actual_tokens`
  is meant to drive cost analysis**, or explicitly mark batched rows with a shared-session id
  instead of repeating the batch total on every row. R2/R4/R5/R6/TE2-TE7 (and the R1/R3 pair) all
  carry duplicate totals from the same 07:43:17–08:16:39 window, so any per-task token accounting
  pulled from this plan for these rows will overstate individual-task cost by counting the same
  tokens seven times over. If batching review/test work is intentional (and it looks efficient
  here — 12 reviewer/tester tasks finished in one ~33-minute window), log one shared-session total
  once rather than stamping it onto each row as if it were that row's own cost.

---
This report cost approximately 11,900 tokens (self-reported estimate) / not available (measured —
the caller measures this from the dispatch tag it gave me, since a sub-agent's tool-reported usage
is not visible to me). Not counted in the feature's own total — this analysis happened after the
feature was already done.
