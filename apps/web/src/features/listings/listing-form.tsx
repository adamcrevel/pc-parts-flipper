import { useState, type FormEvent } from 'react';
import type { CreateListingInput, ExpectedPart, ExpectedPartInput, ListingDetail, Source } from '@pc-parts-flipper/shared';
import { Button } from '@/components/ui/button';
import { CollapsibleSection } from '@/components/ui/collapsible';
import { ErrorBanner } from '@/components/error-banner';
import { ApiError } from '@/lib/api-client';
import { EbayScanBadge } from '@/features/listings/ebay-scan-badge';
import { ExpectedPartsEditor, type ExpectedPartRow, type ExpectedPartRowErrors } from '@/features/listings/expected-parts-editor';
import { ListingComparisonSummary } from '@/features/listings/listing-comparison-summary';
import { ListingFields } from '@/features/listings/listing-fields';
import { IdentifyPartsButton } from '@/features/listings/identify-parts-button';
import { expectedPartsToRows, initialExpectedPartRows, initialListingFormFields } from '@/features/listings/listing-form-state';
import { PhotoUpload } from '@/features/listings/photo-upload';
import { isUntouchedExpectedPartRow, validateExpectedPartRows, validateListingFields, type ListingFieldErrors } from '@/features/listings/validate-listing';

interface ListingFormProps {
  initialValue?: ListingDetail;
  sources: Source[];
  onSubmit: (input: CreateListingInput) => Promise<ListingDetail>;
  onCancel: () => void;
  // Called after the Listing is first saved (create) or re-saved (edit), so
  // the page can swap in the freshly returned ListingDetail — this is what
  // lets the Photos section appear immediately after create without a
  // separate "staged" upload path.
  onSaved: (listing: ListingDetail) => void;
}

/**
 * Create/edit form for a Listing (Req 2-3): listing fields (via
 * ListingFields), a Source picker, the repeatable Expected Parts editor, a
 * live comparison display (ListingComparisonSummary), and (once the Listing
 * has an id) photo upload. One component backs both modes: `initialValue`
 * pre-fills for editing; omitting it starts blank for create.
 */
export function ListingForm({ initialValue, sources, onSubmit, onCancel, onSaved }: ListingFormProps) {
  const [fields, setFields] = useState(() => initialListingFormFields(initialValue));
  const [rows, setRows] = useState<ExpectedPartRow[]>(() => initialExpectedPartRows(initialValue));
  const [fieldErrors, setFieldErrors] = useState<ListingFieldErrors>({});
  const [rowErrors, setRowErrors] = useState<ExpectedPartRowErrors[]>([]);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Tracks the saved Listing so the Photos section can appear immediately
  // after a successful create, without leaving create mode.
  const [saved, setSaved] = useState<ListingDetail | undefined>(initialValue);
  // CollapsibleSection open state for listing fields: expanded by default when
  // creating (no initialValue), collapsed when editing an existing listing.
  // Uses a function initializer to ensure this default applies only once,
  // matching the pattern of other state in this component.
  const [listingFieldsOpen, setListingFieldsOpen] = useState(() => !initialValue);

  function setField<K extends keyof typeof fields>(key: K, value: (typeof fields)[K]) {
    setFields((prev) => ({ ...prev, [key]: value }));
  }

  // Live comparison (Req 3): sum of expected parts' estimated resale values
  // vs. (asking price + acquisition fees), recomputed on every keystroke.
  // Non-numeric/blank row or field values count as 0 here — the real
  // validation below still blocks submit until they're filled in.
  const totalExpectedResaleValue = rows.reduce((sum, row) => sum + (Number(row.estimatedResaleValue) || 0), 0);
  const totalCost = (Number(fields.askingPrice) || 0) + (Number(fields.acquisitionFees) || 0);
  const difference = totalExpectedResaleValue - totalCost;
  // Req 10: rows.length is never 0 — the editor always seeds one blank draft
  // row (emptyExpectedPartRow) so there's something to type into — so the
  // comparison summary's "no Expected Parts" warning counts only rows with
  // actual data entered, not the blank placeholder row itself.
  const filledExpectedPartsCount = rows.filter((row) => row.description.trim() !== '' || row.estimatedResaleValue.trim() !== '').length;

  // Builds the PUT payload from the current fields plus `nextRows` (same
  // shape every explicit Save sends) and calls `onSubmit`. Shared by
  // handleSubmit and handlePartsIdentified so an explicit Save and an
  // identify-parts auto-save go through one path, never two slightly
  // different ones. Returns false (after setting fieldErrors/rowErrors)
  // instead of submitting when the current fields or rows are invalid,
  // the same guard handleSubmit always applied.
  async function persistListing(nextRows: ExpectedPartRow[]): Promise<boolean> {
    const listingErrors = validateListingFields(fields.title, fields.listingUrl, fields.sourceId, fields.askingPrice, fields.listingDate, fields.acquisitionFees);
    const partRowErrors = validateExpectedPartRows(nextRows);
    setFieldErrors(listingErrors);
    setRowErrors(partRowErrors);
    if (Object.keys(listingErrors).length > 0 || partRowErrors.some((errors) => Object.keys(errors).length > 0)) {
      return false;
    }

    // Field-by-field (never a spread of `row`): ExpectedPartRow carries
    // client-only draft state (aiSuggested) that must not reach the
    // backend as-is. Blank brand/part number send as null rather than ''
    // — "not identified" is an absence, not an empty string. Same for
    // estimatedResaleValue: blank means "not yet priced" (every AI
    // suggestion starts this way), sent as null rather than coercing it
    // to 0. aiConfidence/aiSource are sent only while the row is still
    // marked an unreviewed AI suggestion (row.aiSuggested) — null the
    // instant the user has touched it (updateRow in
    // expected-parts-editor.tsx clears aiSuggested on first edit), so an
    // edited row's badge correctly disappears on the next save too, not
    // just locally. Untouched placeholder rows (Req 10's always-present
    // blank starter, never typed into) are dropped here, not sent as an
    // empty/invalid Expected Part — they're UI scaffolding, not this
    // listing's data.
    //
    // priceSource is sent verbatim from the row's own three-state claim
    // (assumption A22): 'auto' keeps the row server-auto-managed across
    // this save, 'manual' keeps it the user's — updateRow in
    // expected-parts-editor.tsx flips 'auto' to 'manual' on first edit —
    // and undefined sends null, meaning "undecided", which is the only
    // state the server may claim for the pipeline.
    const expectedParts: ExpectedPartInput[] = nextRows
      .filter((row) => !isUntouchedExpectedPartRow(row))
      .map((row) => ({
        componentCategory: row.componentCategory as ExpectedPartInput['componentCategory'],
        brand: row.brand.trim() || null,
        partNumber: row.partNumber.trim() || null,
        description: row.description.trim(),
        estimatedResaleValue: row.estimatedResaleValue.trim() === '' ? null : Number(row.estimatedResaleValue),
        identityCandidates: row.identityCandidates,
        aiConfidence: row.aiSuggested ? (row.aiConfidence ?? null) : null,
        aiSource: row.aiSuggested ? (row.aiSource ?? null) : null,
        priceSource: row.priceSource ?? null,
      }));

    const result = await onSubmit({
      sourceId: fields.sourceId,
      title: fields.title.trim(),
      description: fields.description.trim() || null,
      listingUrl: fields.listingUrl.trim(),
      askingPrice: Number(fields.askingPrice),
      listingDate: fields.listingDate,
      acquisitionFees: fields.acquisitionFees.trim().length > 0 ? Number(fields.acquisitionFees) : 0,
      expectedParts,
    });
    setSaved(result);
    onSaved(result);
    return true;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitError(null);
    setIsSubmitting(true);
    try {
      await persistListing(rows);
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : 'Failed to save listing.');
    } finally {
      setIsSubmitting(false);
    }
  }

  function handlePhotosUploaded(updated: ListingDetail) {
    setSaved(updated);
    onSaved(updated);
  }

  // Re-syncs Expected Parts from the server's authoritative set after an
  // identify-parts job completes. The server already persisted every
  // identified part the instant the job finished — apps/server/src/jobs/
  // identifyPartsWorkerPool.ts inserts each one directly, aiConfidence/
  // aiSource included, independent of any browser being open — so this
  // reflects what's actually saved instead of appending a local,
  // not-yet-saved copy and submitting it on the UI's behalf. The "AI
  // suggested" badge comes from that same persisted data (see
  // listing-form-state.ts's expectedPartsToRows), so it survives this
  // listing being closed and reopened later, not just this one completion.
  function handlePartsSaved(expectedParts: ExpectedPart[]) {
    setRows(expectedPartsToRows(expectedParts));
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 rounded-lg border border-border p-4">
      {initialValue?.externalItemId !== null && initialValue?.externalItemId !== undefined && (
        <EbayScanBadge listingUrl={initialValue.listingUrl} />
      )}

      <CollapsibleSection
        trigger="Listing Details"
        open={listingFieldsOpen}
        onOpenChange={setListingFieldsOpen}
      >
        <ListingFields
          sources={sources}
          title={fields.title}
          onTitleChange={(value) => setField('title', value)}
          description={fields.description}
          onDescriptionChange={(value) => setField('description', value)}
          listingUrl={fields.listingUrl}
          onListingUrlChange={(value) => setField('listingUrl', value)}
          sourceId={fields.sourceId}
          onSourceIdChange={(value) => setField('sourceId', value)}
          askingPrice={fields.askingPrice}
          onAskingPriceChange={(value) => setField('askingPrice', value)}
          listingDate={fields.listingDate}
          onListingDateChange={(value) => setField('listingDate', value)}
          acquisitionFees={fields.acquisitionFees}
          onAcquisitionFeesChange={(value) => setField('acquisitionFees', value)}
          fieldErrors={fieldErrors}
        />
      </CollapsibleSection>

      <ExpectedPartsEditor rows={rows} rowErrors={rowErrors} onChange={setRows} />

      {/* Takes `saved` as-is and renders its own save-first hint while it's undefined, so there's no create/edit branch to carry here. */}
      <IdentifyPartsButton listing={saved} onPartsSaved={handlePartsSaved} />

      <ListingComparisonSummary
        totalExpectedResaleValue={totalExpectedResaleValue}
        totalCost={totalCost}
        difference={difference}
        expectedPartsCount={filledExpectedPartsCount}
      />

      {saved ? (
        <PhotoUpload listingId={saved.id} photoPaths={saved.photoPaths} onUploaded={handlePhotosUploaded} />
      ) : (
        <p className="text-sm text-muted-foreground">Save the listing to upload photos.</p>
      )}

      {submitError && <ErrorBanner message={submitError} />}

      <div className="flex gap-2">
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Saving…' : 'Save'}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={isSubmitting}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
