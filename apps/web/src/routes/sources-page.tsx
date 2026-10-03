import { useCallback, useEffect, useState } from 'react';
import type { CreateSourceInput, Source } from '@pc-parts-flipper/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LoadingSpinner } from '@/components/loading-spinner';
import { ErrorBanner } from '@/components/error-banner';
import { ApiError } from '@/lib/api-client';
import { createSource, deactivateSource, fetchSources, updateSource } from '@/features/sources/sources-api';
import { SourceForm } from '@/features/sources/source-form';
import { SourceList } from '@/features/sources/source-list';

// Which panel renders below the toolbar: the table alone, the create form,
// or the edit form for one specific Source.
type PanelState = { mode: 'list' } | { mode: 'create' } | { mode: 'edit'; source: Source };

// Sources screen (Req 1): list every Source with a "Show inactive" toggle,
// plus create/edit/deactivate. Owns all data-fetching and mutation state;
// SourceForm/SourceList/SourceRow are presentational and report user intent
// back up via callbacks.
export function SourcesPage() {
  const [sources, setSources] = useState<Source[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(true);
  const [panel, setPanel] = useState<PanelState>({ mode: 'list' });

  const loadSources = useCallback(async (includeInactive: boolean) => {
    setLoadError(null);
    try {
      const result = await fetchSources(!includeInactive);
      setSources(result);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Failed to load sources.');
    }
  }, []);

  useEffect(() => {
    void loadSources(showInactive);
  }, [loadSources, showInactive]);

  async function handleCreate(input: CreateSourceInput) {
    await createSource(input);
    setPanel({ mode: 'list' });
    await loadSources(showInactive);
  }

  async function handleEdit(input: CreateSourceInput) {
    if (panel.mode !== 'edit') return;
    await updateSource(panel.source.id, input);
    setPanel({ mode: 'list' });
    await loadSources(showInactive);
  }

  async function handleDeactivate(source: Source) {
    // window.confirm is the simplest confirm affordance available; no
    // design-system confirmation dialog exists yet for this to use instead.
    if (!window.confirm(`Deactivate "${source.name}"? It will no longer appear as active, but its history is kept.`)) {
      return;
    }
    await deactivateSource(source.id);
    await loadSources(showInactive);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Sources</h1>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
            Show inactive
          </label>
          <Button onClick={() => setPanel({ mode: 'create' })} disabled={panel.mode === 'create'}>
            Add Source
          </Button>
        </div>
      </div>

      {panel.mode === 'create' && <SourceForm onSubmit={handleCreate} onCancel={() => setPanel({ mode: 'list' })} />}
      {panel.mode === 'edit' && (
        <SourceForm initialValue={panel.source} onSubmit={handleEdit} onCancel={() => setPanel({ mode: 'list' })} />
      )}

      <Card>
        <CardHeader>
          <CardTitle>Purchase Sources</CardTitle>
        </CardHeader>
        <CardContent>
          {loadError && <ErrorBanner message={loadError} />}
          {!loadError && sources === null && <LoadingSpinner />}
          {!loadError && sources !== null && (
            <SourceList sources={sources} onEdit={(source) => setPanel({ mode: 'edit', source })} onDeactivate={handleDeactivate} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
