import { useState, type FormEvent } from 'react';
import type { PlatformType, SaleListing } from '@pc-parts-flipper/shared';
import { Button } from '@/components/ui/button';
import { ErrorBanner } from '@/components/error-banner';
import { ApiError } from '@/lib/api-client';
import { SaleListingFields } from '@/features/sale-listings/sale-listing-fields';
import { updateSaleListing } from '@/features/sale-listings/sale-listings-api';
import { validateSaleListingFields, type SaleListingFieldErrors } from '@/features/sale-listings/validate-sale-listing';

interface SaleListingFormProps {
  saleListing: SaleListing;
  onSaved: (updated: SaleListing) => void;
}

/**
 * Draft editor for a Sale Listing (Req 8): platform select, title/
 * description (both server-pre-filled by the create call that produced
 * `saleListing`, editable here), and asking price, with inline Requirement
 * 13 validation (title required, asking price >= 0). Only rendered while
 * the listing is still a draft — SaleListingDetailPage swaps this out for a
 * read-only summary once `listedAt` is set.
 */
export function SaleListingForm({ saleListing, onSaved }: SaleListingFormProps) {
  const [platform, setPlatform] = useState<PlatformType>(saleListing.platform);
  const [title, setTitle] = useState(saleListing.title);
  const [description, setDescription] = useState(saleListing.description ?? '');
  const [askingPrice, setAskingPrice] = useState(String(saleListing.askingPrice));
  const [fieldErrors, setFieldErrors] = useState<SaleListingFieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const errors = validateSaleListingFields(title, askingPrice);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      return;
    }

    setSubmitError(null);
    setIsSubmitting(true);
    try {
      const updated = await updateSaleListing(saleListing.id, {
        platform,
        title: title.trim(),
        description: description.trim() || null,
        askingPrice: Number(askingPrice),
      });
      onSaved(updated);
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : 'Failed to save sale listing.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 rounded-lg border border-border p-4">
      <SaleListingFields
        platform={platform}
        onPlatformChange={setPlatform}
        title={title}
        onTitleChange={setTitle}
        description={description}
        onDescriptionChange={setDescription}
        askingPrice={askingPrice}
        onAskingPriceChange={setAskingPrice}
        fieldErrors={fieldErrors}
      />

      {submitError && <ErrorBanner message={submitError} />}

      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? 'Saving…' : 'Save Draft'}
      </Button>
    </form>
  );
}
