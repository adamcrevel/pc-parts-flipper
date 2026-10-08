# Feature: identify-parts-dedupe-timeouts

Status: proposed
Cycle: 0 / 3
FeatureStarted: 2026-10-08T05:43:02Z
FeatureCompletedAt:
OrchestrationTokensActual: 5159
OrchestrationTokensBreakdown: input 0 + output 0 + cache-write 3,979 + cache-read 1,180, across 1 turn
Prototype: none
Walkthrough:
BaselineTests: 693
BaselineSuite: fail

## Goal

Fix two problems in the Identify Parts flow. First, running Identify Parts again on a Listing that already has Expected Parts duplicates them instead of replacing them — `persistIdentifiedParts` only ever inserts, never removes old entries. Second, the AI identification/comparison calls behind this flow still use a 120-second timeout sized for a synchronous request, even though the flow now runs as an asynchronous background job that the client polls; a slow-but-working call can get cut off, producing an avoidable timeout error.

## Requirements

1. `persistIdentifiedParts` (`apps/server/src/jobs/identifyPartsWorkerPool.ts`), which only runs once an identify-parts job finishes successfully, must delete every Expected Part already on the job's Listing — using the same `listExpectedPartsByListing` + `deleteExpectedPart` pattern already used by the manual Listing-save route (`apps/server/src/routes/listings.ts`'s `PUT /api/listings/:id`, lines 205-206) — before inserting the parts the job just identified. This is a full replace, not a merge: a part that existed before the run but isn't in the new result is removed; a part that didn't exist before but is in the new result is added.
2. A job that fails, or hasn't yet reached `completed`, must never delete or change the Listing's existing Expected Parts — the replace described in Requirement 1 only happens on the already-guarded successful-persistence path inside `processJob`'s try block, and nothing else changes there.
3. `DEFAULT_OMP_TIMEOUT_MS` (`apps/server/src/ai/ompRunner.ts`) — the per-call limit for both the "identifying" and "comparing" AI steps of the identify-parts pipeline — goes up from 120 000ms (2 minutes) to 300 000ms (5 minutes), matching the 5-minute limit `DEFAULT_OMP_SOURCING_TIMEOUT_MS` already uses for a similar multi-image AI round trip elsewhere in the same pipeline. Its doc comment is rewritten: the original 120s value was chosen for a synchronous request ("short enough that a wedged child process cannot pin a request open indefinitely"); since that call now runs inside an asynchronous background job limited by a worker-pool slot rather than an open HTTP request, the new comment should explain that instead.

## Standing Checks

- The whole test suite passes, and the test count stays at or above 693 (`BaselineTests`: `apps/server` 518, `apps/web` 175). `BaselineSuite` is recorded `fail`, but not because of a real, repeatable failure: running all 51 `apps/server` files in parallel fails exactly one file each time, but a *different* file each run (`identifyPartsRoute.test.ts` once, `photoServing.test.ts` once), and each one passes cleanly on its own — this is resource contention under this machine's full parallel load (already noted as a slow WSL/mounted-drive environment in several test files' own comments), not a bug. A single-file failure during validation that also passes in isolation is this same known flake, not something caused by this feature; a failure that still happens in isolation is a real regression and must be fixed.
- `npm run lint` (eslint, root and both workspaces) runs clean, with no new violations.
- Any new public function or exported constant added by this feature gets the same kind of header/block-comment documentation already used throughout this codebase, explaining its purpose and flow — not just a one-line label.
- No new code in `apps/web` imports directly from `apps/server` — the existing `import/no-restricted-paths` boundary (`eslint.config.mjs`) must hold (unlikely to even come up: both tasks touch only `apps/server`).
- No new code outside `apps/server/src/db/**` imports `@duckdb/node-api` directly — the existing `no-restricted-imports` boundary (`eslint.config.mjs`) must hold; both tasks reuse existing `apps/server/src/db/queries` functions only, never a raw DuckDB import.

## Tasks

| id | description | role | depends_on | status | cycle | model | started_at | completed_at | expected_minutes | estimated_start | estimated_tokens | actual_tokens | ui | files_touched |
|----|----|----|----|----|----|----|----|----|----|----|----|----|----|----|
| T1 | Fix duplicate Expected Parts on identify-parts completion (Req 1-2): in `persistIdentifiedParts` (`apps/server/src/jobs/identifyPartsWorkerPool.ts`), fetch the Listing's existing Expected Parts via `listExpectedPartsByListing` and delete each with `deleteExpectedPart` before the existing `createExpectedPart` insert loop — same pattern as `routes/listings.ts`'s `PUT /api/listings/:id` (lines 205-206), not a new helper. | builder | none | not_started | 0 | | | | | 10 | | 8000 | | no | |
| T2 | Raise `DEFAULT_OMP_TIMEOUT_MS` from 120\_000 to 300\_000 in `apps/server/src/ai/ompRunner.ts` and rewrite its doc comment per Requirement 3 — a single mechanical constant-and-comment edit, no other line in the file changes. | builder | none | not_started | 0 | derek-zoolander | | | | 5 | | 3000 | | no | |

## Assumptions

- A1 (cycle 0): "Identify Parts" is only ever reachable from the Listings page's edit form, before a Listing becomes a Purchase/Teardown — `teardown_results.expected_part_id` references `expected_parts(id)` with no `ON DELETE CASCADE`, so deleting an Expected Part that a teardown has already recorded against would orphan that reference. This is an existing, accepted risk: the manual Listing-save route (the same precedent Requirement 1 follows) already deletes and recreates every Expected Part on every save with the same exposure, undocumented and unguarded today — so Requirement 1 carries exactly the same risk as code already in production, not a new one.
- A2 (cycle 0): No database transaction wraps the delete-then-insert in Requirement 1, matching the codebase's own established pattern (the manual-save route, and every other write path in this project — no file anywhere uses `BEGIN TRANSACTION`). If an insert fails partway through after the delete (e.g. the N+1th `createExpectedPart` call throwing), a Listing could end up with fewer Expected Parts than either the old or new set. Adding transactional safety here, when the rest of the codebase has none, would be a cross-cutting change outside what was asked for.
- A3 (cycle 0): Requirement 3's new value (300 000ms) is sized to match `DEFAULT_OMP_SOURCING_TIMEOUT_MS`, not based on new measurements of real identification/comparison call durations — no new timing data was gathered beyond the existing sourcing timeout's own precedent and the user's report of an observed ~2-minute cutoff.
- A4 (cycle 0): No other timeout in the identify-parts pipeline needed changing. `DEFAULT_OMP_SOURCING_TIMEOUT_MS` (reference-photo sourcing, 5 minutes per call) and the client's job-stage polling (`identify-parts-button.tsx`'s `startPolling`, which has no poll-count give-up of its own, unlike the separate price-estimation polling) were both reviewed and found already consistent with the async job model — left untouched since the user's report named only the ~2-minute figure Requirement 3 fixes.

## Cycle Log

### Cycle 0
Trigger: initial
UAT: not_run
