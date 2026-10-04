import type { AiIdentifiedPart, ListingDetail } from '@pc-parts-flipper/shared';
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
 * Derives ListingForm's initial Expected Parts rows: the Listing's existing
 * parts when editing one that already has them, otherwise a single blank
 * row to edit. Split out for the same reason as initialListingFormFields.
 */
export function initialExpectedPartRows(initialValue?: ListingDetail): ExpectedPartRow[] {
  if (!initialValue || initialValue.expectedParts.length === 0) {
    return [emptyExpectedPartRow()];
  }
  return initialValue.expectedParts.map((part) => ({
    componentCategory: part.componentCategory,
    description: part.description,
    estimatedResaleValue: String(part.estimatedResaleValue),
  }));
}

/**
 * Converts one AI-identified part into a draft Expected Parts row. The
 * estimated resale value is deliberately left blank: the model is only asked
 * to identify parts, never to price them, so that field stays the user's to
 * fill in (and validateExpectedPartRows keeps insisting on it before save).
 */
export function aiPartToExpectedPartRow(part: AiIdentifiedPart): ExpectedPartRow {
  return {
    componentCategory: part.category,
    description: part.description,
    estimatedResaleValue: '',
    aiSuggested: true,
    aiConfidence: part.confidence,
    aiSource: part.source,
  };
}
