# Retrospective

## What happened

- **Shape of the run.** `FeatureStarted` 2026-10-16T19:06:32Z → `FeatureCompletedAt`
  2026-10-17T02:47:14Z = **7h 40m wall clock** across 3 cycles, 45 task rows (12 cycle-0 builders +
  PT1, 2 fix tasks T13/T14, 28 review/test rows, 2 UAT rows). Summed `expected_minutes` = **883 min
  (14.7h)** against 7h 40m actual, i.e. parallel batching bought roughly 2x — but see the
  estimate-quality finding below, the two numbers are not comparable task-by-task because most rows
  carry a *batch* window rather than a per-task one.
- **Cycle 0 retry 1 was the single largest cost block in the feature: 8 of 12 builder tasks carried a
  must_fix** (T2, T3, T5, T7, T8, T9, T10, T12 — only T1, T4, T11 passed clean). Retried builders ran
  22:21:27→22:53:32 (~32 min across three waves), then an 18-row re-review/re-test batch ran
  22:56:35→23:16:55 (20 min). Recorded `estimated_tokens` for the retry-round review/test rows alone
  sum to **~347,000**; the eight retried builder rows add 152,800 more (those builder figures are
  whole-task, initial + retry). That retry round cost more than cycles 1 and 2 combined
  (~218,500 estimated tokens).
- **T2 (DuckDB enum migration) was the most expensive single task in the feature, and the plan
  caused it.** The task text literally prescribed `ALTER TYPE platform_type ADD VALUE 'mercari'`
  "swallowing only the already-contains error"; A9 records that DuckDB has **no `ALTER TYPE`
  statement at all** (confirmed against two independent binaries). The builder substituted a
  backup/drop/recreate/restore rebuild, which then crashed on any database that had ever run
  `migrateExpectedPartsNullablePrice` (`Catalog Error: Could not drop the table ... main key table of
  "expected_parts_new"`, cycle-0 Findings, critical — server startup, not just one scan), and the
  retry needed a whole new `rebuildCorruptedCatalog` EXPORT/DETACH/IMPORT round-trip (A30). Cost:
  T2 48,000 + R2 76,000 + TE2 42,800 ≈ **167,000 estimated tokens on a task sized at 15 minutes**.
  R2 is the most expensive reviewer row in the feature, and its entire "central scrutiny item" was
  re-verifying a planning-time factual error.
- **The ~200-line file cap produced 3 of the 8 cycle-0 must_fixes** (T5 at 244 lines, T8's two files
  at 242 and 281). The plan named a keep-under-cap split for T8 only; A18 shows T5's builder reading
  that omission as licence to ship 243 lines, and got must_fixed for it anyway. The retries then
  split five files (A32: 119+144; A35: 156/173/54/146/153) — pure rework, zero behaviour change.
- **The same test-premise breakage was found twice, half a cycle apart.** T11 found and fixed
  `'facebook_marketplace'`-as-"unregistered platform" stand-ins on the `apps/web` side itself (A28);
  the identical premise on `apps/server` (`ebayConnector.test.ts` line 528, `scan.test.ts` line 206)
  survived until feature-validate-lead's full-suite gate caught it as a real regression and filed it
  on T9 (A29, A37). One repo-wide grep for the literal string at plan time would have put both in the
  same task.
- **Cycle 1 existed for one untested line.** Trigger: T8's second failure — `facebookMarketplaceSession.ts:86`'s
  tightened host check was correct code with zero coverage (reverting it left the whole 612-line
  `facebookMarketplaceConnector.test.ts` green). Cost: T13 (12.5 min actual vs 15 expected,
  12,500 est tokens) + R13 (2 min) + TE13 (2.6 min) + U1 (20.4 min, 46,000) + two full standing-gate
  suite runs ≈ **73,500 estimated tokens and 55 min** for 30 tests. The tightening itself landed in
  T8's cycle-0 retry (A35) *without* its test — the retry shipped the fix and deferred the proof,
  which is precisely what opened the cycle.
- **Cycle 2 existed because the plan prescribed the bug.** T5's own task text instructed
  `page.evaluate(() => fetch('/v1/api?oper…'))`; cycle-1 UAT found live that Mercari's bearer/CSRF
  tokens are minted in page memory, so that hand-built fetch 401s inside a 200 body and the
  connector's `?? []` swallowed it as zero results (cycle-2 Findings, T14). Cost: T14 (8.9 min actual
  vs 30 expected, 48,000) + R14 (46,500) + TE14 (20,800) + U2 (40.8 min, 29,700) ≈ **145,000
  estimated tokens**, plus a **57-minute gap** between U1 completing (00:28:17) and T14 starting
  (01:25:21) spent diagnosing with the user. Note U1's own `feature-uat-tester` had characterised the
  zero results as a network/IP issue and "not a code defect"; the user's sharp factual question is
  what surfaced the real defect.
- **The silent-zero-results prohibition was asymmetric in the requirements.** Requirement 6 forbids a
  "silent zero-result scan that looks identical to nothing matched" for Facebook Marketplace only.
  Mercari had the identical failure mode via `?? []` and no requirement covering it — which is why it
  reached UAT instead of being caught in T5's own review.
- **Estimate quality: builder minutes ran systematically high, and the timestamps can't settle it.**
  T8 expected 60 min, its row window is 11 min (22:40:12→22:51:11); T6+T11 expected 60, window 13 min
  (20:59:24→21:12:41); T14 expected 30, actual 8.9. But T2/T3/T5/T7/T10 all carry the *identical*
  window 22:21:27→22:39:04, and all 16 retry review/test rows carry the identical
  22:56:35→23:16:55 — the batch window was copied onto every member row, so no per-task duration
  exists to learn from.
- **`actual_tokens` is unusable: 41 of 45 rows are `null`.** The 4 non-null values are two duplicated
  batch figures (62,070 on both T1 and T4; 175,696 on both T6 and T11) — double-counted by
  construction. A40 and A43 root-cause it: `measure-child-cost.py --tag` matched the *lead's own*
  top-level transcript (which echoes the dispatch prompt containing the tag) and returned the
  identical 250,761 for four distinct children across two cycles; the children's own
  `ValidateCycleN.<ID>.jsonl` files contain no `AGENT_TAG:` needle at all. The feature therefore has
  **no measured cost at all** — `OrchestrationTokensActual` is also `null`.
- **Validation outweighed building ~2.5:1 on recorded estimates.** Builders (incl. PT1) ≈ 346,900 est
  tokens; reviewers + testers ≈ 786,200; UAT 75,700. Outliers worth naming: TE11 at **150,000** (the
  single largest row, a `ui: yes` visual-evidence gate), R11 59,000, and R1 at **36,000 est tokens /
  12 expected minutes to confirm two interfaces and one union member** — more than T1 itself
  (5,700).
- **The worktree lost already-"complete" work twice, with no commits to recover from.**
  A19: T1's types were absent despite T1 being marked complete, and T2's + T8's edits had been written
  to the *main* checkout instead of the worktree (build-lead hand-copied them back). A38: T9's
  `registry.ts` registration was missing again when TE9 started; TE9 re-applied it. Confirmed from git:
  `git log origin/main..HEAD` on `feat/marketplace-sources` is **empty — zero commits — with 45 dirty
  paths**, so every recovery was a manual file copy. The immediately prior feature in this repo's
  history committed per task (`f872984 feat: shared sort types (T1)`,
  `80f6d47 feat: server-side sort (T2) + client sortable header UI (T3)`); this run committed nothing.
- **Record-keeping gap: T6 is missing from the cycle-0 ledger.** R6's row carries
  `FAIL: the outer navigation-failure catch path had zero test coverage (resolved in the same cycle —
  see TE6)`, and TE6 ran a separate later window (21:58:00→22:06:24) to close it — yet T6 appears in
  neither the cycle-0 `Findings` list nor the `Retries:` line, which accounts for only 11 of 12
  builder tasks ("T2, T3, T5, T7, T8, T9, T10, T12 retried… T1, T4, T11 passed clean").
- **Three idle orchestration windows total ~1h 45m**, more than cycle 1's and cycle 2's task time
  combined: `FeatureStarted` 19:06:32 → PT1 19:40:00 (33 min before the first task), U1 00:28:17 →
  T14 01:25:21 (57 min), TE14 01:51:54 → U2 02:06:27 (15 min). Separately, review/test dispatch was
  not needs-driven: R4/TE4 ran at 21:32 while R2/TE2/R5/R7/R8/R10/R12 waited for the 22:56 batch,
  even though their builders had returned earlier.

## Proposals

- **Verify DDL/engine capability against this repo's own installed binding during planning, before
  writing a literal statement into a task.** Add to the planner's checklist: any task prescribing DDL
  (`ALTER TYPE`, enum changes, constraint rewrites) must be preceded by a throwaway script run against
  `@duckdb/node-api` in `apps/server/node_modules` and the literal result pasted into the task row.
  Cost of not doing it here: ~167,000 estimated tokens and one critical startup-crash finding on a
  15-minute task.
- **State the ~200-line split in *every* row that creates a new source file, not just the one the
  planner happens to worry about**, and add to the builder's pre-return self-check: `wc -l` every file
  it created, split before returning if any exceeds 200. Three of eight cycle-0 must_fixes (T5, T8 ×2)
  were nothing but line count.
- **When widening a shared union or a registry, add a plan task that greps the whole repo for the
  literal old member string in tests** (here: `rg "'facebook_marketplace'" --glob '*test*'`) and
  repoints every "stand-in for unsupported" premise in one pass. A28 and A29/A37 were the same fix
  found twice, one of them only by the standing gate.
- **Make "a behaviour-tightening fix ships with its own mutation-killed test, in the same retry" a
  hard rule in `feature-build-lead`'s must_fix dispatch.** T8's retry tightened `parseFacebookUrl`'s
  host check and shipped no test; that single omission is the entire reason Cycle 1 exists.
- **For any browser-driven connector against an endpoint whose auth is minted by page JS, plan
  `page.waitForResponse` raced against `page.goto` as the default and never prescribe an injected
  `page.evaluate(() => fetch(...))`.** Record this in the connector expertise file so the next
  marketplace connector starts from T14's shape, not T5's.
- **Promote Requirement 6's prohibition to a standing check for all connectors: "no connector may
  return `[]` on an error path — every non-result must throw."** Mercari's `?? []` had no requirement
  covering it and so passed R5 legitimately; a standing check would have made it a review finding in
  cycle 0 instead of a cycle-2 fix.
- **Require a live positive-result smoke run inside the builder task for every new scan connector that
  can be exercised without credentials** — "returns ≥1 real candidate for a real query", not merely
  "the page loads without a Cloudflare challenge" (which is all T5's live confirmation actually
  proved). This is the one check that would have caught T14's bug at ~20:30 rather than ~01:25.
- **Record per-task `started_at`/`completed_at`, never the batch window copied onto each member row**,
  and halve default builder `expected_minutes` for this codebase (T8 60→11, T14 30→9, T6+T11 60→13
  observed). Without per-task windows there is no data to calibrate against next time.
- **Fix `measure-child-cost.py` to read the child's own transcript path directly
  (`<Lead>/<Lead>.<ChildID>.jsonl`) instead of searching for an `AGENT_TAG` needle** — A40 already
  diagnosed the exact failure (the needle matches the dispatching lead's transcript, which echoes the
  prompt). Until it is fixed, stop writing batch-level figures onto individual rows: T1/T4's 62,070 and
  T6/T11's 175,696 are each counted twice today.
- **Commit per builder batch on the feature branch** (this repo's own prior feature did:
  `f872984 feat: shared sort types (T1)`). Two file-loss incidents (A19, A38) were recovered by hand
  because `git log origin/main..HEAD` was empty; a per-batch commit makes the same recovery a
  `git checkout` and makes "was T9 ever actually applied?" answerable instead of arguable.
- **Scale the review/test pair to task size: give trivially-verifiable rows (pure type additions,
  registry entries, docs) one combined review+test row instead of two.** R1 spent 36,000 estimated
  tokens — 6x T1's own 5,700 — confirming two interfaces and one union member; R9+TE9 together
  (8,600) show what that class of task should cost.
- **Dispatch each builder's review/test rows as that builder returns, rather than holding them for a
  whole-batch gate.** R4/TE4 proved it works (21:32, right after T4), while seven other pairs idled
  until 22:56. Combined with closing the 57-minute post-UAT diagnosis gap by handing the UAT blocker
  straight to a builder with the live-repro instruction, this is the largest wall-clock win available:
  ~1h 45m of the 7h 40m was idle orchestration.

---
This report cost approximately 44,800 tokens (self-reported estimate — characters read plus characters
written, divided by four; a rough proxy, not a measurement) / not available (measured — a sub-agent
inherits its parent's session id, so only the caller that tagged this dispatch can measure it). Not
counted in the feature's own total — this analysis happened after the feature was already done.
