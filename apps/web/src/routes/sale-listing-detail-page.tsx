import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { PartSummary, SaleListing } from '@pc-parts-flipper/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LoadingSpinner } from '@/components/loading-spinner';
import { ErrorBanner } from '@/components/error-banner';
import { ApiError } from '@/lib/api-client';
import { fetchSaleListing, markSaleListingListed } from '@/features/sale-listings/sale-listings-api';
import { SaleListingForm } from '@/features/sale-listings/sale-listing-form';

/**
 * Sale Listing draft/detail screen (Req 8): the draft editor
 * (SaleListingForm) while `listedAt` is unset, a "Mark as Listed" action
 * that posts it and advances the linked Part's status `ready_to_list ->
 * listed` (Req 7), and a read-only summary plus the confirmed Part status
 * once posted.
 */
export function SaleListingDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [saleListing, setSaleListing] = useState<SaleListing | null>(null);
  const [updatedPart, setUpdatedPart] = useState<PartSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isMarkingListed, setIsMarkingListed] = useState(false);

  const loadSaleListing = useCallback(async () => {
    if (!id) return;
    setLoadError(null);
    try {
      setSaleListing(await fetchSaleListing(id));
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Failed to load sale listing.');
    }
  }, [id]);

  useEffect(() => {
    void loadSaleListing();
  }, [loadSaleListing]);

  async function handleMarkListed() {
    if (!saleListing) return;
    setActionError(null);
    setIsMarkingListed(true);
    try {
      const result = await markSaleListingListed(saleListing.id);
      setSaleListing(result.saleListing);
      setUpdatedPart(result.part);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Failed to mark sale listing listed.');
    } finally {
      setIsMarkingListed(false);
    }
  }

  if (loadError) {
    return <ErrorBanner message={loadError} />;
  }
  if (!saleListing) {
    return <LoadingSpinner />;
  }

  const isDraft = saleListing.listedAt === null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Sale Listing</h1>
        <Button asChild variant="outline" size="sm">
          <Link to="/parts">Back to Parts</Link>
        </Button>
      </div>

      {isDraft ? (
        <SaleListingForm saleListing={saleListing} onSaved={setSaleListing} />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>{saleListing.title}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p>Platform: {saleListing.platform}</p>
            <p>Asking price: ${saleListing.askingPrice.toFixed(2)}</p>
            <p>Listed at: {new Date(saleListing.listedAt as string).toLocaleString()}</p>
          </CardContent>
        </Card>
      )}

      {actionError && <ErrorBanner message={actionError} />}

      {isDraft && (
        <Button type="button" onClick={handleMarkListed} disabled={isMarkingListed}>
          {isMarkingListed ? 'Marking Listed…' : 'Mark as Listed'}
        </Button>
      )}

      {updatedPart && (
        <p className="text-sm text-emerald-700">
          Part status updated to <span className="font-medium">{updatedPart.status}</span>.
        </p>
      )}
    </div>
  );
}
