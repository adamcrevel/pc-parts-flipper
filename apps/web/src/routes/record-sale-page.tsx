import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { PartSummary } from '@pc-parts-flipper/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LoadingSpinner } from '@/components/loading-spinner';
import { ErrorBanner } from '@/components/error-banner';
import { ApiError } from '@/lib/api-client';
import { fetchPart } from '@/features/parts/parts-api';
import { RecordSaleForm } from '@/features/sales/record-sale-form';

/**
 * Record Sale screen (Req 9), reached from a `listed` row on the Parts
 * screen. Loads the Part for context (category/description), rejects with
 * an inline error if it isn't currently `listed` (mirrors the backend's own
 * check), and on a successful submit advances it `listed -> sold` (Req 7)
 * before navigating back to the Parts screen, which re-fetches and shows
 * the confirmed status.
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
          <CardTitle>
            {part.category}: {part.description}
          </CardTitle>
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
