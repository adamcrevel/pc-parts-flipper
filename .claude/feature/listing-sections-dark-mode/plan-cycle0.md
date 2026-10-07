# Feature: listing-sections-dark-mode

Status: proposed
Cycle: 0 / 3
FeatureStarted: 2026-10-07T07:48:26Z
OrchestrationTokensActual: 107868
OrchestrationTokensBreakdown: input 0 + output 19,532 + cache-write 25,413 + cache-read 62,923, across 33 turns
Prototype: https://gist.githack.com/adamcrevel/39060d481924ce5cc94a098117b5e530/raw/prototype.html
Walkthrough: none
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
| T1 | Build a reusable Collapsible UI primitive: `apps/web/src/components/ui/collapsible.tsx` wrapping a new `@radix-ui/react-collapsible` dependency (added to `apps/web/package.json`, shadcn style, matching `button.tsx`/`card.tsx`'s conventions), exporting the low-level `Collapsible`/`CollapsibleTrigger`/`CollapsibleContent` primitives plus one higher-level `CollapsibleSection` component (trigger row with a chevron icon from `lucide-react` reflecting open/closed state, a border, and the new contrast background below, and a content region). Define one new CSS variable `--surface-contrast` in `apps/web/src/index.css` (light: a noticeably darker gray than `--muted`'s existing near-white value, `215 20% 85%`; dark: identical to `--muted`'s existing dark value, `217.2 32.6% 17.5%`, so dark mode is visually unchanged) plus its Tailwind color entry (`tailwind.config.js`, `surfaceContrast`) — a dedicated token rather than reusing `--muted`/`--accent`, since both are already used throughout the app (button hover states, badges, loading skeletons) for purposes unrelated to this feature, and changing them directly would restyle all of those too. `CollapsibleSection` uses `bg-surface-contrast` (Req 12); Task T5 reuses the same token for the sidebar's active-page highlight (Req 18). | builder | none | not_started | 0 | | | | | 25 | | | | yes | |
| T2 | Wrap `ListingFields`'s rendered block in `apps/web/src/features/listings/listing-form.tsx` in T1's `CollapsibleSection` (Req 1-2): collapsed by default when `initialValue` is set (editing an existing Listing), expanded by default when it is not (creating a new one). | builder | T1 | not_started | 0 | | | | | 15 | | | | yes | |
| T3 | Make each row in `apps/web/src/features/listings/expected-parts-editor.tsx` collapsible with T1's `CollapsibleSection` (Req 3-11). Add an optional `collapsed?: boolean` field to `ExpectedPartRow`; `expectedPartToRow` (`listing-form-state.ts`) sets it `true` on every row it builds from already-saved data (Req 4), `emptyExpectedPartRow()` sets it `false` (Req 5). Add a `toggleRowCollapsed(index)` function in `ExpectedPartsEditor`, separate from `updateRow`, so opening/closing a row never clears its `aiSuggested` flag the way an actual field edit does (Req 10). Render each row with `open={!row.collapsed}` — purely the user's own toggle, never forced (Req 11) — the section's trigger always showing category/brand/partNumber/estimatedResaleValue (Req 6) plus a small destructive-colored indicator (e.g. a `lucide-react` `AlertCircle` in `text-destructive`) whenever `rowErrors[index]` has any truthy field, visible on the trigger whether the row is open or collapsed (Req 11); its content region holds description (Req 7), the AI-suggested badge/caption when present (Req 8), and the identity-candidates picker when present (Req 9), visible only while open. | builder | T1 | not_started | 0 | | | | | 30 | | | | yes | |
| T4 | Add a Light/Dark/System theme preference (Req 13-17): a new `useThemePreference` hook (`apps/web/src/lib/use-theme-preference.ts`) backed by `localStorage` (key `pc-parts-flipper:theme`), defaulting to `'system'` when nothing is stored (Req 14); an effect applies/removes the `dark` class on `document.documentElement`, re-deriving the effective value from `window.matchMedia('(prefers-color-scheme: dark)')` whenever the stored preference is `'system'`, and subscribes to that query's `change` event so a live OS-level change updates the applied class without a reload (Req 17) and without the stored preference itself changing. An explicit Light/Dark choice writes straight to `localStorage` (Req 15) and updates the class synchronously (Req 16). Add a compact 3-option control to `apps/web/src/routes/root-layout.tsx`'s sidebar, wired to the hook (Req 13). | builder | none | not_started | 0 | | | | | 25 | | | | yes | |
| T5 | In `apps/web/src/routes/root-layout.tsx`, switch the active nav-link's own highlight from `bg-accent text-accent-foreground` to `bg-surface-contrast text-accent-foreground` (T1's new token) — only the `isActive` branch; its separate `hover:bg-accent hover:text-accent-foreground` classes are untouched (Req 18). | builder | T1 | not_started | 0 | | | | | 10 | | | | yes | |

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

## Cycle Log

### Cycle 0
Trigger: initial
UAT: not_run
