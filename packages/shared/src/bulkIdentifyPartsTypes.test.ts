// Type-shape consistency proof for the bulk-identify-parts feature's new
// shared types: IdentifyPartsBulkOutcome/Result/Response
// (identifyPartsJob.ts) and ListListingIdsResponse /
// ListingSummary.identifyPartsStatus (listings.ts). These are pure `type`/
// `interface` declarations with no runtime representation of their own, so
// `vitest run`'s default esbuild transform strips every annotation below
// without type-checking it — a production field rename here would still
// make this file *run* green. The object literals are therefore annotated
// directly against each interface (never `satisfies`, which only flags
// excess properties and would miss a missing one) so that running
// `tsc --noEmit` against this file — which this package's own `build`
// script does not do, since `tsconfig.json` excludes `src/**/*.test.ts` —
// catches a field rename/removal immediately. The `it(...)` blocks below
// then pin what *is* genuinely runtime-observable: the exact union strings
// apps/web/src/features/listings-queue/bulk-identify-parts-bar.tsx
// switches on, and that `identifyPartsStatus`/`errorMessage` really
// serialize as JSON `null` (never dropped as `undefined`) the way
// apps/server/src/routes/listings.ts's `toSummary()` writes them and
// apps/web/src/features/listings-queue/listings-queue-table.tsx reads them
// back with `!== null`.
import { describe, expect, it } from 'vitest';
import type {
  IdentifyPartsBulkOutcome,
  IdentifyPartsBulkResponse,
  IdentifyPartsBulkResult,
  IdentifyPartsJobStage,
} from './identifyPartsJob.js';
import type { ListingSummary, ListListingIdsResponse } from './listings.js';

describe('bulk-identify-parts shared type shapes', () => {
  it('IdentifyPartsBulkOutcome is exactly the three outcomes bulk-identify-parts-bar.tsx counts', () => {
    // Mirrors formatBulkSummary's own `Record<IdentifyPartsBulkOutcome,
    // number>` literal: TypeScript requires every union member present as a
    // key and rejects any key that is not a union member, so this literal
    // is only assignable to the type if the union is exactly these three.
    const counts: Record<IdentifyPartsBulkOutcome, number> = { queued: 0, already_active: 0, not_found: 0 };
    expect(Object.keys(counts).sort()).toEqual(['already_active', 'not_found', 'queued']);
  });

  it('IdentifyPartsBulkResult/Response match the shape identifyParts.ts\'s bulk route returns per listing', () => {
    const result: IdentifyPartsBulkResult = { listingId: 'listing-1', outcome: 'already_active' };
    const response: IdentifyPartsBulkResponse = { results: [result] };

    // Round-trip through JSON the way Fastify serializes the real response
    // and apps/web's apiClient.post<IdentifyPartsBulkResponse> parses it,
    // proving the shape survives the actual wire format rather than only
    // TypeScript's structural check.
    const roundTripped = JSON.parse(JSON.stringify(response)) as IdentifyPartsBulkResponse;
    expect(roundTripped).toEqual({ results: [{ listingId: 'listing-1', outcome: 'already_active' }] });
  });

  it('ListListingIdsResponse matches GET /api/listings/ids and listings-api.ts\'s `.ids` destructure', () => {
    const response: ListListingIdsResponse = { ids: ['a', 'b', 'c'] };
    expect(response.ids).toEqual(['a', 'b', 'c']);
  });

  it('ListingSummary.identifyPartsStatus is JSON null (not an omitted key) when no job has run', () => {
    // apps/server's toSummary() writes `job ? {...} : null` — never omits
    // the key — and listings-queue-table.tsx reads
    // `listing.identifyPartsStatus !== null` directly, so an `undefined`
    // here (which JSON.stringify drops entirely) would silently break that
    // per-row check on the wire even though it type-checks locally.
    const withoutJob: Pick<ListingSummary, 'identifyPartsStatus'> = { identifyPartsStatus: null };
    const roundTripped = JSON.parse(JSON.stringify(withoutJob)) as Pick<ListingSummary, 'identifyPartsStatus'>;
    expect('identifyPartsStatus' in roundTripped).toBe(true);
    expect(roundTripped.identifyPartsStatus).toBeNull();
  });

  it('ListingSummary.identifyPartsStatus carries stage + errorMessage when a job exists', () => {
    const stage: IdentifyPartsJobStage = 'failed';
    const withJob: Pick<ListingSummary, 'identifyPartsStatus'> = {
      identifyPartsStatus: { stage, errorMessage: 'AI call timed out' },
    };
    expect(withJob.identifyPartsStatus).toEqual({ stage: 'failed', errorMessage: 'AI call timed out' });
  });
});
