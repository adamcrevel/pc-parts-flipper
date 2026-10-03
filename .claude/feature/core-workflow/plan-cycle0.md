Status: proposed
Cycle: 0 / 3
FeatureStarted: 2026-10-02T18:24:58Z
OrchestrationTokensActual: 328984
OrchestrationTokensBreakdown: output 26,824 + cache-write 127,317 + cache-read 174,843, across 53 turns (cache-read reflects accumulated context resent each turn, not spend)
Prototype: .claude/feature/core-workflow/prototype.html (local file — no hosted-publish capability on this host, so there is no live URL)
BaselineTests: null
BaselineSuite: null

# pc-parts-flipper — core-workflow

## Goal
Build a local, private, full-stack TypeScript web app (React + Vite frontend, Node.js/Fastify backend, DuckDB file storage) for one user to manually run the whole sourcing-to-sale workflow for a side hustle: buying used pre-built computers, taking them apart, and reselling the parts. It covers setting up purchase sources, logging candidate listings with expected parts and estimated resale values, accepting or rejecting each listing, tracking a purchase from order through arrival and teardown, checking actual parts found against what was expected, prepping and tracking sale listings per part on external marketplaces, recording final sale outcomes, and showing profit/loss per purchase (lot). AI listing analysis, automated marketplace scanning/source discovery, comparable-price lookup, and live marketplace API submission are saved for a future feature. This build is manual-entry only, but models the domain so automation can be added later without reworking the schema.

## Requirements
1. Source CRUD: create, edit, deactivate. Fields: name, platform type (ebay | facebook_marketplace | other), URL, notes.
2. Listing creation, linked to a Source. Fields: title, description, listing URL, asking price, listing date, uploaded photos (stored on local disk, referenced in DuckDB), and a list of Expected Parts — each with component category (CPU | GPU | Motherboard | RAM | Storage | PSU | Case | Cooler | Other), free-text description/model, and an estimated resale value.
3. The Listing screen computes and displays: sum of Expected Parts' estimated resale values vs. (asking price + user-entered estimated acquisition fees/shipping) — so the user can judge the listing before deciding.
4. Listing status: open (default), accepted, or rejected. Accepting a Listing creates a linked Purchase pre-filled with the Listing's price and Expected Parts.
5. Purchase lifecycle status: ordered -> shipped -> received -> torn_down -> closed, with its own actual price paid and purchase date (independent of the Listing's asking price — negotiated price may differ).
6. Teardown workflow, available once a Purchase is received: for every Expected Part on the originating Listing, mark present_as_expected, present_but_different (with a note), or missing; also record any Additional Part found that was not on the Expected list. Submitting the teardown moves the Purchase to torn_down and generates a Part record for every part marked present_as_expected, present_but_different, or additional.
7. Part status: ready_to_list -> listed -> sold, or unsellable (requires a reason note).
8. Sale Listing preparation for a ready_to_list Part: target platform (reuses the Source platform types), an editable title/description pre-filled from the Part's category and description, and an asking price. Marking it listed records a listed_at date and moves the Part to listed. No live submission to any external marketplace API exists in this build — "listed" reflects the user's own manual posting, confirmed in-app.
9. Sale recording against a listed Part: sold price, sold date, platform fee amount, shipping cost paid, optional buyer note. Recording a sale moves the Part to sold.
10. Purchase-level profit view, per Purchase: price paid, sum of realized Part sale prices, sum of platform fees + shipping costs across those sales, and net profit (= sale revenue - fees/shipping - price paid). A Purchase with any Part not yet sold is visibly flagged partial/running, distinct from one where every Part has sold. Per-part cost is never allocated; profit is computed only at the Purchase level (A1).
11. Purchases dashboard: lists every Purchase with status and running/final net profit, sortable and filterable by status.
12. Listings queue screen: lists every Listing across all Sources, filterable by status (open/accepted/rejected) and by Source, each row showing the comparison from Requirement 3.
13. Every form (Source, Listing, Expected Part, Purchase, Teardown, Part, Sale Listing, Sale) rejects a save when a required field is blank or a monetary field is negative, with an inline error — never silently accepts blank or invalid values.
14. All monetary values are stored and displayed in USD with 2 decimal places; no multi-currency support.
15. The Purchases dashboard (Req 11) and the Listings queue (Req 12) paginate once their row counts exceed a single screen, rather than rendering an unbounded list.

## Standing checks
- The whole test suite passes, and the test count holds at or above BaselineTests (there is no prior suite — it's a fresh repo — so this means: a real automated test suite exists and passes).
- ESLint runs clean with zero new violations (configured in Task 1).
- Every new public function/class/component carries a block comment summarizing its intent; non-obvious lines carry a single-line comment above them (per project convention).
- Logging follows Error (unrecoverable) / Warn (recoverable fallback) / Info (flow-entry tracing, kept minimal) / Debug (detailed logic tracing) / Trace (raw data dumps, local-only) — each level adds new information, never repeating what a lower level already logs.
- `apps/web` never imports `apps/server` modules directly; it only calls the HTTP API — checked by an import scan across the whole web app, not one file.
- All DuckDB access is confined to one data-access module in `apps/server`; no route handler or other module opens or queries the database file directly — checked by a scan across the whole backend, not one file.
- Concurrent creation of Listings, Purchases, and Parts under genuinely parallel HTTP requests never collides on generated IDs or loses a record — proven with real parallel requests against the running server, not sequential calls in turn (Task 14).
- No new source file exceeds ~200 lines; a task whose natural implementation would is split instead of landing oversized.

## Tasks
| id | description | role | depends_on | status | cycle | model | started_at | completed_at | expected_minutes | estimated_start | estimated_tokens | actual_tokens | ui |
|----|----|----|----|----|----|----|----|----|----|----|----|----|----|
| PT1 | Clickable HTML prototype covering every ui:yes task (T4-T13): app shell, Sources, Listing create/edit w/ Expected Parts + comparison, Listings queue, Purchase detail, Teardown checklist, Parts, Sale Listing prep, Record Sale, Profit dashboard | prototype | none | complete | 0 | | 2026-10-02T19:12:15Z | 2026-10-02T19:29:37Z | 30 | 2026-10-02T19:12:15Z | 45000 | null | yes |
| T1 | Scaffold npm-workspaces monorepo: apps/web (Vite+React+TS+Tailwind+shadcn/ui), apps/server (Fastify+TS), packages/shared (shared TS types); root ESLint+Prettier incl. a web->server import-boundary rule; .nvmrc pinned to Node 22; root scripts (dev runs both concurrently, build, lint, test) | builder | none | not_started | 0 | | | | 25 | | | | no |
| T2 | DuckDB schema/migrations (sources, listings, expected_parts, purchases, teardown_results, parts, sale_listings, sales) + one data-access module in apps/server exposing typed query functions + a lint/scan rule blocking DuckDB client construction outside that module | builder | T1 | not_started | 0 | | | | 25 | | | | no |
| T3 | Backend app shell: Fastify bootstrap, structured logger (pino) at the levels defined in Standing checks, centralized error-handling middleware | builder | T1 | not_started | 0 | | | | 15 | | | | no |
| T4 | Frontend app shell: React Router layout/nav, typed API client (shared types from packages/shared), loading/error UI conventions, Tailwind/shadcn base theme | builder | T1 | not_started | 0 | | | | 20 | | | | yes |
| T5 | Sources: CRUD API routes + React screen (list, create, edit, deactivate) | builder | T2, T3, T4 | not_started | 0 | | | | 20 | | | | yes |
| T6 | Listings: API routes for Listings + nested Expected Parts, photo upload storage, comparison calculation (Req 3) + React screen (create/edit, expected-parts editor, photo upload, computed comparison) | builder | T5 | not_started | 0 | | | | 30 | | | | yes |
| T7 | Listings queue screen: filter by status/Source, accept/reject actions (accept creates a linked Purchase), pagination (Req 15) | builder | T6 | not_started | 0 | | | | 20 | | | | yes |
| T8 | Purchases: API (lifecycle status transitions, price paid, purchase date) + React detail screen with status update | builder | T7 | not_started | 0 | | | | 20 | | | | yes |
| T9 | Teardown workflow: API endpoint applying the reconciliation in Req 6 and generating Part records + React checklist UI | builder | T8 | not_started | 0 | | | | 25 | | | | yes |
| T10 | Parts: API (status transitions) + React screen listing Parts with status filters | builder | T9 | not_started | 0 | | | | 15 | | | | yes |
| T11 | Sale Listings: API (draft prep pre-filled from Part, mark listed) + React UI (draft editor, mark-as-listed action) | builder | T10 | not_started | 0 | | | | 20 | | | | yes |
| T12 | Sales: API (record sale: price/fees/shipping/date, moves Part to sold) + React record-sale form | builder | T11 | not_started | 0 | | | | 20 | | | | yes |
| T13 | Profit dashboard: aggregation endpoint (per-purchase totals, partial-vs-realized flag) + React dashboard with sort/filter/pagination (Req 10, 11, 15) | builder | T12 | not_started | 0 | | | | 25 | | | | yes |
| T14 | Concurrency proof test: real parallel HTTP requests creating Listings/Purchases/Parts, asserting no ID collision or lost record | builder | T13 | not_started | 0 | | | | 20 | | | | no |

## Assumptions
- A1 (cycle 0): Cost isn't split per part; profit is figured only at the Purchase (lot) level, per the user's statement that per-part allocation isn't needed.
- A2 (cycle 0): Single currency (USD), 2 decimal places; no multi-currency support.
- A3 (cycle 0): No login — the app is local-only, single user (matches the "Local only" deployment answer).
- A4 (cycle 0): Photos are stored on local disk under the repo's `data/` directory (gitignored), referenced by path in DuckDB — no cloud storage/CDN.
- A5 (cycle 0): "Listing" a sale and "confirming" a sale are manual confirmations by the user in this build, not live calls to eBay/FB APIs — no outbound network call to any marketplace exists in this build.
- A6 (cycle 0): No cron/scheduler is added in this phase — there's nothing to run nightly yet (no scanning/discovery jobs exist); that comes with the phase-2 feature that adds them.
- A7 (cycle 0): DuckDB is opened by a single Fastify server process; no second process attaches to the same file at the same time, avoiding DuckDB's single-writer file-lock constraint.
- A8 (cycle 0): The component category list is fixed (CPU, GPU, Motherboard, RAM, Storage, PSU, Case, Cooler, Other) — not user-configurable in this phase.
- A9 (cycle 0): New GitHub repo `adamcrevel/pc-parts-flipper`, created empty and private, no existing code imported.
- A10 (cycle 0): The system's default `node` is v12.22.9, too old for Vite/Fastify; the project pins Node 22 LTS via `.nvmrc` (nvm already has 20/22/24 installed on this machine).

## Cycle Log
### Cycle 0
Trigger: initial
UAT: not_run
Note: host `omp` install briefly could not boot any `effort: medium`/`effort: high` sub-agent
(`Error: No model selected.`) — reproduced on feature-prototyper-medium/-large,
feature-builder-medium, feature-reviewer-medium; `effort: low` agents (feature-pm, tldr) were
unaffected. User fixed the host model config; feature-builder-medium confirmed booting again
afterward. No plan content was changed by this; logged for the record.
