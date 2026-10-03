import { useEffect, useRef, useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { ErrorBanner } from '@/components/error-banner';
import { LoadingSpinner } from '@/components/loading-spinner';
import { ApiError } from '@/lib/api-client';
import { createSaleListing } from '@/features/sale-listings/sale-listings-api';

/**
 * Entry point for "Prepare Sale Listing" (Req 8), reached from a
 * `ready_to_list` row on the Parts screen. Drafts a new Sale Listing for
 * `:partId` immediately — with no title/description/platform/price
 * override, so the backend's server-side pre-fill (category + description)
 * is what the user sees first — then hands off to the draft editor at its
 * new id. A thin redirect rather than its own form, since the backend
 * already produces sensible defaults; editing happens on the next screen.
 */
export function SaleListingNewPage() {
  const { partId } = useParams<{ partId: string }>();
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Guards against React 18 StrictMode's dev-only double-invoke of effects
  // creating two drafts for the same click.
  const hasRequested = useRef(false);

  useEffect(() => {
    if (!partId || hasRequested.current) {
      return;
    }
    hasRequested.current = true;
    createSaleListing(partId)
      .then((created) => setCreatedId(created.id))
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : 'Failed to draft sale listing.'));
  }, [partId]);

  if (error) {
    return <ErrorBanner message={error} />;
  }
  if (createdId) {
    return <Navigate to={`/sale-listings/${createdId}`} replace />;
  }
  return <LoadingSpinner label="Drafting sale listing…" />;
}
