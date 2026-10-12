# Feature: lightbox-click-outside-close

Status: done
Cycle: 1 / 3
FeatureStarted: 2026-10-12T18:00:00Z
FeatureCompletedAt: 2026-10-12T23:15:00Z
OrchestrationTokensActual: 989162
OrchestrationTokensBreakdown: input 0 + output 21,575 + cache-write 444,783 + cache-read 522,804, across 116 turns
Walkthrough: https://gist.githack.com/adamcrevel/444cba936324bd32811d009bdb88186f/raw/walkthrough.html
Prototype: https://gist.githack.com/adamcrevel/7916dd1ca70c6abcef0452df61d57434/raw/prototype.html
BaselineTests: 962
BaselineSuite: pass

## Goal

The full-screen photo viewer a Listing's photo thumbnails open
(`apps/web/src/features/listings/photo-lightbox.tsx`) only closes via its own X button today —
clicking the empty space around the photo does nothing, even though the component's own doc
comment says it is "built on the shared Dialog primitive (Radix), which already owns ... click-
outside-to-close." Root cause, confirmed by reading the component: `DialogContent`'s own
`className` sets `h-screen w-screen` with `flex items-center justify-center`, so its DOM bounding
box covers the entire viewport — there is no pixel on screen actually "outside" `DialogContent` for
Radix's own outside-click detection to ever fire against. The empty-looking space around the
centered photo is visually background, but structurally still inside `DialogContent`.

This fixes that: clicking anywhere in that empty space (not the photo, not the Close/Previous/Next
buttons) closes the lightbox, the way a user expects a click on an image lightbox's backdrop to
behave.

## Requirements

1. Clicking anywhere in the lightbox's visible area that is not the photo itself and not one of its
   three buttons (Close, Previous, Next) closes the lightbox.
2. Clicking the photo itself does not close the lightbox — this is the one thing a user is actually
   looking at; an accidental click on it should not dismiss the view, matching the conventional
   lightbox pattern (click the image to inspect it, click away from it to leave).
3. Clicking Close continues to close the lightbox exactly as it does today (and does not fire the
   close logic twice).
4. Clicking Previous or Next continues to navigate to the adjacent photo exactly as today, and does
   not also close the lightbox — a navigation click must never be mistaken for a backdrop click.
5. Everything else about the lightbox is unchanged: Escape still closes it (unaffected, since this
   is Radix's own keyboard handling, untouched by this fix), Left/Right arrow-key navigation and
   wraparound are unchanged, the photo counter badge's own appearance/position is unchanged.

## Standing Checks

- The whole test suite passes, and the test count holds at or above `BaselineTests` (962: 24 shared
  + 248 web + 690 server). `BaselineSuite` is recorded `pass` for this baseline run, but
  `apps/server`'s `startTestServer`-based integration tests have shown confirmed,
  resource-contention-driven flakiness under concurrent load across multiple features this session
  (a different random file each time) — isolate-and-rerun before treating any single failure there
  as a regression, not an automatic fail. This feature touches only `apps/web`, so no server test
  should plausibly be affected regardless.
- `npm run lint` is clean.
- No change to `apps/server` or `packages/shared` — this is a pure `apps/web` UI fix, one component
  file plus its test file.

## Tasks

| id | description | role | depends_on | status | cycle | model | started_at | completed_at | expected_minutes | estimated_start | estimated_tokens | actual_tokens | ui | files_touched |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| P1 | Prototype the fix for T1: the photo lightbox opened from a Listing's photo thumbnails, modified so clicking the backdrop (empty space around the centered photo, not the photo itself, not the Close/Previous/Next buttons) closes the lightbox — the photo and the three buttons keep their current exact behavior unchanged. | prototype | | complete | 0 | peter-gibbons | 2026-10-12T18:05:00Z | 2026-10-12T18:10:00Z | 15 | 2026-10-12T18:05:00Z | 24300 | 49272 | yes | |
| T1 | In `apps/web/src/features/listings/photo-lightbox.tsx`: add `onClick={onClose}` to the `DialogContent` element (this is the backdrop region per Requirement 1). Add `onClick={(event) => event.stopPropagation()}` to the `<img>` element (Requirement 2 — a click landing on the photo must never bubble up to the new backdrop handler). Add `event.stopPropagation()` as the first line inside the Close button's existing `onClick` handler, and the same inside the Previous and Next buttons' existing `onClick` handlers (Requirements 3-4 — none of the three buttons' clicks may bubble to the new backdrop handler, which would otherwise double-fire close on the Close button or wrongly close instead of navigate on Previous/Next). Update `apps/web/test/photo-upload.test.tsx`'s `PhotoUpload lightbox navigation` describe block: add a new test asserting a click on the dialog's own root element (the backdrop, not the image or any button) closes the lightbox; add an assertion (new test or extend an existing one) that a click directly on the `<img>` does NOT close it; confirm the existing Next/Previous/Close tests still pass unmodified (proving Requirements 3-4 hold, not just Requirement 1). MUST_FIX (Cycle 0 retry, from R1): the new test 'clicking the dialog backdrop closes the lightbox, but clicking the photo itself does not' (apps/web/test/photo-upload.test.tsx) is intermittently flaky (~10% failure rate across 31 reruns, confirmed independently) at its final assertion — expect(document.body.querySelector('[role="dialog"]')).toBeNull() immediately after dispatching a click on the dialog root inside await act(async () => {...}). The dialog node is sometimes still present in the DOM right after the dispatch, consistent with a timing race flushing Radix's own portal/dismissal internals rather than a source bug — R1/TE1 both independently confirmed the source wiring in photo-lightbox.tsx is correct against all 5 Requirements, and TE1's mutation-proof confirms the test correctly fails when the fix is reverted, so the fix itself needs no change. Stabilize the test using this codebase's own existing waitFor(predicate, timeoutMs) polling-helper pattern (see bulk-identify-parts-ui.test.tsx and listings-page.test.tsx for the exact local-helper shape already used elsewhere in this test suite) instead of asserting synchronously right after the act() block — poll for document.body.querySelector('[role="dialog"]') === null with a short timeout rather than a bare one-shot check. After the fix, rerun the test file at least 20 times in a row (a quick shell loop is fine) and confirm zero failures, not just one clean run, given the failure rate observed was probabilistic. | builder | | complete | 0 | peter-gibbons | 2026-10-12T21:30:00Z | 2026-10-12T21:57:00Z | 30 | 2026-10-12T18:15:00Z | 8000 | 34757 | yes | apps/web/test/photo-upload.test.tsx |
| R1 | Review T1 against Requirements 1-5. Confirm the backdrop `onClick` is placed on `DialogContent` itself (the element whose bounding box is the thing Requirement 1 describes), not on some inner wrapper that would miss part of the empty space. Confirm every one of the three buttons' `stopPropagation()` calls actually run before (or regardless of) their own existing logic, not accidentally short-circuiting it. Confirm the image's `stopPropagation()` is on the image element itself, not a wrapper that would also catch clicks meant for the backdrop around it. Confirm the new/updated tests in `photo-upload.test.tsx` actually exercise a real backdrop click (dispatched on the dialog root, not the image or a button) and a real image click, not just re-asserting the same prior button-click tests under a new name. Confirm Escape-to-close and arrow-key navigation are untouched (`git diff` should show only the targeted additions, no restructuring of the keydown effect or the Dialog's `onOpenChange` wiring). FAIL: the new backdrop-click test in `photo-upload.test.tsx` is empirically flaky (~10%, 3/31 identical reruns failed at the `role="dialog"` null-check), so it does not reliably guard Requirement 1 even though the source wiring itself is correct against all five requirements. FAIL: on this retry, the flakiness fix itself is verified correct and stable (44/44 clean reruns), but Requirement 3's "does not fire the close logic twice" guard — the Close button's `event.stopPropagation()` in `photo-lightbox.tsx` — has zero test coverage; removing that one line would double-fire `onClose`, which is idempotent (`PhotoUpload` wires `onClose={() => setLightboxIndex(null)}`), so the DOM outcome is identical either way and no existing test, including the pre-existing Close-button test, would catch the regression — needs a dedicated unit test mounting `PhotoLightbox` directly with a spied `onClose` and asserting `toHaveBeenCalledTimes(1)`. | reviewer | T1 | complete | 0 | | 2026-10-12T21:40:04Z | 2026-10-12T22:21:18Z | 15 | 2026-10-12T21:40:04Z | 9000 | 202340 | no | |
| TE1 | Test T1. Run `apps/web`'s test suite and confirm the new/updated `photo-upload.test.tsx` cases pass: a backdrop click closes the lightbox; a click on the image itself does not; the existing Close/Previous/Next button tests still pass exactly as before (proving the added `stopPropagation()` calls didn't change their own behavior). Mutation-check at least one of these: temporarily removing the new backdrop `onClick` should make the new backdrop-click test fail; temporarily removing the image's `stopPropagation()` should make the new image-click test fail. Confirm no other `apps/web` test regressed. | tester | T1 | complete | 0 | | 2026-10-12T21:40:04Z | 2026-10-12T22:21:18Z | 15 | 2026-10-12T21:40:04Z | 12800 | 116358 | no | |
| T2 | Cycle 1 must_fix (from R1, see Cycle Log): Requirement 3's "Close does not fire the close logic twice" guard has zero test coverage — `PhotoUpload`'s `onClose={() => setLightboxIndex(null)}` is idempotent, so no existing test (including the pre-existing Close-button test) can tell a single call from a double call. Add a dedicated unit test mounting `PhotoLightbox` directly (not via `PhotoUpload`) with a `vi.fn()` spy passed as its `onClose` prop, open it at some index, click the Close button, and assert `expect(onClose).toHaveBeenCalledTimes(1)`. No change to `photo-lightbox.tsx` itself — its Close handler's `stopPropagation()` is already correct and already reviewed twice; this is a test-coverage-only addition. | builder | T1 | complete | 1 | | 2026-10-12T22:26:22Z | 2026-10-12T22:30:46Z | 10 | 2026-10-12T22:26:22Z | 16000 | 39843 | no | apps/web/test/photo-upload.test.tsx |
| R2 | Review T2. Confirm the new test actually mounts `PhotoLightbox` (not `PhotoUpload`) with a real `vi.fn()` spy as `onClose`, clicks the real Close button (not a direct function call bypassing the DOM), and asserts an exact call count of 1 — not `toHaveBeenCalled()` alone, which would pass even on a double-fire regression. Confirm this test would fail if `stopPropagation()` were removed from the Close handler (reason about it directly or run the mutation) — if it would not, the assertion isn't load-bearing and the gap isn't actually closed. | reviewer | T2 | complete | 1 | | 2026-10-12T22:34:29Z | 2026-10-12T22:47:56Z | 10 | 2026-10-12T22:34:29Z | 16000 | 51094 | no | |
| TE2 | Test T2. Run the new test and confirm it passes against the current (correct) source. Mutation-prove it: temporarily remove the Close button's `stopPropagation()` in `photo-lightbox.tsx`, confirm the new test fails with a call count of 2, then restore the file exactly (`git diff` clean afterward). Confirm no other test regressed. | tester | T2 | complete | 1 | | 2026-10-12T22:34:29Z | 2026-10-12T22:47:56Z | 10 | 2026-10-12T22:34:29Z | 9000 | 38576 | no | apps/web/src/features/listings/photo-lightbox.tsx (temp mutate+restore) |
| U0 | UAT pass over the whole feature (Requirements 1-5): start apps/web for real in the worktree (apps/server too, if needed for the page the lightbox lives on to render at all) on an isolated port, open a Listing's photo lightbox in a real browser, and confirm with real clicks/screenshots: clicking the photo keeps the lightbox open; clicking the backdrop (empty space, including over the counter badge) closes it; Close/Previous/Next each still do exactly their current thing with no double-close or wrong-navigation; Escape still closes it; Left/Right arrow keys still navigate and wrap at both ends. |uat| T1;T2 | complete | 1 | peter-gibbons | 2026-10-12T22:55:00Z | 2026-10-12T23:05:00Z | 20 | 2026-10-12T22:55:00Z | 15000 | 91931 | no | (none - seeded data via temp isolated DB, cleaned up after use) |

## Assumptions

- A1 (cycle 0): "Anywhere outside the image" is read literally per the user's own words — the photo
  itself stays click-to-keep-open (Requirement 2), only the surrounding backdrop space (including
  the area the photo counter badge sits over, which is not interactive) closes on click. The three
  control buttons are a given exception, since they already have their own specific, different
  behavior (Requirement 3-4) and the user's report never mentioned them misbehaving.
- A2 (cycle 0): No change to the shared `Dialog`/`DialogContent`/`DialogOverlay` primitives
  themselves (`apps/web/src/components/ui/dialog.tsx`) — `PhotoLightbox` is their only caller
  (confirmed by a repo-wide grep), so the fix is scoped to `PhotoLightbox`'s own JSX rather than
  changing a shared primitive's default behavior that could affect a future second caller in an
  unreviewed way.
- A3 (cycle 0): The new backdrop-close test and the new image-does-not-close test were combined
  into one `it` block inside the existing `PhotoUpload lightbox navigation` describe, since both
  exercise the same open/mount setup and the same single interaction being added. The dialog's own
  root element was located with `document.body.querySelector('[role="dialog"]')`, matching how this
  codebase's existing test helpers already identify Radix's `DialogContent`.

## Cycle Log

### Cycle 0
Trigger: initial
UAT: not_run
Retries: T1 (first failure this cycle, in-place retry) — R1 found the new backdrop-click test
  intermittently flaky (~10% across 31 reruns), a timing race in the test's own assertion timing,
  not a source bug (TE1 confirmed source wiring correct against all 5 Requirements). must_fix
  appended to T1's own description, T1/R1/TE1 reset to not_started, same cycle.
Retries: T1 retry #2 (same cycle, flakiness fix) — R1/TE1 reran against the waitFor-stabilized
  test. TE1: PASS — photo-upload.test.tsx 20/20 clean reruns (0 failures, vs. ~10% before),
  apps/web full suite 27/27 files, 249/249 tests, mutation check (removing DialogContent's
  onClick={onClose}) correctly kills the backdrop-click test, file restored clean. R1: FAIL —
  flakiness fix itself verified correct and stable (44/44 clean reruns across two independent
  batches), waitFor helper shape matches bulk-identify-parts-ui.test.tsx/listings-page.test.tsx,
  photo-lightbox.tsx untouched by this retry (test-file-only change) and Requirements 1,2,4,5
  reconfirmed correct — but found a new must_fix: Requirement 3's "does not fire the close logic
  twice" guard (Close button's `event.stopPropagation()`) has zero test coverage, since
  PhotoUpload's onClose is idempotent and the existing Close-button test can't distinguish a
  single from a double call. Needs a dedicated unit test mounting PhotoLightbox directly with a
  spied onClose asserting toHaveBeenCalledTimes(1). Standing gate (run by validate-lead): full
  suite — apps/web 249/249 and packages/shared 24/24 clean; apps/server showed 4 file-level
  failures on the combined run, all `startTestServer` beforeAll/afterAll hook timeouts, isolated
  rerun of apps/server alone came back 59/59 files, 690/690 tests clean — inherited
  resource-contention flakiness per the documented carve-out, not a regression (this feature
  touches only apps/web). Test count 963 (24+249+690) vs. BaselineTests 962 — up by exactly 1
  (T1's new test), no shrinkage. `npm run lint` clean. Overall verdict: FAIL, must_fix is the R1
  Requirement-3 coverage gap above; returned to build-lead to reopen T1.

### Cycle 1
Trigger: R1's second-pass review of T1 found a real test-coverage gap, not a source defect — T1
  had already used its one free in-place retry this cycle (for the flakiness fix), so this
  must_fix opens a new cycle rather than a third in-place attempt.
Findings:
- Requirement 3's "Close does not fire the close logic twice" guard has zero test coverage —
  `PhotoUpload`'s `onClose` is idempotent, so no existing test can tell a single call from a
  double call. Needs a dedicated unit test mounting `PhotoLightbox` directly with a spied `onClose`
  asserting `toHaveBeenCalledTimes(1)`.
UAT: passed
UAT checks:
- Real Chromium (Playwright) against apps/server+apps/web started for real in the worktree on isolated ports and an isolated DuckDB data dir, never the live database.
- Seeded a real Listing with 2 uploaded photos via the live API, confirmed both thumbnails present in the real UI.
- Clicking the photo itself (exact pixel center of its bounding box) keeps the lightbox open (Req 2).
- Clicking the backdrop at (50,50), far from the photo and all three buttons, closes the lightbox (Req 1).
- Clicking the photo counter badge itself (not a button, not the photo) also closes the lightbox, confirming it behaves as backdrop (Req 1).
- Clicking Next navigates from 1/2 to 2/2 without closing; clicking Previous navigates back without closing (Req 4).
- Clicking Close closes the lightbox (Req 3, close-behavior half).
- Req 3's no-double-fire half is unprovable via any live UI click sequence (PhotoUpload's onClose is idempotent) — confirmed instead via direct source inspection (stopPropagation precedes onClose in the Close handler) and by citing T2's dedicated vi.fn()-spy unit test and its mutation-proof.
- Pressing Escape closes an open lightbox (Req 5).
- ArrowRight/ArrowLeft navigate between photos, and wraparound (photo 1 going back wraps to the last photo) still works (Req 5).
- git diff confirms the photo counter badge's own JSX is untouched by this feature (Req 5, badge appearance/position unchanged).
- git diff --stat confirms exactly 2 files changed, both apps/web (photo-lightbox.tsx, photo-upload.test.tsx) — zero apps/server or packages/shared changes, matching the plan's own Standing Checks.
- Standing gate cited from feature-validate-lead's Cycle 1 pass: 964/964 tests matching BaselineTests (962) plus 2 new tests, no shrinkage; lint clean.
