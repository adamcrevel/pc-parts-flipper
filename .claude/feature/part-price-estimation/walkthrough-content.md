# Overview

Whenever an Expected Part becomes fully identified — it gets both a brand and a part number,
whether from the AI's Identify Parts job or from a user typing it in — the system now looks up or
researches a resale-value estimate for it in the background, with no user action needed. Prices
are cached by (category, brand, part number) and shared across every Listing, refreshed once a
day, and — the trickiest part of this feature — never overwritten once a user has claimed that
row's price as their own, even if they later clear it back to blank.

## Schema and shared types

Summary: The two new tables and the one new column everything else in this feature reads and
writes.
Tasks: T1
Files:
- apps/server/src/db/schema.ts: adds `price_parts_job_stage` enum, the `part_price_cache` table
  (with its unique index on category+brand+part number), the `price_parts_jobs` queue table, and
  `expected_parts.price_source`.
- apps/server/src/db/types.ts, packages/shared/src/listings.ts: add the `PartPriceCacheEntry`/
  `PricePartsJob` types and the three-state `priceSource: 'auto' | 'manual' | null` field on
  `ExpectedPart`/`ExpectedPartInput`.
- apps/server/src/db/migrate.ts: carries `price_source` through the pre-existing one-time
  `expected_parts` rebuild so it isn't silently dropped on a fresh database.
- apps/server/test/db.test.ts: `EXPECTED_COLUMNS` fixture updated to match the real schema (a
  cycle-0 gap, fixed in T10).

## Cache-hit/miss trigger and price_source ownership

Summary: The actual decision logic — given a freshly-saved batch of Expected Parts, which combos
get an instant cached price, which get a new background job, and which parts are left alone
because a user already owns their price. This is the feature's most cross-cutting and most
revised piece: its first version had a real concurrent-duplicate-job race and a real
Req 14/15 violation that together drove both of this feature's fix cycles.
Tasks: T4, T12, T13
Flow:
- Expected Part saved: brand + part number both present, no existing value
- Cache lookup: hit with value, hit still null, or miss
- Cache hit (priced): write value straight onto every matching `'auto'` row
- Cache miss: insert cache row, atomically enqueue a `price_parts_job` unless one is already queued
- Price worker (T5): researches the combo, updates the cache
- Propagate: cached value pushed to every Expected Part sharing the combo WHERE `price_source = 'auto'`
Files:
- apps/server/src/jobs/pricePartsTrigger.ts: the trigger itself — `triggerPriceLookups` de-dupes
  combos per batch, then runs each through cache-lookup / insert-if-miss / atomic enqueue.
- apps/server/src/db/queries/partPriceCache.ts: the cache table's CRUD, including the
  null-never-overwrites-a-price update rule (Req 11/12) and the propagation UPDATE that is
  restricted to `price_source = 'auto'` rows.
- apps/server/src/db/queries/pricePartsJobs.ts: the job queue's CRUD, including
  `createQueuedPriceJobIfAbsent` — T12's fix, an atomic `INSERT ... WHERE NOT EXISTS` that replaced
  a non-atomic check-then-insert pair which let two genuinely concurrent first-encounters of one
  combo both enqueue (the race T4's own review and tests first proved).
- apps/server/src/routes/listings.ts: `createExpectedPartsForListing` decides each incoming row's
  `priceSource` on the way in — only an undecided row with no price of its own gets claimed
  `'auto'`; an incoming `'auto'`/`'manual'` claim is always stored verbatim, which is what stops a
  user-cleared row from being silently re-claimed on the next save.
- apps/web/src/features/listings/expected-parts-editor.tsx: `updateRow` is the matching client-side
  half of that same rule — T13's retried fix makes it claim `'manual'` the moment the price field
  itself is touched (typed *or* cleared), not only when an already-`'auto'` row is edited, closing
  the second null-conflation branch T13's first pass had missed.
- apps/server/src/db/queries/expectedParts.ts, apps/server/src/routes/listingValidation.ts: thread
  `priceSource` through `CreateExpectedPartInput`/validation the same way `aiConfidence`/`aiSource`
  already are.
- apps/web/src/features/listings/listing-form-state.ts, apps/web/src/features/listings/listing-form.tsx:
  the two client round-trip points — reading `priceSource` back onto a reopened draft row, and
  sending it verbatim on save — that had to move in lockstep with the three-state model or the fix
  wouldn't reach the wire.

## AI price research

Summary: The actual research call — the prompt that asks for one honest, used-condition price
estimate, and the parser that trusts nothing but a clean confident answer.
Tasks: T2, T5
Flow:
- Price worker claims a queued job
- Prompt built for the job's (category, brand, part number)
- omp sourcing runner (tools enabled, no photo) researches real market activity
- Parser: confident numeric answer -> price; anything else -> null, never guessed
- Cache updated either way; job always completes (a null is a successful "no confident price", not a failure)
Files:
- apps/server/src/ai/priceEstimationPrompt.ts: builds the research prompt, reusing
  `getOmpSourcingRunner()`; explicit "say so, don't guess" instruction (rule 4) for the no-answer
  case.
- apps/server/src/ai/priceEstimationParser.ts: `parsePriceEstimationResponse` — only a structurally
  valid `{"confident":true,"priceUsd":<number>}` produces a value; a refusal, a range, or unparseable
  prose all fall through to null.
- apps/server/src/jobs/pricePartsWorkerPool.ts: the worker pool itself — claim/pump/process, mirrors
  `identifyPartsWorkerPool.ts`'s shape, including orphaned-job recovery
  (`resetOrphanedPriceJobsToQueued`) on startup.

## Daily refresh and server wiring

Summary: The once-a-day sweep that re-researches every cached combo regardless of whether it
currently has a price, plus the bootstrap/shutdown wiring that keeps both new background services
running alongside the feature's existing identify-parts counterparts.
Tasks: T6, T7, T14
Files:
- apps/server/src/jobs/priceRefreshScheduler.ts: `runScheduledPriceRefresh`, cron'd for 3am (one
  hour after the existing 2am scan job). T14 added per-entry try/catch isolation (mirroring
  `scanService.ts`'s `scanAllEligibleSources`) so one transient failure no longer silently skips
  every remaining cache entry for the night.
- apps/server/src/index.ts: starts and gracefully stops both `startPricePartsWorkerPool()` and
  `startPriceRefreshScheduler()` alongside the existing identify-parts pool and scan scheduler.

## Identify Parts status banner through pricing

Summary: After the identify-parts job itself finishes, the status banner keeps reporting progress
until every part it triggered pricing for has resolved — a second, independent poll loop layered
onto the existing job-stage poll. A plain manual Listing save never shows any pricing status at
all.
Tasks: T9, T15
Flow:
- Identify-parts job completes, parts persisted (some marked `priceSource: 'auto'`, unpriced)
- "Pricing N part(s)…" banner shown, 2s poll loop starts
- Each tick: re-fetch Listing, push new values to parent, recompute remaining unpriced count
- Stops when count reaches zero, or after 60 polls (2 minutes) — whichever first, silently
Files:
- apps/web/src/features/listings/identify-parts-button.tsx: `applyTerminalJob` detects any
  still-unpriced `'auto'` part and starts `startPricingPolling`; T15 corrected a stale doc-comment
  claiming the wrong measured cyclomatic complexity for this now-larger component.
- apps/web/test/identify-parts.test.tsx: new tests covering the poll's start/stop/timeout/relay-to-parent
  behavior, and the no-status case for a plain manual save (Req 17).

## Fixture and test-hardening fixes

Summary: Cycle 1's two smaller, narrowly-scoped fixes — a stale schema-test fixture and a test
assertion that couldn't actually catch the regression it was named for.
Tasks: T10, T11
Files:
- apps/server/test/db.test.ts: `EXPECTED_COLUMNS` fixture updated for the two new tables and
  `price_source` (test-only; no production code changed).
- apps/server/test/priceEstimation.test.ts: Req-11 guard assertion rewritten to target rule 4's own
  unique no-guess sentence instead of two substrings ('confident'/'guess') that already appear
  elsewhere in the prompt for unrelated reasons.
