# Feature: sourcing-resilience

Status: planning
Cycle: 0 / 3
FeatureStarted: 2026-10-09T18:50:00Z
BaselineTests: 787
BaselineSuite: pass

## Goal

Two real, live-observed failure modes are currently treated as permanent, un-retryable dead
ends, discarding real information the AI model never actually got a chance to produce:

1. **Sourcing-attempt level**: reference-photo sourcing (`referenceSourcingOrchestrator.ts`) and
   catalog-mode sourcing (`catalogSourcingOrchestrator.ts`) each record one attempt per
   `(category, brand[, partNumber])` combo, *ever* — a unique DB index blocks any future retry.
   Observed live (user's own screen, via `omp`'s internal headed Chrome-for-Testing window) at
   `IDENTIFY_PARTS_POOL_SIZE=8`: HTTP 429 rate-limiting on crucial.com and a bot-detection
   "confirm you're human" block on zotac.com. Both get recorded as a normal, permanent
   `succeeded:false` attempt today — that combo's reference photo is now permanently
   un-sourceable, even though the model never got a genuine chance to search.
2. **Job level**: identify-parts and price-research jobs (`identifyPartsWorkerPool.ts`,
   `pricePartsWorkerPool.ts`) mark a job permanently `failed` on ANY thrown error from the
   `omp` call or its parser, with zero automatic retry. Observed live: during a ~2 hour window
   when the operator's own Claude account hit its usage limit, 13 of 185 queued identify-parts
   jobs failed with `'omp' exited with code 1 ... (is it installed and logged in?)` and are now
   stuck `failed` forever, solely because of a transient, unrelated outage.

Both cases share one principle (confirmed explicitly with the user): an **infrastructure
failure** (a thrown error at any level, a timeout, a non-zero exit, or — newly — a clean model
response that explicitly reports it was blocked) is not a genuine "searched and found nothing"
signal, and must not permanently foreclose a retry. Only a clean, structurally-valid "not found"
response continues to permanently block future attempts for sourcing; job-level failures have no
such genuine-failure case at all (confirmed by reading both worker pools in full — see
Assumption A3), so every job-level failure besides "the Listing was deleted" is retry-eligible.

This feature adds, together:
- **Per-brand sourcing concurrency cap**: no more than `SOURCING_PER_BRAND_CONCURRENCY`
  (default 1, env-configurable) `omp` sourcing calls for the same brand run at once — brand is
  used as a practical proxy for "which manufacturer site is about to get hit" (see Assumption
  A1). Overall identify-parts pool concurrency (`IDENTIFY_PARTS_POOL_SIZE=8`) is explicitly
  **unchanged** — this is a narrow per-brand cap inside sourcing, not a global throttle.
- **Exponential-backoff retry on infrastructure failure**, at both the sourcing-attempt level
  (reference-photo and catalog paths) and the job level (identify-parts and price-research),
  with no cap on retry count (see Assumption A2) — the same growing, self-limiting backoff
  schedule throughout, reusing one shared helper.
- **A `blocked` signal in the two sourcing AI responses**, so the model itself can report "I was
  rate-limited / shown a CAPTCHA / otherwise denied access" distinctly from "I searched and
  found nothing" — the only way to tell these apart when the omp call itself still exits 0 with
  a structurally-valid response.
- **Extending the harden-ai-json-parsing fix to three more parsers.** While investigating this
  feature, live logs from the still-running 185-listing batch showed the identical
  prose-wrapped-JSON failure the prior feature fixed in `identificationParser.ts`/
  `visualComparisonParser.ts` is also occurring, unfixed, in `catalogSourcingParser.ts` and
  `imageSourcingParser.ts` (both already in scope here for the `blocked` field), and in
  `priceEstimationParser.ts` (a separate pipeline, included per explicit user direction after
  this was surfaced) — e.g. a real captured catalog-sourcing response, `"Confirmed — https
  resolves fine...\n\n{\"products\":[{...real valid JSON...}]}"`, was discarded as unparseable
  moments before this plan was drafted.

## Requirements

1. A sourcing attempt (reference-photo or catalog) that fails due to an infrastructure problem —
   a thrown error at any level (spawn failure, non-zero exit, timeout) from the `omp` call, OR a
   clean model response that explicitly reports `blocked:true` — is retried later with
   exponential backoff, instead of being permanently recorded as "attempted, never retry."
2. A sourcing attempt that completes cleanly and reports a genuine not-found (image sourcing:
   `found:false, blocked:false`; catalog sourcing: zero products with `blocked:false`) continues
   to be permanently recorded and never retried — today's dedup behavior for a genuine
   not-found is unchanged.
3. The backoff interval grows exponentially with each successive infra failure for the same
   combo, capped at a maximum interval so it never waits unboundedly long, but with **no cap on
   the number of retries** — a combo that keeps hitting infra failures is retried forever,
   increasingly rarely, since an infra failure alone can never prove a combo is "truly
   unfindable" (explicit user direction).
4. Concurrent `omp` sourcing calls are capped per brand: no more than
   `SOURCING_PER_BRAND_CONCURRENCY` (default 1, env-configurable, same validation convention as
   `IDENTIFY_PARTS_POOL_SIZE`) sourcing calls for the same brand run at once; a call beyond the
   cap waits its turn rather than failing or being silently dropped. Overall identify-parts
   concurrency is unaffected — this is scoped to sourcing calls only, keyed per brand, not a
   global sourcing throttle and not a change to `IDENTIFY_PARTS_POOL_SIZE`.
5. An identify-parts job that fails for any reason **other than its Listing having been
   deleted** (every `omp`-call failure, every parser failure) is retried later with the same
   exponential-backoff schedule as Requirement 3, instead of being permanently marked `failed`.
   A job whose Listing no longer exists continues to fail permanently and immediately (retrying
   can never make a deleted Listing reappear).
6. A price-research job that fails for any reason is retried the same way — price-parts jobs
   have no genuine-business-failure outcome today ("no confident price" is already a completed,
   non-failure result; confirmed by reading `priceEstimationParser.ts`'s own contract), so every
   job-level failure here is infra-retry-eligible with no permanent-failure case at all.
7. A job queued for retry is indistinguishable, from the outside, from a normal fresh `queued`
   job — same stage, same polling/UI behavior — until its backoff window reopens and it is
   claimed again. No new job stage, no UI change (this feature touches `apps/server` only).
8. The two sourcing AI prompts/parsers (image sourcing, catalog sourcing) gain a `blocked`
   boolean field the model can set alongside its existing found/not-found shape, with explicit
   prompt instructions distinguishing "I was rate-limited/CAPTCHA'd/denied access" from "I
   searched and found nothing" — the only way to classify Requirement 1 vs Requirement 2 for a
   call that completes without throwing.
9. The same prose-wrapped-JSON parsing fallback the harden-ai-json-parsing feature added to
   `identificationParser.ts`/`visualComparisonParser.ts` (`extractBracketedJson`, tried only
   after a direct parse fails) is also applied, unchanged in mechanism, to
   `catalogSourcingParser.ts`, `imageSourcingParser.ts`, and `priceEstimationParser.ts`. A
   genuinely malformed/no-JSON-at-all response still fails (sourcing parsers) or still resolves
   to "no confident price"/"not found" (price estimation) exactly as it does today — this only
   recovers a response that already contains a complete, valid JSON payload somewhere in its
   text.
10. No existing DDL pattern is violated: every new column is added via plain `ALTER TABLE ...
    ADD COLUMN IF NOT EXISTS` (never `ALTER COLUMN`/`DROP COLUMN`/`ADD CONSTRAINT`, which DuckDB
    rejects on any FK-referenced table), and no code relies on `current_timestamp` inside an
    `ON CONFLICT ... DO UPDATE SET` clause (a known DuckDB defect — see Assumption A5);
    timestamps involved in any multi-step record/retry write are computed once in application
    code and bound as parameters.

## Standing Checks

- The whole test suite passes, and the test count stays at or above `BaselineTests` (787).
- `npm run lint` runs clean with no new violation.
- Any new public function or component this feature adds carries the same kind of header/block
  comment documentation already used elsewhere in the codebase, explaining its purpose and flow,
  not just a one-line label.
- This feature is `apps/server`-only (and one new top-level `packages/shared`-free helper) — no
  `apps/web` file is touched by any task; no prototype, no browser UAT (same precedent as
  harden-ai-json-parsing's A3).
- No `ALTER COLUMN`/`DROP COLUMN`/`ADD CONSTRAINT` statement is added to `schema.ts` for any
  existing table — only `ADD COLUMN IF NOT EXISTS`.
- No rebuild-migration in `apps/server/src/db/migrate.ts` needs updating — none of the four
  tables this feature adds columns to (`part_reference_sourcing_attempts`,
  `part_catalog_sourcing_attempts`, `identify_parts_jobs`, `price_parts_jobs`) appear in
  `migrateExpectedPartsNullablePrice` or any other rebuild migration (confirmed by grep before
  this plan was drafted; re-confirm this is still true if a future cycle touches `migrate.ts`).

## Tasks

| id | description | role | depends_on | status | cycle | model | started_at | completed_at | expected_minutes | estimated_start | estimated_tokens | actual_tokens | ui | files_touched |
|----|----|----|----|----|----|----|----|----|----|----|----|----|----|----|
| T1 | Shared exponential-backoff helper + DB schema for all four affected tables (Req 3, 10). New `apps/server/src/retryBackoff.ts`: exports `BASE_RETRY_DELAY_MS = 300_000` (5 min), `MAX_RETRY_DELAY_MS = 86_400_000` (24h), and `computeNextRetryAt(attemptCount: number, now: Date = new Date()): Date` — a pure function returning `now + min(BASE_RETRY_DELAY_MS * 2^(attemptCount-1), MAX_RETRY_DELAY_MS)` ms, where `attemptCount` is the 1-indexed count of this failure (first infra failure for a combo/job passes 1, second passes 2, etc. — never 0). `apps/server/src/db/schema.ts`'s `ALTER_STATEMENTS` array: add `ALTER TABLE part_reference_sourcing_attempts ADD COLUMN IF NOT EXISTS blocked BOOLEAN NOT NULL DEFAULT false`, `... ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 1`, `... ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMP`; identical three columns on `part_catalog_sourcing_attempts`; `ALTER TABLE identify_parts_jobs ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0`, `... ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMP`; identical two columns on `price_parts_jobs`. Never touch `TABLE_STATEMENTS` (the original `CREATE TABLE` bodies) — additive `ALTER_STATEMENTS` only, matching this file's own existing convention. | builder | | pending | 0 | | | | 20 | | | | no | apps/server/src/retryBackoff.ts, apps/server/src/db/schema.ts |
| T2 | Sourcing-attempt query layer: outcome-aware recording + backoff-gated skip-check (Req 1, 2, 3, 10). `apps/server/src/db/queries/sourcingAttempts.ts` and `apps/server/src/db/queries/catalogSourcingAttempts.ts`: change `hasSourcingBeenAttempted`/`hasCatalogSourcingBeenAttempted`'s query to also require `(next_retry_at IS NULL OR next_retry_at <= current_timestamp)` — an infra-blocked combo whose backoff window has reopened is no longer reported as "already attempted," while a genuinely succeeded/not-found combo (`next_retry_at` stays null forever for those, per T6) keeps reporting true exactly as today. Change `recordSourcingAttempt`/`recordCatalogSourcingAttempt`'s signature from a `succeeded: boolean` parameter to `outcome: 'succeeded' \| 'not_found' \| 'infrastructure_blocked'`. Implementation: SELECT the existing row's `attempt_count` first (absent = 0); compute `newAttemptCount = existing + 1`; compute `nextRetryAt = outcome === 'infrastructure_blocked' ? computeNextRetryAt(newAttemptCount) : null` (Req 1, 2) using T1's helper; then either INSERT a first-ever row or UPDATE the existing one with the new `succeeded`/`blocked`/`attempt_count`/`next_retry_at`/`attempted_at` (bind `new Date()` as a parameter for `attempted_at` — do NOT use SQL `current_timestamp` inside any upsert-style write, Req 10/Assumption A5). Keep the existing unique-constraint-violation catch (a concurrent duplicate INSERT race) exactly as today, logged and skipped, not thrown. Update both files' header comments and function doc comments to describe the new retry-aware semantics; update every call site outside this feature's own T6 that referenced the old `succeeded: boolean` param (grep for all callers first). | builder | T1 | pending | 0 | | | | 35 | | | | no | apps/server/src/db/queries/sourcingAttempts.ts, apps/server/src/db/queries/catalogSourcingAttempts.ts |
| T3 | Job-level retry-or-fail query functions + backoff-gated claim queries (Req 5, 6, 7, 10). `apps/server/src/db/queries/identifyPartsJobs.ts`: new `retryOrFailJob(jobId: string, errorMessage: string): Promise<void>` — SELECT the job's current `retry_count`, compute `newRetryCount = retry_count + 1` and `nextRetryAt = computeNextRetryAt(newRetryCount)` (T1), then `UPDATE identify_parts_jobs SET stage = 'queued', retry_count = $newRetryCount, next_retry_at = $nextRetryAt, error_message = $errorMessage, updated_at = current_timestamp WHERE id = $id` (leave `started_at`/`completed_at` untouched — `claimNextQueuedJob` re-stamps `started_at` on the next successful claim). `claimNextQueuedJob`'s subselect WHERE clause gains `AND (next_retry_at IS NULL OR next_retry_at <= current_timestamp)` (Req 7 — a retrying job is claimable again only once its window reopens, otherwise behaves exactly like any other queued job). The existing bare `failJob` function and its one call site (the `listing === null` branch in `identifyPartsWorkerPool.ts`, untouched by this task) stay exactly as today — permanent failure, no retry (Req 5). Identical mirrored changes in `apps/server/src/db/queries/pricePartsJobs.ts`: new `retryOrFailPriceJob(jobId: string, errorMessage: string): Promise<void>`, same shape; `claimNextQueuedPriceJob`'s subselect gains the same backoff guard; `failPriceJob` itself is unused after T7 rewires its only call site, but is NOT removed (Req 6 — no permanent-failure case exists for price jobs, so nothing calls it anymore once T7 lands, but deleting an exported, tested function the plan doesn't require deleting is out of scope — leave it in place for now, a future cleanup can remove true dead code once confirmed unused by every caller including tests). | builder | T1 | pending | 0 | | | | 30 | | | | no | apps/server/src/db/queries/identifyPartsJobs.ts, apps/server/src/db/queries/pricePartsJobs.ts |
| T4 | Prompt + parser changes: `blocked` signal for both sourcing paths, and the proven JSON-extraction fallback for three parsers (Req 8, 9). `apps/server/src/ai/imageSourcingPrompt.ts`: add an instruction telling the model to respond `{"found":false,"url":null,"blocked":true}` specifically when a rate limit, CAPTCHA/"verify you're human" challenge, or any other access-denied condition prevented it from completing a real search — distinct from `{"found":false,"url":null,"blocked":false}` for a genuine, completed, nothing-found search. `apps/server/src/ai/imageSourcingParser.ts`: `ImageSourcingResult` gains `blocked: boolean`; parse the `blocked` field defensively (non-boolean or absent coerces to `false`, no warning needed, same style as the existing `url`-when-not-found normalization); add the `extractBracketedJson` fallback (imported from `identificationParser.ts`, exactly the harden-ai-json-parsing pattern: direct parse first, on failure try `extractBracketedJson(rawStdout, 'object')` against the ORIGINAL raw text, re-parse that, only then fall through to the existing "not valid JSON" throw if both attempts fail). `apps/server/src/ai/catalogSourcingPrompt.ts`: same `blocked` field addition as a top-level sibling to `products`, with matching instruction wording; update both example JSON blocks in the prompt. `apps/server/src/ai/catalogSourcingParser.ts`: change `parseCatalogSourcingResponse`'s return type from `CatalogSourcingCandidate[]` to a new exported `interface CatalogSourcingResult { candidates: CatalogSourcingCandidate[]; blocked: boolean }` (breaking signature change — T6 updates the one call site in `catalogSourcingOrchestrator.ts`); parse `blocked` the same defensive way; add the same `extractBracketedJson('object', ...)` fallback. `apps/server/src/ai/priceEstimationParser.ts`: add ONLY the `extractBracketedJson('object', ...)` fallback to `parsePriceEstimationResponse` (no `blocked` field — this pipeline has no sourcing-attempt dedup table and no retry concern; this is purely recovering a real confident price the model already gave but wrapped in prose, e.g. the live-observed `"...$90 consistently.\n\n{\"confident\":true,\"priceUsd\":90.00}"` case). New tests per parser: a `blocked:true` parse case for the two sourcing parsers; a leading-prose-plus-bare-JSON fallback-recovery case for all three touched parsers, mirroring harden-ai-json-parsing's own test style (construct the exact failure shape, confirm it fails pre-fix reasoning is unnecessary here since this is new code, just confirm it parses correctly); confirm each parser's existing fully-malformed/no-JSON case still fails (sourcing parsers) or still resolves to null/not-found (price estimation) unchanged. | builder | | pending | 0 | | | | 45 | | | | no | apps/server/src/ai/imageSourcingPrompt.ts, apps/server/src/ai/imageSourcingParser.ts, apps/server/src/ai/catalogSourcingPrompt.ts, apps/server/src/ai/catalogSourcingParser.ts, apps/server/src/ai/priceEstimationParser.ts |
| T5 | Per-brand sourcing concurrency limiter (Req 4). New `apps/server/src/ai/sourcingConcurrencyLimiter.ts`: exports `runWithBrandLimit<T>(brand: string, fn: () => Promise<T>): Promise<T>`. Internal module-level state: a `Map<string, { active: number; waiters: Array<() => void> }>` keyed on a normalized brand (trim + lowercase, so casing/whitespace differences across model responses for the same real brand share one limit). When the keyed entry's `active` count is already at `SOURCING_PER_BRAND_CONCURRENCY`, the call awaits a promise that resolves when a slot frees up (FIFO — resolved in the order calls arrived); otherwise it proceeds immediately. `active` is decremented and the next waiter (if any) is woken in a `finally` block around `fn()`, so a thrown error from `fn` still releases the slot. `SOURCING_PER_BRAND_CONCURRENCY` parsed from `process.env.SOURCING_PER_BRAND_CONCURRENCY` with the exact same defensive-parsing rule `identifyPartsWorkerPool.ts`'s `parsePoolSize` already uses (missing/empty/negative/non-finite falls back to a default of 1; 0 is a valid, intentional disable-like value — though unlike pool size, 0 concurrent calls for any brand would deadlock every sourcing attempt forever, so document this edge case explicitly in a comment even though parsePoolSize's own convention keeps 0 valid; do not special-case it away, just document the hazard). This module has no DB/network dependency of its own — fully unit-testable with fake async functions and fake timers/manual resolution order, no `omp`/DB stubbing needed. | builder | | pending | 0 | | | | 30 | | | | no | apps/server/src/ai/sourcingConcurrencyLimiter.ts |
| T6 | Sourcing orchestrator integration: wires T2 (recording), T4 (parser/blocked), T5 (brand limiter) together (Req 1, 2, 4, 8). `apps/server/src/ai/referenceSourcingOrchestrator.ts`'s `attemptSourcing`: wrap the `getOmpSourcingRunner()(...)` call in `runWithBrandLimit(brand, () => ...)`. Replace the current try/catch's binary succeeded/failed bookkeeping with three-way classification: a thrown error (from the omp call OR from `parseImageSourcingResponse`) records `'infrastructure_blocked'`; a clean result with `blocked: true` also records `'infrastructure_blocked'`; a clean result with `found: false, blocked: false` records `'not_found'`; a clean result with `found: true` whose photo download/verification (`insertSourcedReferencePhoto` or equivalent) actually succeeds records `'succeeded'`; a clean `found: true` result whose download/verification fails records `'not_found'` (the model's claimed URL didn't pan out — a model-content problem, not an infra signal; call this out explicitly in a comment since it is a deliberate edge-case choice, not an oversight). `apps/server/src/ai/catalogSourcingOrchestrator.ts`'s `sourceCatalogIfNeeded`: same pattern — wrap the omp call in `runWithBrandLimit(brand, () => ...)`; update the call site for T4's new `{ candidates, blocked }` return shape (was a bare array); a thrown error or `blocked: true` records `'infrastructure_blocked'`; zero `insertedCount` with `blocked: false` records `'not_found'`; `insertedCount > 0` records `'succeeded'`. Both files' existing "never throws to the caller, always resolves" contract (Requirement 3 from their own prior features) is preserved unchanged — only the internal classification passed to T2's `recordSourcingAttempt`/`recordCatalogSourcingAttempt` changes. | builder | T2;T4;T5 | pending | 0 | | | | 30 | | | | no | apps/server/src/ai/referenceSourcingOrchestrator.ts, apps/server/src/ai/catalogSourcingOrchestrator.ts |
| T7 | Job worker pool integration: wires T3's retry-or-fail functions into both pools (Req 5, 6, 7). `apps/server/src/jobs/identifyPartsWorkerPool.ts`'s `processJob`: replace the catch block's `await failJob(job.id, message);` with `await retryOrFailJob(job.id, message);`. The existing, separate `if (listing === null) { await failJob(job.id, 'Listing no longer exists'); return; }` branch (above the try/catch, not inside it) is UNCHANGED — stays a permanent, non-retried failure. `apps/server/src/jobs/pricePartsWorkerPool.ts`'s `processJob`: replace the catch block's `await failPriceJob(job.id, message);` with `await retryOrFailPriceJob(job.id, message);` (no permanent-failure branch exists in this file at all, per Req 6). Update both files' top-of-file header comments, which currently describe "stage transitions ... then finally to 'completed' or 'failed'," to also describe the new "a retry-eligible failure returns to `queued` with a growing backoff delay instead" path. | builder | T3 | pending | 0 | | | | 20 | | | | no | apps/server/src/jobs/identifyPartsWorkerPool.ts, apps/server/src/jobs/pricePartsWorkerPool.ts |

## Assumptions

- A1 (cycle 0): Per-brand concurrency is keyed on **brand**, not the literal network domain —
  the model, not our code, decides which URL/site to browse to, so the real domain is only
  knowable after the `omp` call has already returned. Brand is the only information available
  *before* the call starts that correlates with which manufacturer's site is about to be hit,
  and is a reasonable practical proxy for the user's "same domain" intent, stated here
  explicitly as an implementation detail rather than assumed silently.
- A2 (cycle 0): No cap on retry attempt count, at either the sourcing-attempt or job level — per
  explicit user direction, an infra failure can never prove a combo/job is permanently
  unfindable/unprocessable, so retries continue forever with a growing (capped at 24h) interval
  between attempts, which is itself self-limiting.
- A3 (cycle 0): Confirmed by reading both worker pools' `processJob` in full: neither
  `identifyListingParts` nor the price-estimation call chain has any "genuine business failure"
  outcome distinct from an infra/parsing failure — an empty `parts: []` or a null price is
  already a *successful* completion, never a thrown error. The ONE exception is identify-parts'
  explicit "Listing no longer exists" check, handled outside the try/catch and left permanent.
  This means job-level retry needs no outcome classification at all (unlike sourcing-attempt
  level, which must distinguish infra-blocked from genuine not-found) — every caught exception
  is retry-eligible by construction.
- A4 (cycle 0): `SOURCING_PER_BRAND_CONCURRENCY` defaults to 1 (full serialization per brand) —
  the two live-observed failures (429, bot-detection) both occurred under concurrent same-site
  access, so the conservative default directly addresses the reported problem; configurable
  later via `.env` the same way `IDENTIFY_PARTS_POOL_SIZE` was tuned this session, without a
  code change.
- A5 (cycle 0): DuckDB's `INSERT ... ON CONFLICT DO UPDATE` upsert syntax is supported
  (confirmed via DuckDB's own documentation), but a known defect
  (duckdb/duckdb#14404) causes `current_timestamp` used directly inside a `DO UPDATE SET` clause
  to fail on some versions. T2/T3 sidestep this entirely by using a plain SELECT-then-
  INSERT-or-UPDATE in application code (binding `new Date()` as a parameter) rather than a
  single atomic upsert statement — this reintroduces a narrow, already-accepted race (two
  concurrent calls for the identical combo/job could both SELECT before either writes), which
  the existing unique-index-violation catch (sourcing attempts) or per-job-id exclusivity
  (worker pools — exactly one call ever processes a given job id at a time) already covers
  without data corruption, matching this codebase's existing tolerance for this exact class of
  benign race (documented in `sourcingAttempts.ts`'s own header comment today).
- A6 (cycle 0): `priceEstimationParser.ts`'s fix (Req 9) is independent of every other task here
  — it touches a pipeline with no sourcing-attempt dedup table, no job-level retry concern (a
  parse failure there already silently resolves to "no confident price," never throws), and no
  `blocked` field. It is included per explicit user confirmation after being surfaced mid-scoping
  (live evidence: a real captured response, `"Original full-tower... $90 consistently.\n\n
  {\"confident\":true,\"priceUsd\":90.00}"`, logged as unparseable and discarded), not because it
  shares any mechanism with the retry/concurrency work.
- A7 (cycle 0): This feature does not change `IDENTIFY_PARTS_POOL_SIZE` (stays 8) or add any new
  global/process-wide sourcing throttle — only a per-brand cap inside sourcing calls, per the
  user's explicit "otherwise keep the current concurrency we have now" direction.

## Cycle Log

### Cycle 0
Trigger: initial

