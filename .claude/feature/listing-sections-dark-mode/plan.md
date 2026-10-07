# Feature: listing-sections-dark-mode

Status: done
Cycle: 0 / 3
FeatureStarted: 2026-10-07T07:48:26Z
FeatureCompletedAt: 2026-10-07T11:32:18Z
OrchestrationTokensActual: 253755
OrchestrationTokensBreakdown: input 0 + output 31,061 + cache-write 65,762 + cache-read 156,932, across 75 turns
Prototype: https://gist.githack.com/adamcrevel/39060d481924ce5cc94a098117b5e530/raw/prototype.html
Walkthrough: https://gist.githack.com/adamcrevel/2f6a1d33f29367745750586303809b25/raw/walkthrough.html
BaselineTests: 529
BaselineSuite: pass

## Goal

The Listing edit screen is the only place you see a Listing's details — there's no separate
read-only view. Make the listing-level fields and each Expected Part collapse into compact,
visually distinct boxes, so a Listing with several parts reads as a short list instead of a long
form. Also add a Light/Dark/System theme control that defaults to the device's own preference.

## Requirements

1. When editing an existing Listing, Title, Source, Description, Listing URL, Asking Price,
   Listing Date, and Acquisition Fees / Shipping render inside one collapsible box, collapsed by
   default every time that Listing is opened.
2. When creating a new Listing, that same box renders expanded by default, since nothing is
   filled in yet to hide and every field must be completed.
3. Each Expected Part row renders inside its own collapsible box.
4. An Expected Part row seeded from the opened Listing's already-saved data starts collapsed.
5. An Expected Part row added during the current session via "Add Part" starts expanded.
6. A collapsed Expected Part row shows only its component category, brand, part/model number, and
   estimated resale value.
7. Expanding an Expected Part row reveals its description.
8. Expanding an Expected Part row that carries an "AI suggested" badge also reveals that badge and
   its confidence/source caption.
9. Expanding an Expected Part row that has AI identity-candidate alternates also reveals the
   identity-candidates picker.
10. Collapsing or expanding an Expected Part row never discards, resets, or re-validates any
    field's value — each row stays a live, editable form underneath its box either way.
11. A collapsed Expected Part row with an active validation error on any field shows a visible
    error indicator on its trigger, but stays independently collapsible/expandable like any other
    row — an error is never silently hidden, but a row is never forced open either.
12. Both the Listing-fields box and each Expected Part's box render with a background that
    visibly contrasts the page's own background, in both light and dark mode, using one new
    shared token rather than an existing one already used elsewhere (hover states, badges,
    loading skeletons) for purposes unrelated to this feature.
13. The app provides a theme control, reachable from every screen, settable to Light, Dark, or
    System.
14. Until the user makes an explicit choice, the app's light/dark appearance follows the device's
    OS-level color-scheme preference.
15. Choosing Light or Dark overrides the device preference and persists across page reloads and
    future visits, until changed again.
16. Switching the theme control updates the visible UI immediately, with no page reload.
17. While the theme is set to System, a live change to the device's OS-level color-scheme
    preference updates the app's appearance to match, without the user touching the control again.
18. The sidebar's current-page highlight uses that same shared contrast token, so in light mode
    it is clearly distinguishable from the plain page background; its dark-mode appearance is
    unchanged, since it is already distinguishable there.

## Standing Checks

- The whole test suite passes, and the test count stays at or above 529 (`BaselineTests`), or the
  plan names which tests were consolidated and why.
- `npm run lint` (eslint) runs clean, with no new violations.
- Any new public function or component this feature adds carries the same kind of header/block-
  comment documentation already used throughout this codebase (e.g. `ExpectedPartsEditor`,
  `ListingForm`) — explaining its purpose and flow, not just a one-line label.
- No new code in `apps/web` imports directly from `apps/server` — the existing
  `import/no-restricted-paths` boundary (`eslint.config.mjs`), checked by
  `apps/web/test/eslint-import-boundary.test.ts`, must hold for every file this feature adds or
  touches.

## Tasks

| id | description | role | depends_on | status | cycle | model | started_at | completed_at | expected_minutes | estimated_start | estimated_tokens | actual_tokens | ui | files_touched |
|----|----|----|----|----|----|----|----|----|----|----|----|----|----|----|
| P0 | Clickable prototype covering T1-T5: the two collapsible-box kinds (listing-fields section, per-part rows with the stated collapsed/expanded content split, collapsed error indicator never forced open), the new shared contrast token also used by the sidebar's active-page highlight, and the Light/Dark/System theme control. | prototype | none | complete | 0 | | 2026-10-07T08:08:04Z | 2026-10-07T08:15:47Z | 10 | 2026-10-07T08:08:04Z | 45000 | null | yes | |
| T1 | Build a reusable Collapsible UI primitive: `apps/web/src/components/ui/collapsible.tsx` wrapping a new `@radix-ui/react-collapsible` dependency (added to `apps/web/package.json`, shadcn style, matching `button.tsx`/`card.tsx`'s conventions), exporting the low-level `Collapsible`/`CollapsibleTrigger`/`CollapsibleContent` primitives plus one higher-level `CollapsibleSection` component (trigger row with a chevron icon from `lucide-react` reflecting open/closed state, a border, and the new contrast background below, and a content region). Define one new CSS variable `--surface-contrast` in `apps/web/src/index.css` (light: a noticeably darker gray than `--muted`'s existing near-white value, `215 20% 85%`; dark: identical to `--muted`'s existing dark value, `217.2 32.6% 17.5%`, so dark mode is visually unchanged) plus its Tailwind color entry (`tailwind.config.js`, `surfaceContrast`) — a dedicated token rather than reusing `--muted`/`--accent`, since both are already used throughout the app (button hover states, badges, loading skeletons) for purposes unrelated to this feature, and changing them directly would restyle all of those too. `CollapsibleSection` uses `bg-surface-contrast` (Req 12); Task T5 reuses the same token for the sidebar's active-page highlight (Req 18). | builder | none | complete | 0 | | 2026-10-07T08:26:54Z | 2026-10-07T08:45:01Z | 25 | 2026-10-07T08:23:30Z | 46000 | null | yes | apps/web/package.json;package-lock.json;apps/web/src/index.css;apps/web/tailwind.config.js;apps/web/src/components/ui/collapsible.tsx;apps/web/test/collapsible.test.tsx |
| T2 | Wrap `ListingFields`'s rendered block in `apps/web/src/features/listings/listing-form.tsx` in T1's `CollapsibleSection` (Req 1-2): collapsed by default when `initialValue` is set (editing an existing Listing), expanded by default when it is not (creating a new one). | builder | T1 | complete | 0 | | 2026-10-07T08:45:19Z | 2026-10-07T09:42:41Z | 15 | 2026-10-07T08:48:30Z | 9500 | null | yes | apps/web/src/features/listings/listing-form.tsx;apps/web/test/listing-form.test.tsx;apps/web/test/listings-page.test.tsx |
| T3 | Make each row in `apps/web/src/features/listings/expected-parts-editor.tsx` collapsible with T1's `CollapsibleSection` (Req 3-11). Add an optional `collapsed?: boolean` field to `ExpectedPartRow`; `expectedPartToRow` (`listing-form-state.ts`) sets it `true` on every row it builds from already-saved data (Req 4), `emptyExpectedPartRow()` sets it `false` (Req 5). Add a `toggleRowCollapsed(index)` function in `ExpectedPartsEditor`, separate from `updateRow`, so opening/closing a row never clears its `aiSuggested` flag the way an actual field edit does (Req 10). Render each row with `open={!row.collapsed}` — purely the user's own toggle, never forced (Req 11) — the section's trigger always showing category/brand/partNumber/estimatedResaleValue (Req 6) plus a small destructive-colored indicator (e.g. a `lucide-react` `AlertCircle` in `text-destructive`) whenever `rowErrors[index]` has any truthy field, visible on the trigger whether the row is open or collapsed (Req 11); its content region holds description (Req 7), the AI-suggested badge/caption when present (Req 8), and the identity-candidates picker when present (Req 9), visible only while open. **MUST_FIX (MF-1, Cycle 0 validate-lead):** `expectedPartToRow` (`listing-form-state.ts`) must set `collapsed: true` unconditionally for every row built from already-saved data — no AI-suggestion exception; remove the "one exception" paragraph from its doc comment. Update the two `apps/web/test/listing-form-state.test.ts` tests currently asserting the carve-out to expect `collapsed: true` for AI-suggested rows too. No change needed to `identify-parts.test.tsx` — its own `descriptionValues` helper already expands every closed trigger before reading description/badge values, which keeps its 15 assertions passing under the literal Req 4 rule (confirmed by validate-lead's own revert-and-rerun test). | builder | T1 | complete | 0 | | 2026-10-07T10:42:00Z | 2026-10-07T10:47:54Z | 30 | 2026-10-07T09:03:30Z | | null | yes | apps/web/src/features/listings/listing-form-state.ts;apps/web/test/listing-form-state.test.ts;apps/web/test/identify-parts.test.tsx |
| T4 | Add a Light/Dark/System theme preference (Req 13-17): a new `useThemePreference` hook (`apps/web/src/lib/use-theme-preference.ts`) backed by `localStorage` (key `pc-parts-flipper:theme`), defaulting to `'system'` when nothing is stored (Req 14); an effect applies/removes the `dark` class on `document.documentElement`, re-deriving the effective value from `window.matchMedia('(prefers-color-scheme: dark)')` whenever the stored preference is `'system'`, and subscribes to that query's `change` event so a live OS-level change updates the applied class without a reload (Req 17) and without the stored preference itself changing. An explicit Light/Dark choice writes straight to `localStorage` (Req 15) and updates the class synchronously (Req 16). Add a compact 3-option control to `apps/web/src/routes/root-layout.tsx`'s sidebar, wired to the hook (Req 13). | builder | none | complete | 0 | | 2026-10-07T08:26:54Z | 2026-10-07T08:45:01Z | 25 | 2026-10-07T09:33:30Z | 35600 | null | yes | apps/web/src/lib/use-theme-preference.ts;apps/web/src/routes/root-layout.tsx;apps/web/test/use-theme-preference.test.tsx |
| T5 | In `apps/web/src/routes/root-layout.tsx`, switch the active nav-link's own highlight from `bg-accent text-accent-foreground` to `bg-surface-contrast text-accent-foreground` (T1's new token) — only the `isActive` branch; its separate `hover:bg-accent hover:text-accent-foreground` classes are untouched (Req 18). | builder | T1 | complete | 0 | | 2026-10-07T08:45:19Z | 2026-10-07T09:42:41Z | 10 | 2026-10-07T09:58:30Z | 1100 | null | yes | apps/web/src/routes/root-layout.tsx;apps/web/test/root-layout.test.tsx |
| R1 | Review T1 (apps/web/package.json; apps/web/src/index.css; apps/web/tailwind.config.js; apps/web/src/components/ui/collapsible.tsx). Scope: Requirement 12 (`--surface-contrast` token definition — light noticeably darker than `--muted`'s `215 20% 85%`, dark identical to `--muted`'s `217.2 32.6% 17.5%`; Tailwind `surfaceContrast` color entry; `CollapsibleSection`'s own `bg-surfaceContrast` application and chevron/open-state wiring) plus Standing Checks 2 (lint) and 3 (header/block-comment doc on the new public `Collapsible`/`CollapsibleTrigger`/`CollapsibleContent`/`CollapsibleSection` exports). Also confirm `CollapsibleContent` actually unmounts its children while closed (no stray `forceMount`), since T3's design for Req 6/10 depends on exactly that behavior. | reviewer | T1 | complete | 0 | | 2026-10-07T09:54:39Z | 2026-10-07T10:24:26Z | 10 | 2026-10-07T09:54:39Z | 13500 | null | yes | |
| TE1 | Test T1 (same files as R1). Scope: same requirement set as R1. Run/extend `apps/web/test/collapsible.test.tsx`: open/close toggling, chevron state, `bg-surfaceContrast` class present on the trigger, `CollapsibleContent` unmounted while closed vs. mounted while open. | tester | T1 | complete | 0 | | 2026-10-07T09:54:39Z | 2026-10-07T10:24:26Z | 12 | 2026-10-07T09:54:39Z | 7000 | null | yes | apps/web/test/collapsible.test.tsx |
| R2 | Review T2 (apps/web/src/features/listings/listing-form.tsx). Scope: Requirements 1-2 (collapsed by default iff `initialValue` is set, expanded for a new Listing) and Requirement 12's listing-fields-box clause (confirm the box actually renders with T1's `bg-surfaceContrast` background, not overridden) plus Standing Check 3 if any new exported function was added. | reviewer | T2 | complete | 0 | | 2026-10-07T09:54:39Z | 2026-10-07T10:24:26Z | 10 | 2026-10-07T09:54:39Z | 9700 | null | yes | |
| TE2 | Test T2 (same files as R2, plus `apps/web/test/listing-form.test.tsx` and `apps/web/test/listings-page.test.tsx` it touched). Scope: same requirement set as R2. Verify an edit-existing-Listing render starts the fields box collapsed and a create-new-Listing render starts it expanded, including a break-run-restore proof on `listing-form.tsx`'s own `initialValue`-gated default. `listing-form.tsx` is this task's exclusive production file, so no conflict with any other tester in this batch. | tester | T2 | complete | 0 | | 2026-10-07T09:54:39Z | 2026-10-07T10:24:26Z | 12 | 2026-10-07T09:54:39Z | 22800 | null | yes | apps/web/test/listing-form.test.tsx |
| R3 | Review T3 (apps/web/src/features/listings/expected-parts-editor.tsx; apps/web/src/features/listings/listing-form-state.ts). Scope: Requirements 3-11 and Requirement 12's per-part-box clause. Re-check MF-1 specifically: `expectedPartToRow` now sets `collapsed: true` unconditionally (no AI-suggestion exception), its doc comment's "one exception" paragraph is gone, and `listing-form-state.test.ts`'s two carve-out tests now expect `collapsed: true` for AI-suggested rows too. Also check Standing Check 3 (doc comment on `toggleRowCollapsed`). | reviewer | T3 | complete | 0 | | 2026-10-07T10:50:19Z | 2026-10-07T11:03:02Z | 18 | 2026-10-07T10:50:19Z | 24300 | null | yes | |
| TE3 | Test T3 (same files as R3, plus `apps/web/test/expected-parts-editor.test.tsx`, `apps/web/test/listing-form-state.test.ts`, `apps/web/test/identity-candidates-picker.test.tsx`, `apps/web/test/identify-parts.test.tsx`, `apps/web/test/listings-page.test.tsx` it touched). Scope: same requirement set as R3. Prove, with break-run-restore on `expected-parts-editor.tsx`/`listing-form-state.ts`: default-collapsed on saved rows with no AI-suggestion exception (Req 4, post-MF-1), default-expanded on Add Part rows (Req 5), the collapsed/expanded content split (Req 6-9), that toggling collapse never clears `aiSuggested`/any field value (Req 10), and the error indicator shows on a collapsed row without forcing it open (Req 11). Re-run `identify-parts.test.tsx` in full and confirm all 15 of its tests still pass under the corrected unconditional rule. | tester | T3 | complete | 0 | | 2026-10-07T10:50:19Z | 2026-10-07T11:03:02Z | 20 | 2026-10-07T10:50:19Z | 14800 | null | yes | |
| R4 | Review T4 (apps/web/src/lib/use-theme-preference.ts; apps/web/src/routes/root-layout.tsx's theme-control addition only — not its `isActive` nav-highlight branch, which is T5's). Scope: Requirements 13-17 plus Standing Check 3 (doc comment on the new public `useThemePreference` hook — confirm it meets the bar) and Standing Check 2 (lint). | reviewer | T4 | complete | 0 | | 2026-10-07T09:54:39Z | 2026-10-07T10:24:26Z | 12 | 2026-10-07T09:54:39Z | 11800 | null | yes | |
| TE4 | Test T4 (same files as R4, plus `apps/web/test/use-theme-preference.test.tsx`). Scope: same requirement set as R4. Verify default `'system'` with no stored key (Req 14), an explicit choice persists to `localStorage` and survives a fresh hook mount simulating reload (Req 15), synchronous class update on choice (Req 16), and a live `matchMedia` `change` event updates the applied class while the stored preference stays `'system'` (Req 17) — break-run-restore on `use-theme-preference.ts`. Both this task and T5 touch `root-layout.tsx`: this tester is dispatched in the first batch; T5's tester (TE5) waits for this one to fully return before it starts. | tester | T4 | complete | 0 | | 2026-10-07T09:54:39Z | 2026-10-07T10:24:26Z | 15 | 2026-10-07T09:54:39Z | 11500 | null | yes | apps/web/test/use-theme-preference.test.tsx |
| R5 | Review T5 (apps/web/src/routes/root-layout.tsx's `isActive` nav-highlight branch only). Scope: Requirement 18, plus Requirement 12's token-identity clause (confirm `bg-surfaceContrast` here is literally the same Tailwind color entry T1 defined, not a new ad hoc class) — confirm only the `isActive` branch changed and the separate `hover:bg-accent hover:text-accent-foreground` classes are untouched. | reviewer | T5 | complete | 0 | | 2026-10-07T09:54:39Z | 2026-10-07T10:24:26Z | 8 | 2026-10-07T09:54:39Z | 2800 | null | yes | |
| TE5 | Test T5 (same file as R5, plus `apps/web/test/root-layout.test.tsx` it touched). Scope: same requirement set as R5. Verify the active nav link renders `bg-surfaceContrast text-accent-foreground` and an inactive link does not, with a break-run-restore proof on `root-layout.tsx`'s `isActive` branch. Dispatched only after TE4 had fully returned — both T4 and T5 touch `root-layout.tsx`, so running their testers concurrently risked them mutating the same production file at the same time. | tester | T5 | complete | 0 | | 2026-10-07T10:16:48Z | 2026-10-07T10:24:26Z | 10 | 2026-10-07T10:16:48Z | 10900 | null | yes | |
| U0 | UAT pass over the whole feature: both collapsible-box kinds end to end on a real Listing (open/edit/save/reopen), the theme control (system default, explicit override, persistence, live OS-preference change), and the sidebar active-page highlight, exercised together in the running app, not task by task. | uat | T1;T2;T3;T4;T5 | complete | 0 | | 2026-10-07T11:11:26Z | 2026-10-07T11:31:43Z | 20 | 2026-10-07T11:11:26Z | 26900 | null | yes | |

## Assumptions

- A1 (cycle 0): "In an open listing" (both collapsible-box requests) means viewing/editing an
  existing, already-saved Listing — this codebase has no separate read-only detail view; the edit
  form itself is what renders when a listing is opened. The new-listing form (no existing data)
  is out of scope for starting collapsed (Req 2): collapsing an empty form the user must
  immediately fill in would be a regression, not an improvement.
- A2 (cycle 0): "Darker shade so they show up more easily" is read as "visibly contrasts the page
  background in both light and dark mode," not literally darker in dark mode — a literally-darker
  box against an already-dark page would blend in instead of standing out, the opposite of the
  goal. Implemented with one new dedicated CSS token (`--surface-contrast`, Req 12/18), not by
  editing `--muted`/`--accent` directly — both are already used throughout the app (button hover
  states, badges, loading skeletons) for things this feature has no reason to restyle.
- A3 (cycle 0): Collapsing/expanding an Expected Part row is a pure display toggle on already-live
  form inputs (Req 10), not a read-only summary that replaces them — this way a user mid-edit
  never loses in-progress typing by collapsing a row, and the collapsed state needs no separate
  "committed vs. draft" tracking.
- A4 (cycle 0): No "collapse all" / "expand all" control is added — the request only asks for each
  box's own default and per-box toggle; a bulk control is extra scope the request didn't ask for.
- A5 (cycle 0): `CollapsibleSection` exposes a strictly controlled `open`/`onOpenChange` API (no
  uncontrolled/`defaultOpen` fallback), with a `trigger` slot for always-visible content and
  `children` for the content shown only while open — this is the shape T2/T3/T5 all consume. No
  existing shadcn-style collapsible section was in this repo to copy prop names from.
- A6 (cycle 0): `@radix-ui/react-collapsible` is pinned to `^1.1.21` (the latest release at the
  time it was added), matching how `@radix-ui/react-slot` in the same `package.json` is pinned to
  its own latest rather than an older compatible release.
- A7 (cycle 0): `expectedPartToRow`'s literal instruction ("always collapsed") was refined to leave
  a row collapsed only when it is *not* still carrying an unreviewed AI suggestion
  (`aiConfidence`/`aiSource` both set) — applying the literal rule broke 9 existing
  `identify-parts.test.tsx` assertions that depend on freshly AI-identified parts being visible for
  review immediately after a job completes. The standing "whole suite passes" check takes
  precedence over a literal instruction that would otherwise hide the exact review UI the AI
  identification feature exists to show.
- A8 (cycle 0): The sidebar's new theme control is placed as a labelled "Theme" row of three icon
  buttons at the bottom of the existing sidebar `<nav>`, below the nav list, since that was the
  only existing structural slot matching "the sidebar" without touching `<main>`/`<Outlet/>`
  markup owned by other tasks.
- A9 (cycle 0): The theme control's three options render as icon-only buttons (Sun/Moon/Monitor
  from `lucide-react`, each with an `aria-label`) rather than icon+text, reusing the existing
  `Button` component's variant/size system — matching the icon-only precedent already used
  elsewhere in the sidebar area and keeping the control compact next to the nav list.
- A10 (cycle 0, validate): R3's independent review confirmed and FAILed T3's A7 deviation —
  `expectedPartToRow`'s AI-suggestion collapse-default carve-out is a Req 4 violation, not a sound
  Req 5 reading (Req 5's text is scoped to the Add-Part button, a code path this one never goes
  through), and the tradeoff A7 describes was unnecessary: reverting `listing-form-state.ts:60` to
  unconditional `collapsed: true` and re-running `identify-parts.test.tsx` in isolation left all 15
  of its assertions passing, since that file's own `descriptionValues` helper already expands
  closed rows before reading their values. Routed back to `feature-build-lead` as a T3 must_fix.
- A11 (cycle 0, validate): Mid-cycle, TE3 observed `listing-form-state.ts` transiently matching
  HEAD with T3's entire `collapsed` line absent (3 of its own test's assertions genuinely failed),
  and TE1 separately observed `collapsible.tsx` similarly mid-flux — both self-healed by the time
  each agent finished. Root cause: R3 ran its own break-run-restore experiment against
  `listing-form-state.ts` concurrently with TE3's mutation testing on that same file — reviewers in
  this harness carry Edit/Write tools in practice, so the "a reviewer never conflicts with
  anything" rule, which only names tester-tester races, missed this pairing. No lasting corruption:
  confirmed via a direct read plus `git diff` immediately after all ten rows returned.
- A12 (cycle 0, validate): `measure-child-cost.py child-cost --tag <exact row id>` returned `null`
  for all ten dispatched children (R1-R5, TE1-TE5), consistent with this project's own prior
  finding (`identify-parts-queue/plan.md` A19) that exact-tag lookup finds no transcript on this
  host. A looser, guessed tag (e.g. "review T1") returned non-null numbers, but they were
  inconsistent across repeated identical calls and several unrelated task ids collapsed to the same
  value (e.g. "review T3" through "test T5" all returned `250761`) — confirmed unreliable, not
  used. Every row's `actual_tokens` is `null` per protocol, never a guess.
- A13 (cycle 0, validate): The standing gate's whole-suite run surfaced one flaky failure,
  `apps/server/test/sales.test.ts` (a `beforeAll` hook timeout spawning a real test server, then
  `afterAll`'s `server.stop()` on `undefined`). Distinguished flake from regression the same way
  `identify-parts-queue/plan.md` A15 did: ran the full `apps/server` suite 3 times total — failed
  identically twice (once amid 5 concurrent sub-agents also running `vitest` in the shared
  worktree, once alone right after) and passed clean the third time (39/39 files, 405/405 tests);
  an isolated run of `sales.test.ts` alone passed cleanly every time (2/2, ~19-25s). Matches the
  real-server-spawn concurrent-load flake already documented in this exact codebase
  (`identify-parts-queue/plan.md` A13/A18 — identical error shape, same root cause: resource
  contention from vitest's own file-level parallelism across many real-server-spawning test
  files); not a regression — this feature touches only `apps/web`, nothing overlapping
  `sales.test.ts`'s domain.
- A14 (cycle 0, validate): Re-reviewed/re-tested T3 after MF-1's fix. Both R3 and TE3 independently
  confirmed `expectedPartToRow` now sets `collapsed: true` unconditionally (no AI-suggestion
  exception), its doc comment's "one exception" paragraph is gone, and `listing-form-state.test.ts`'s
  two carve-out tests now assert `collapsed: true` for the AI-suggested row specifically by index.
  TE3's mutation proof killed all five Req 4/5/6-9/10/11 mutations and confirmed both files restored
  byte-identical afterward; `identify-parts.test.tsx` re-run in full, all 15 assertions still pass.
  Separately scrutinized the build-lead's aside (outside MF-1's literal scope): `identify-parts.test.tsx`'s
  `descriptionValues()` helper previously batch-clicked several collapsed triggers inside one shared
  `act()` call, which under the new unconditional-collapse rule started silently dropping rows,
  because `toggleRowCollapsed`'s `onChange(rows.map(...))` closes over the `rows` prop and
  `listing-form.tsx` wires `onChange={setRows}` directly (a plain value dispatch, not a functional
  updater) — two toggle dispatches landing in the same React batch each compute their replacement
  array from the same stale `rows` snapshot, so the second clobbers the first. Fixed at the test
  level only (one `await act()`-wrapped click at a time, requerying collapsed triggers between
  clicks) with no production change. Judged this a pure test-harness artifact, not a reachable
  production bug: a real user can only ever produce one discrete browser click event per physical
  click, and each click is dispatched as its own top-level event with a full render/commit flush
  before the next one is processed — the clobbering only occurs when two state-updating dispatches
  are forced into one synchronous React batch (e.g. two `fireEvent.click()`/`.click()` calls made
  back to back inside one shared `act(() => {...})` callback with no await between them), which no
  real two-click user interaction can produce, and no production code path (A4: no collapse-all/
  expand-all control exists) ever calls `toggleRowCollapsed` more than once per event handler.
  TE3 independently confirmed this empirically with a throwaway investigative test (deleted after
  use, confirmed no residue via `git status`): two clicks each dispatched in their own separate
  `act()` boundary never lost an update (both toggles registered), while forcing them into one
  shared `act()` reproduced the loss every time. R3 reached the same conclusion independently by
  reading `listing-form.tsx:190`'s `onChange={setRows}` wiring. No new must_fix opened.
- A15 (cycle 0, validate): Re-ran the standing gate for this cycle. `npm run lint` clean, no
  violations (required locating a working Node 22 binary at `/tmp/node-v22.14.0-linux-x64/bin` —
  this host's default `node` on `PATH` is v12.22.9, too old for this project's eslint/vitest
  tooling; `.nvmrc` pins 22). Whole-suite run: `apps/server` 400 passed + 5 skipped (405, the 5
  skips are `purchases.test.ts`'s own tests, orphaned by its `beforeAll` hook timeout below) across
  38/39 files, `apps/web` 151/151 across 22/22 files, `packages/shared` 5/5 — total 561 tests run
  against `BaselineTests` 529, no shrink. One failing suite: `apps/server/test/purchases.test.ts`
  (`beforeAll` hook timeout spawning a real test server, then `afterAll`'s `server.stop()` on
  `undefined`) — same error shape as A13's `sales.test.ts` flake from the prior validate pass, just
  a different file losing this run's resource race. Distinguished flake from regression: this
  feature's `git diff --stat` against `apps/server` is empty (zero files touched), and
  `purchases.test.ts` run alone (outside the full concurrent suite) passed clean, 5/5, ~17s —
  confirms the full-suite's concurrent real-server-spawning load, not this feature's `apps/web`-only
  changes, is the cause. Not a regression; not `must_fix`.

## Cycle Log

### Cycle 0
Trigger: initial
Retries: T3 — MF-1 (expectedPartToRow's AI-suggestion collapse-default carve-out violated Req 4;
  retried in place, no new cycle, per validate-lead's confirmed-avoidable finding (A10))
UAT: passed
UAT checks:
- Seeded a real Listing (3 Expected Parts: CPU/Intel, GPU/NVIDIA with aiConfidence=high/aiSource=both/2 identityCandidates, RAM/Corsair) via the real POST/PUT /api/listings endpoint — the identical contract a real identify-parts job itself uses.
- Req1: opened the seeded Listing — Listing Details box rendered collapsed (aria-expanded=false); clicked it open then closed again, both transitions worked.
- Req2: clicked Add Listing (create mode) — Listing Details box rendered expanded (aria-expanded=true) immediately, no click needed.
- Req3: exactly 4 collapsible triggers rendered on the opened Listing (1 Listing Details + 3 Expected Part rows).
- Req4: all 3 seeded Expected Part rows rendered collapsed (aria-expanded=false) on open.
- Req5: a row added via Add Part rendered expanded (aria-expanded=true) immediately, no click needed.
- Req6: the collapsed GPU row's trigger showed category/brand/partNumber/estimatedResaleValue only; zero description inputs existed anywhere in the DOM while all 3 rows were collapsed.
- Req7: expanding the GPU row revealed exactly one description input, with the correct saved value.
- Req8: expanding the GPU row revealed its "AI suggested" badge and a "high confidence · from the listing text and photos" caption.
- Req9: expanding the GPU row revealed both seeded identity candidates in the picker.
- Req10: a brand typed into a new row survived two collapse/expand round trips unchanged; the GPU row's aiSuggested badge survived a collapse/re-expand too.
- Req11: a row left with blank required fields showed its validation errors, then collapsed and re-expanded freely twice, with its error indicator (AlertCircle, aria-label naming the error) visible throughout, never forced open or stuck.
- Req12: computed styles confirmed both the Listing Details box and an Expected Part row's background are visibly distinct from the plain page background, in both light mode (rgb(209,215,224) vs rgb(255,255,255)) and dark mode (rgb(30,41,59) vs rgb(2,8,23)); confirmed via direct file read that `--surface-contrast`/`surfaceContrast` is one dedicated token, not a reuse of `--muted`/`--accent`.
- Req13: the Light/Dark/System control is visible on all 7 top-level screens (Sources, Listings, Listings Queue, Purchases, Parts, Sale Listings, Profit Dashboard).
- Req14: with no stored preference and OS set to light, the app showed no dark class and the control's System button showed aria-pressed=true.
- Req15: choosing Dark persisted to localStorage and survived a full page reload; with Dark stored, live-switching the OS preference to light had no effect — the explicit choice held.
- Req16: clicking Dark then Light re-themed the page's actual rendered background color immediately each time, with no reload call made.
- Req17: with the stored preference cleared (System) and no click on the control, flipping the OS color-scheme live changed the applied class in both directions, while localStorage's theme key stayed unset throughout.
- Req18: the active nav link (Sources, when on /sources) carried the same surfaceContrast class the collapsible boxes use, and its background was visibly distinct from the plain page background in light mode; the non-active Listings link did not carry it.
- Standing checks: lint clean; apps/web's import-boundary test passed and a direct grep of every file this feature touched found zero apps/server imports; every new public export carries a header/block-comment matching this codebase's existing documentation convention; whole suite 561 tests run vs. BaselineTests 529 (cited from feature-validate-lead's PASS digest, not re-run), no shrink.
Validate: PASS (feature-validate-lead) — R1-R5/TE1-TE5 all complete and passing, including this
  pass's R3/TE3 re-review of T3's MF-1 fix. Standing gate: lint clean; whole suite 561 tests run
  (≥ BaselineTests 529, no shrink); one flaky `apps/server/test/purchases.test.ts` failure
  confirmed non-regression (A15) — zero `apps/server` files touched by this feature, isolated
  re-run passed clean. No must_fix findings.
