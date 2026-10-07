# Overview
Identify Parts used to run the whole AI pipeline inline inside one HTTP request, leaving the UI blocked behind a disabled button for 15-45+ seconds. This feature moves that work onto a DB-backed job queue: a click now enqueues a persistent row, a background worker pool picks it up and runs the pipeline, and the UI polls for the job's real stage (queued, identifying, sourcing references, comparing) instead of showing one generic spinner. Because the queue lives in DuckDB rather than server memory, a job survives a server restart and a page reload resumes the right state without re-applying results twice.

## Data layer: the job queue table and query functions
Summary: A new `identify_parts_jobs` table gives every enqueued job a persistent row, and a dedicated query module is the only place that touches it — enqueue, claim, stage transitions, and delivery tracking all go through one atomic SQL statement each.
Tasks: T1
Flow:
- Enqueue: `INSERT ... WHERE NOT EXISTS` creates a `queued` row only if none is active
- Claim: worker atomically flips the oldest `queued` row to `identifying`
- Advance: `sourcing_references` / `comparing` stage updates as the pipeline runs
- Terminate: `completeJob` or `failJob` writes the final result or error
- Acknowledge: `markDelivered` flags the row so a second poll won't re-apply it
Files:
- apps/server/src/db/schema.ts: adds the `identify_parts_job_stage` enum, the `identify_parts_jobs` table, and its listing-id index.
- apps/server/src/db/queries/identifyPartsJobs.ts: the only module that reads/writes the table — enqueue-if-none-active, get-active/latest/by-id, atomic claim, stage/complete/fail/deliver updates, and the startup orphan-reset sweep.
- apps/server/src/db/index.ts: re-exports the new query module alongside every other `db/queries/*` barrel export.
- apps/server/test/identifyPartsJobs.test.ts: unit tests for every query function, including a break-run-restore proof that the atomic enqueue actually prevents a race.
- apps/server/test/db.test.ts: updates the table-list fixture so the new table is accounted for in the "creates exactly N tables" assertion (a Cycle 0 fix).

## Background worker pool and pipeline hooks
Summary: A single async, concurrency-limited loop (not OS threads) drains the queue — claiming jobs, running the existing identification pipeline, and writing stage transitions back as it goes — with crash recovery on startup so an interrupted job isn't lost.
Tasks: T2
Flow:
- Startup: reset any job stuck in `identifying`/`sourcing_references`/`comparing` back to `queued`
- Pump: claim up to `IDENTIFY_PARTS_POOL_SIZE` queued jobs (default 1)
- Process: run `identifyListingParts`, forwarding stage callbacks
- Settle: complete or fail the job, then free the slot and pump again
Files:
- apps/server/src/jobs/identifyPartsWorkerPool.ts: `startIdentifyPartsWorkerPool()` — the pump/claim/process loop, the `POOL_SIZE` env parsing (with the fallback-on-NaN fix from Cycle 0), and the `stop()` handle for graceful shutdown.
- apps/server/src/ai/partIdentification.ts: `identifyListingParts` gains an optional `onStage` callback, fired once before the eligible-parts loop (`sourcing_references`) and once before the second AI pass (`comparing`) — no other pipeline logic changes.
- apps/server/src/index.ts: starts the pool at boot (after the scan scheduler) and wires its `stop()` into the same graceful-shutdown sequence as the scheduler's.
- apps/server/test/identifyPartsWorkerPool.test.ts: proves `onStage` fires only when eligible parts/references exist, and the pool claims/processes/transitions jobs correctly, including the pool-size-parsing fallback.
- apps/server/test/partIdentification.test.ts: extends the existing pipeline tests to cover the new `onStage` parameter.

## Routes: enqueue, poll, and acknowledge
Summary: Three HTTP endpoints replace the one synchronous route — enqueue-or-409, poll a job's status by id or by listing, and acknowledge a terminal job exactly once — each a thin pass-through to the query layer with no pipeline logic left in the request path.
Tasks: T3
Flow:
- POST /identify-parts: enqueue (201) or reject with 409 if already active
- GET .../identify-parts-jobs/latest: resolve a listing's most recent job
- GET /identify-parts-jobs/:jobId: poll one job by id
- POST /identify-parts-jobs/:jobId/ack: mark a terminal job delivered
Files:
- apps/server/src/routes/identifyParts.ts: rewritten — `POST /api/listings/:id/identify-parts` now enqueues via `insertQueuedJobIfNoneActive` (201) or throws a 409 AppError, and `GET /api/listings/:id/identify-parts-jobs/latest` resolves the most recent job for reload/resume.
- apps/server/src/routes/identifyPartsJobs.ts: new routes, `GET /api/identify-parts-jobs/:jobId` (poll by id) and `POST /api/identify-parts-jobs/:jobId/ack` (one-time delivery flag, 400 if the job isn't terminal yet).
- apps/server/src/index.ts: registers the new `identifyPartsJobs` route module alongside the rewritten `identifyParts` one.
- apps/server/test/identifyPartsConcurrency.test.ts: fires 10 genuinely concurrent POSTs at the same listing and asserts exactly one 201/nine 409s, proving the enqueue race is closed at the SQL level, not just in sequential tests.
- apps/server/test/identifyPartsRoute.test.ts: rewritten for the new enqueue/409/latest behavior (previously tested the old synchronous 200-response route).
- apps/server/test/identifyPartsJobsRoute.test.ts: route-level tests for get-by-id/ack, including the 400-on-non-terminal-ack case.
- apps/server/test/helpers.ts: `startTestServer` gains `envOverrides` so tests can disable the worker pool (`IDENTIFY_PARTS_POOL_SIZE=0`) and pre-seed a fixture DuckDB directory, keeping the real `omp` binary out of the suite.

## Web UI: stage-polling button
Summary: The Identify Parts button no longer blocks on one long request — it enqueues, polls the job every 2 seconds showing stage-specific copy, auto-applies the result once, and resumes correctly on page reload or a 409 collision.
Tasks: T4
Flow:
- Click: enqueue a job, or recover the active one on 409
- Poll: fetch the job every 2s, update the displayed stage message
- Resolve: on `completed`, auto-apply parts to Expected Parts; on `failed`, show the error
- Acknowledge: ack the job so a reload never re-applies it
- Resume: on mount, pick up any in-flight or undelivered job for this listing
Files:
- apps/web/src/features/listings/identify-parts-button.tsx: rewritten around job state instead of a boolean in-flight flag — mount-time resume via the latest-job lookup, 2s polling with per-stage copy, 409 recovery, and ack-on-terminal to guarantee at-most-once apply.
- apps/web/src/features/listings/listings-api.ts: `identifyListingParts` is replaced by four job-oriented calls — `enqueueIdentifyPartsJob`, `fetchIdentifyPartsJob`, `fetchLatestIdentifyPartsJob` (404-to-null), and `ackIdentifyPartsJob`.
- packages/shared/src/identifyPartsJob.ts: the `IdentifyPartsJobStage` union and `IdentifyPartsJob` shape shared verbatim between server and web, since the web layer polls the job directly rather than going through apps/server.
- packages/shared/src/index.ts: re-exports the new job types from the shared package barrel.
- apps/web/test/identify-parts.test.tsx: rewritten for the polling/resume/ack flow (fake timers drive the 2s interval; listings-api is fully mocked).
- apps/web/test/api-client.test.ts: updated after `identifyListingParts` was deleted from listings-api.ts (a Cycle 0 fix for a stale test import).
