import type { ExpectedPart, ListingDetail } from '@pc-parts-flipper/shared';
import { emptyExpectedPartRow, type ExpectedPartRow } from '@/features/listings/expected-parts-editor';

/** The listing-level field values ListingForm's useState calls seed from. */
export interface ListingFormFields {
  title: string;
  description: string;
  listingUrl: string;
  sourceId: string;
  askingPrice: string;
  listingDate: string;
  acquisitionFees: string;
}

/**
 * Derives ListingForm's initial field values: blank for create (no
 * `initialValue`), pre-filled from the Listing being edited otherwise.
 * Pulled out of ListingForm itself (rather than inlined per-field in its
 * useState calls) so the component's own cyclomatic complexity — one of the
 * things feature-reviewer checks — stays low; this helper carries that
 * per-field fallback logic instead.
 */
export function initialListingFormFields(initialValue?: ListingDetail): ListingFormFields {
  if (!initialValue) {
    return { title: '', description: '', listingUrl: '', sourceId: '', askingPrice: '', listingDate: '', acquisitionFees: '' };
  }
  return {
    title: initialValue.title,
    description: initialValue.description ?? '',
    listingUrl: initialValue.listingUrl ?? '',
    sourceId: initialValue.sourceId,
    askingPrice: String(initialValue.askingPrice),
    listingDate: initialValue.listingDate,
    acquisitionFees: String(initialValue.acquisitionFees),
  };
}

/**
 * Converts one saved Expected Part into its editable draft row shape. Null
 * (not identified) renders as an empty input — the editor keeps every
 * field as a string while editing, and blank maps back to null on submit.
 * Same treatment for a not-yet-priced estimatedResaleValue. The "AI
 * suggested" badge comes straight from the part's own persisted
 * aiConfidence/aiSource (apps/server/src/jobs/identifyPartsWorkerPool.ts
 * writes both the moment identify-parts adds a part; both are null for a
 * manual row, or one the user has since edited — updateRow in
 * expected-parts-editor.tsx clears the draft `aiSuggested` flag on first
 * touch) — not a one-time echo of whichever job happened to just
 * complete, so the badge survives reopening the Listing later, not only
 * the one poll that saw the job finish.
 *
 * `priceSource` round-trips the same way — read straight off the
 * persisted part whenever it carries a claim ('auto' or 'manual'), so an
 * untouched row stays server-auto-managed across reopenings and a row the
 * user has taken over stays theirs. A persisted null (nobody has decided
 * yet) is dropped entirely rather than carried, which reads the same as
 * undefined on the row (assumption A22).
 *
 * `collapsed` defaults to true — already-reviewed data only needs its
 * compact summary line.
 */
function expectedPartToRow(part: ExpectedPart): ExpectedPartRow {
  return {
    componentCategory: part.componentCategory,
    brand: part.brand ?? '',
    partNumber: part.partNumber ?? '',
    description: part.description,
    estimatedResaleValue: part.estimatedResaleValue === null ? '' : String(part.estimatedResaleValue),
    identityCandidates: part.identityCandidates ?? [],
    collapsed: true,
    ...(part.aiConfidence != null && part.aiSource != null
      ? { aiSuggested: true, aiConfidence: part.aiConfidence, aiSource: part.aiSource }
      : {}),
    ...(part.priceSource === 'auto' || part.priceSource === 'manual' ? { priceSource: part.priceSource } : {}),
  };
}

/**
 * Derives ListingForm's initial Expected Parts rows: the Listing's existing
 * parts when editing one that already has them, otherwise a single blank
 * row to edit. Split out for the same reason as initialListingFormFields.
 */
export function initialExpectedPartRows(initialValue?: ListingDetail): ExpectedPartRow[] {
  if (!initialValue || initialValue.expectedParts.length === 0) {
    return [emptyExpectedPartRow()];
  }
  return initialValue.expectedParts.map(expectedPartToRow);
}

/**
 * Rebuilds the Expected Parts rows from the server's authoritative set,
 * for the moment an identify-parts job completes. The job's identified
 * parts are already persisted server-side by the time the UI ever sees
 * `stage: 'completed'` (apps/server/src/jobs/identifyPartsWorkerPool.ts
 * inserts them, aiConfidence/aiSource included, the instant the job
 * finishes, independent of any browser being open) — so this re-syncs
 * from `expectedParts` (a fresh `fetchListing` result) rather than
 * appending a locally-reconstructed, not-yet-saved copy. Same mapping as
 * initialExpectedPartRows; kept as a separate named export because the
 * two call sites mean two different things (first load vs. re-sync after
 * a job completes) even though the transform is identical.
 */
export function expectedPartsToRows(expectedParts: ExpectedPart[]): ExpectedPartRow[] {
  if (expectedParts.length === 0) {
    return [emptyExpectedPartRow()];
  }
  return expectedParts.map(expectedPartToRow);
}
