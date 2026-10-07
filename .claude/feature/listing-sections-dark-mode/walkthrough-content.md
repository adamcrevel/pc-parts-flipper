# Overview
The Listing edit screen was the only place to see a Listing's details, and a Listing with several
Expected Parts read as one long form. This feature turns the listing-level fields and each Expected
Part into collapsible boxes — collapsed for data already saved, expanded for anything new — so a
long Listing reads as a short list instead. It also adds a Light/Dark/System theme control, reachable
from every screen, that follows the device's preference until the user picks one explicitly. Both
changes share one new background token so the collapsible boxes and the sidebar's active-page
highlight visibly stand out from the plain page background, in both themes.

## Collapsible primitive and shared contrast token
Summary: A reusable `CollapsibleSection` component, built on a new Radix dependency, and one new CSS
token (`--surface-contrast` / `bg-surfaceContrast`) that every collapsible box and the sidebar's
active link use to stand out from the page background.
Tasks: T1
Files:
- apps/web/package.json, package-lock.json: adds the `@radix-ui/react-collapsible` dependency this feature's collapsible boxes are built on.
- apps/web/src/components/ui/collapsible.tsx: the new `Collapsible`/`CollapsibleTrigger`/`CollapsibleContent`/`CollapsibleSection` primitives — a bordered trigger row with a rotating chevron and the `surfaceContrast` background, content unmounted while closed.
- apps/web/src/index.css: defines `--surface-contrast` — noticeably darker than `--muted` in light mode, identical to `--muted` in dark mode (a dark box needs no extra darkening to stand out).
- apps/web/tailwind.config.js: wires `--surface-contrast` to a `surfaceContrast` Tailwind color so `bg-surfaceContrast` is usable as a class.
- apps/web/test/collapsible.test.tsx: proves open/close toggling, chevron rotation, the `bg-surfaceContrast` class, and that content unmounts while closed.

## Listing details box
Summary: The Title/Source/Description/URL/Price/Date/Fees block now renders inside one
`CollapsibleSection`, collapsed by default when editing an already-saved Listing, expanded by
default when creating a new one.
Tasks: T2
Flow:
- Open a Listing: Fields box renders collapsed
- Click trigger: Fields box expands, values unchanged
- Create new Listing: Fields box renders expanded immediately
Files:
- apps/web/src/features/listings/listing-form.tsx: wraps `ListingFields` in `CollapsibleSection`, with `listingFieldsOpen` initialized from whether `initialValue` is set.
- apps/web/test/listing-form.test.tsx: proves the collapsed-when-editing / expanded-when-creating defaults, toggle behavior, value survival across collapse/expand, and the `bg-surfaceContrast` token's presence.
- apps/web/test/listings-page.test.tsx: updated to expand the now-collapsed Listing Details box before reading its inputs, so the existing stale-fetch-race tests still reach the fields they assert on.

## Expected Part rows
Summary: Each Expected Part row becomes its own collapsible box — collapsed by default for rows
seeded from already-saved data, expanded by default for a row just added via "Add Part" — with the
collapsed trigger always showing category/brand/part number/estimated value, and the rest (description,
AI badge, identity candidates) revealed only when expanded. Collapsing/expanding never discards a
field value or forces an errored row open.
Tasks: T3
Flow:
- Row seeded from saved data: starts collapsed
- Row added via Add Part: starts expanded
- Collapsed trigger: shows category/brand/part#/value
- Expand: reveals description, AI badge, identity candidates
- Toggle collapse: field values and aiSuggested flag untouched
Files:
- apps/web/src/features/listings/expected-parts-editor.tsx: moves category/brand/part#/value into the `CollapsibleSection` trigger (so they stay mounted while collapsed), moves description/AI badge/identity candidates into its content, adds `toggleRowCollapsed` (separate from `updateRow` so toggling never clears `aiSuggested`), and an `AlertCircle` error indicator on a collapsed row with a field error.
- apps/web/src/features/listings/listing-form-state.ts: adds the optional `collapsed` field to `ExpectedPartRow`; `emptyExpectedPartRow()` sets it `false` (Add Part starts expanded), `expectedPartToRow()` sets it `true` unconditionally for every row built from saved data — including AI-suggested ones, after a mid-cycle fix (see Notable decisions).
- apps/web/test/listing-form-state.test.ts: proves the collapsed defaults for saved rows (AI-suggested or not) versus the single expanded fallback row for a Listing with no Expected Parts yet.
- apps/web/test/expected-parts-editor.test.tsx (not shown in diff summary but exercised per plan): covers the collapsed/expanded content split and the error indicator.
- apps/web/test/identify-parts.test.tsx: `descriptionValues()` now expands collapsed rows (awaited) before reading their description values, since those inputs are no longer mounted on a collapsed row.
- apps/web/test/identity-candidates-picker.test.tsx: its candidate-button filter now also excludes the row's own collapsible trigger button (identified by `aria-expanded`), so it isn't mistaken for a candidate chip.
- apps/web/test/listings-page.test.tsx: expands a row's trigger before reading its description input, for the same reason as `identify-parts.test.tsx`.

## Theme control
Summary: A Light/Dark/System preference, reachable from every screen via the sidebar, defaulting to
the OS preference until the user picks one explicitly; the choice persists and live OS changes are
picked up while on System.
Tasks: T4
Flow:
- No stored preference: follows OS `prefers-color-scheme`
- OS preference changes live, still on System: class updates immediately
- User picks Light or Dark: writes to localStorage, applies instantly
- Reload: stored choice is read back and re-applied
Files:
- apps/web/src/lib/use-theme-preference.ts: the `useThemePreference` hook — reads/writes the `pc-parts-flipper:theme` localStorage key, applies the `dark` class on `document.documentElement`, and subscribes to `matchMedia`'s `change` event while on System so a live OS flip updates the class without touching the stored preference.
- apps/web/test/use-theme-preference.test.tsx: proves the system default, synchronous class/localStorage update on an explicit choice, persistence across a simulated reload, and the live `matchMedia` change reaction while staying in System mode.

## Sidebar: theme control placement and active-link highlight
Summary: The theme control is added to the sidebar as three icon buttons below the nav list; the
sidebar's existing active-page highlight switches to the same `surfaceContrast` token the collapsible
boxes use, so it's visibly distinct from the page background in light mode (dark mode already was).
Tasks: T4, T5
Files:
- apps/web/src/routes/root-layout.tsx: T4 adds the Light/Dark/System icon-button row (Sun/Moon/Monitor) wired to `useThemePreference`; T5 changes only the `isActive` nav-link branch from `bg-accent` to `bg-surfaceContrast`, leaving the separate hover classes untouched.
- apps/web/test/root-layout.test.tsx: proves the active link carries `bg-surfaceContrast` (not `bg-accent`) while hover classes are preserved on every link, active or not.

## Notable decisions
- A collapsed row's category/brand/part#/value inputs stay mounted (they live in the trigger, not the
  unmounting `CollapsibleContent`), so a collapsed row's own identification fields are never
  unreachable — only description/AI badge/identity candidates unmount when collapsed.
- Mid-cycle, a review (R3) caught that `expectedPartToRow` had been built with an AI-suggestion
  carve-out (leaving freshly-identified rows expanded) to avoid breaking `identify-parts.test.tsx`.
  That carve-out violated the requirement that every saved row starts collapsed regardless of AI
  provenance; it was reverted to unconditional `collapsed: true`, and the affected test file's own
  helper (which already expands rows before reading them) absorbed the change with no production
  work-around needed.
