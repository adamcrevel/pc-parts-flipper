import type { Source } from '@pc-parts-flipper/shared';
import { SourceRow } from '@/features/sources/source-row';

interface SourceListProps {
  sources: Source[];
  onEdit: (source: Source) => void;
  onDeactivate: (source: Source) => void;
  onScan: (source: Source) => void;
  scanningSourceId: string | null;
}

// Table of every Source currently loaded (sources-page.tsx controls whether
// that set is active-only or everything, via the "Show inactive" toggle).
// Renders nothing but an empty-state message when there are no rows to show.
export function SourceList({ sources, onEdit, onDeactivate, onScan, scanningSourceId }: SourceListProps) {
  if (sources.length === 0) {
    return <p className="text-sm text-muted-foreground">No sources yet. Add one to get started.</p>;
  }

  return (
    // overflow-x-auto scrolls the table horizontally on narrow viewports
    // instead of letting the right-most column (row actions) clip under
    // the Card's fixed padding.
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-border text-muted-foreground">
            <th className="px-4 py-2 font-medium">Name</th>
            <th className="px-4 py-2 font-medium">Platform</th>
            <th className="px-4 py-2 font-medium">URL</th>
            <th className="px-4 py-2 font-medium">Notes</th>
            <th className="px-4 py-2 font-medium">Status</th>
            <th className="px-4 py-2 font-medium">Last Scanned</th>
            <th className="px-4 py-2 font-medium" />
          </tr>
        </thead>
        <tbody>
          {sources.map((source) => (
            <SourceRow
              key={source.id}
              source={source}
              onEdit={onEdit}
              onDeactivate={onDeactivate}
              onScan={onScan}
              scanningSourceId={scanningSourceId}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
