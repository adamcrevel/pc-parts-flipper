# Overview
Re-running "Identify Parts" on a Listing that already had Expected Parts used to duplicate
them, because the job only ever inserted and never cleared the old rows. This feature makes
that a full replace instead, and separately raises the AI call timeout from 2 to 4 minutes now
that identification runs as a polled background job rather than behind an open HTTP request.
Fixing the first change also surfaced two incomplete test mocks and a stale cross-file comment,
all patched along the way so the suite stays green and accurate.

## Replace, don't duplicate, Expected Parts on rerun
Summary: `persistIdentifiedParts` now deletes every Expected Part already on the job's Listing
before inserting the freshly-identified ones, using the same list-then-delete pattern the manual
Listing-save route already uses — but only on the successful-completion path, so a failed job
never touches existing parts.
Tasks: T1
Flow:
- Job completes: `processJob` reaches the success path after `identifyListingParts` resolves
- List existing: `listExpectedPartsByListing` fetches the Listing's current Expected Parts
- Delete all: each existing part is removed via `deleteExpectedPart`
- Insert fresh: the newly-identified parts are created via `createExpectedPart`
- Trigger pricing: only the newly-created parts are handed to `triggerPriceLookups`
Files:
- apps/server/src/jobs/identifyPartsWorkerPool.ts: adds the delete-then-insert full replace inside `persistIdentifiedParts`, gated so it only runs on the already-guarded successful path.
- apps/server/test/identifyPartsWorkerPool.test.ts: adds two new tests driven through the real `processJob` path proving the replace removes both hand-entered and prior AI-sourced parts and leaves them untouched on job failure.

## Raise the AI call timeout for the async job model
Summary: `DEFAULT_OMP_TIMEOUT_MS` moves from 120s to 240s because identification/comparison calls
now run inside a polled background job, not behind a synchronous request, so the old
request-sized ceiling can cut off a slow-but-working call; the new value stays strictly below
the 300s sourcing timeout.
Tasks: T2
Files:
- apps/server/src/ai/ompRunner.ts: doubles `DEFAULT_OMP_TIMEOUT_MS` to 240_000 and rewrites the doc comment to explain the async-job context and the 300s ceiling it must stay under.
- apps/server/test/partIdentification.test.ts: updates the two tests that pinned the old 120_000 value and `'timed out after 120000ms'` message to the new 240_000/240000ms.

## Latent bugs caught by review, test, and UAT
Summary: three small, pre-existing issues surfaced only because T1 and T2 exercised code paths
that hadn't been fully covered before — none of them were asked for directly, all three were
fixed as part of landing this feature cleanly.
Tasks: T1, T2
Files:
- apps/server/test/identifyPartsWorkerPool.test.ts: its mock barrel for `db/index.js` was missing `listExpectedPartsByListing`/`deleteExpectedPart`/`createExpectedPart`, so T1's new calls broke 5 of 8 pre-existing tests until the barrel was completed.
- apps/server/test/identifyPartsPriceTrigger.test.ts: shared the same `db/index.js` mock barrel gap as the file above — found and fixed for the same reason, before it could break under a future change.
- apps/server/src/ai/ompSourcingRunner.ts: its doc comment described the sourcing timeout as "2.5x ompRunner.ts's 120s", a ratio that went stale the moment T2 raised that constant to 240s; corrected to "1.25x ompRunner.ts's 240s" by the reviewer pass on T2.
