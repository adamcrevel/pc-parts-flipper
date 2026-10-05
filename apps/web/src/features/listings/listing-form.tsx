import { useState, type FormEvent } from 'react';
import type { AiIdentifiedPart, CreateListingInput, ExpectedPartInput, ListingDetail, Source } from '@pc-parts-flipper/shared';
import { Button } from '@/components/ui/button';
import { ErrorBanner } from '@/components/error-banner';
import { ApiError } from '@/lib/api-client';
import { EbayScanBadge } from '@/features/listings/ebay-scan-badge';
import { ExpectedPartsEditor, type ExpectedPartRow, type ExpectedPartRowErrors } from '@/features/listings/expected-parts-editor';
import { ListingComparisonSummary } from '@/features/listings/listing-comparison-summary';
import { ListingFields } from '@/features/listings/listing-fields';
import { IdentifyPartsButton } from '@/features/listings/identify-parts-button';
import { aiPartToExpectedPartRow, initialExpectedPartRows, initialListingFormFields } from '@/features/listings/listing-form-state';
import { PhotoUpload } from '@/features/listings/photo-upload';
import { validateExpectedPartRows, validateListingFields, type ListingFieldErrors } from '@/features/listings/validate-listing';

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

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const listingErrors = validateListingFields(fields.title, fields.listingUrl, fields.sourceId, fields.askingPrice, fields.listingDate, fields.acquisitionFees);
    const partRowErrors = validateExpectedPartRows(rows);
    setFieldErrors(listingErrors);
    setRowErrors(partRowErrors);
    if (Object.keys(listingErrors).length > 0 || partRowErrors.some((errors) => Object.keys(errors).length > 0)) {
      return;
    }

    // Field-by-field (never a spread of `row`): ExpectedPartRow carries
    // client-only draft state (aiSuggested/aiConfidence/aiSource) that must
    // not reach the backend. Blank brand/part number send as null rather
    // than '' — "not identified" is an absence, not an empty string.
    const expectedParts: ExpectedPartInput[] = rows.map((row) => ({
      componentCategory: row.componentCategory as ExpectedPartInput['componentCategory'],
      brand: row.brand.trim() || null,
      partNumber: row.partNumber.trim() || null,
      description: row.description.trim(),
      estimatedResaleValue: Number(row.estimatedResaleValue),
      identityCandidates: row.identityCandidates,
    }));

    setSubmitError(null);
    setIsSubmitting(true);
    try {
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

  // Appends the AI's suggestions as extra draft rows. Existing rows are
  // never removed or overwritten — identification only ever adds to what the
  // user already has, and every added row stays editable/removable and
  // unsaved until they submit the form themselves.
  function handlePartsIdentified(parts: AiIdentifiedPart[]) {
    setRows((prev) => [...prev, ...parts.map(aiPartToExpectedPartRow)]);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 rounded-lg border border-border p-4">
      {initialValue?.externalItemId !== null && initialValue?.externalItemId !== undefined && (
        <EbayScanBadge listingUrl={initialValue.listingUrl} />
      )}

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

      <ExpectedPartsEditor rows={rows} rowErrors={rowErrors} onChange={setRows} />

      {/* Takes `saved` as-is and renders its own save-first hint while it's undefined, so there's no create/edit branch to carry here. */}
      <IdentifyPartsButton listing={saved} onIdentified={handlePartsIdentified} />

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
