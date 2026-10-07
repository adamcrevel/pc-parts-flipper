import type { AiIdentifiedPart, ExpectedPart, ListingDetail } from '@pc-parts-flipper/shared';
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
 * Same treatment for a not-yet-priced estimatedResaleValue. Carries no
 * AI-draft fields (aiSuggested/aiConfidence/aiSource): this is a plain,
 * already-saved row, not an unreviewed suggestion.
 */
function expectedPartToRow(part: ExpectedPart): ExpectedPartRow {
  return {
    componentCategory: part.componentCategory,
    brand: part.brand ?? '',
    partNumber: part.partNumber ?? '',
    description: part.description,
    estimatedResaleValue: part.estimatedResaleValue === null ? '' : String(part.estimatedResaleValue),
    identityCandidates: part.identityCandidates ?? [],
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
 * inserts them the instant the job finishes, independent of any browser
 * being open) — so this re-syncs from `expectedParts` (a fresh
 * `fetchListing` result) rather than appending a locally-reconstructed,
 * not-yet-saved copy and submitting it. `justIdentified` is that same
 * job's own parts, used only to best-effort tag whichever of the freshly
 * fetched rows this job just added with the "AI suggested" badge and its
 * confidence/source caption — matched by category+description, the one
 * pairing a listing is very unlikely to repeat within one job's output.
 * A row with no match (every pre-existing row, from before this job or an
 * earlier one) renders exactly as a plain saved row.
 */
export function expectedPartsToRows(expectedParts: ExpectedPart[], justIdentified: AiIdentifiedPart[] = []): ExpectedPartRow[] {
  if (expectedParts.length === 0) {
    return [emptyExpectedPartRow()];
  }
  return expectedParts.map((part) => {
    const row = expectedPartToRow(part);
    const match = justIdentified.find((ai) => ai.category === part.componentCategory && ai.description === part.description);
    if (!match) {
      return row;
    }
    return { ...row, aiSuggested: true, aiConfidence: match.confidence, aiSource: match.source };
  });
}
