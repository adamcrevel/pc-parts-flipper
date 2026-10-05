import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { formatPartIdentity, type PartSummary } from '@pc-parts-flipper/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LoadingSpinner } from '@/components/loading-spinner';
import { ErrorBanner } from '@/components/error-banner';
import { ApiError } from '@/lib/api-client';
import { fetchPart } from '@/features/parts/parts-api';
import { RecordSaleForm } from '@/features/sales/record-sale-form';

/**
 * Record Sale screen (Req 9), reached from a `listed` row on the Parts
 * screen. Loads the Part for context, rejects with an inline error if it
 * isn't currently `listed` (mirrors the backend's own check), and on a
 * successful submit advances it `listed -> sold` (Req 7) before navigating
 * back to the Parts screen, which re-fetches and shows the confirmed status.
 *
 * The heading names the part the same way its Sale Listing does — identity
 * first, falling back to `${category}: ${description}` only when neither
 * brand nor part number was identified (they are never guessed), exactly as
 * defaultSaleListingTitle does server-side. Otherwise a part listed as
 * "NVIDIA RTX 3070" would read as its condition notes on the very screen
 * where its sale is recorded.
 */
export function RecordSalePage() {
  const { partId } = useParams<{ partId: string }>();
  const navigate = useNavigate();
  const [part, setPart] = useState<PartSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadPart = useCallback(async () => {
    if (!partId) return;
    setLoadError(null);
    try {
      setPart(await fetchPart(partId));
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Failed to load part.');
    }
  }, [partId]);

  useEffect(() => {
    void loadPart();
  }, [loadPart]);

  if (loadError) {
    return <ErrorBanner message={loadError} />;
  }
  if (!part || !partId) {
    return <LoadingSpinner />;
  }

  // '' when neither brand nor part number was identified — the signal to fall
  // back to the free-text description in the heading.
  const identity = formatPartIdentity(part.brand, part.partNumber);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Record Sale</h1>
        <Button type="button" variant="outline" size="sm" onClick={() => navigate('/parts')}>
          Back to Parts
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle data-testid="record-sale-part-heading">
            {part.category}: {identity || part.description}
          </CardTitle>
          {/* Condition notes keep their own line once the identity has taken the heading, so nothing recorded about the part is hidden at sale time. */}
          {identity !== '' && (
            <p data-testid="record-sale-part-description" className="text-sm text-muted-foreground">
              {part.description}
            </p>
          )}
        </CardHeader>
        <CardContent>
          {part.status !== 'listed' ? (
            <ErrorBanner message={`This part is '${part.status}', not 'listed' — a sale can only be recorded for a listed part.`} />
          ) : (
            <RecordSaleForm partId={partId} onRecorded={() => navigate('/parts')} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
