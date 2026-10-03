import type { Source } from '@pc-parts-flipper/shared';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// Human-readable labels for the PlatformType union — kept here (not shared)
// since display copy is a UI-only concern the API layer has no stake in.
const PLATFORM_LABELS: Record<Source['platformType'], string> = {
  ebay: 'eBay',
  facebook_marketplace: 'Facebook Marketplace',
  other: 'Other',
};

interface SourceRowProps {
  source: Source;
  onEdit: (source: Source) => void;
  onDeactivate: (source: Source) => void;
}

// One row of the Sources table: the Source's fields, an active/inactive
// badge, and row actions. Deactivate only ever renders for active rows —
// once inactive, the only path back is editing the row directly (soft
// deactivate is one-way through this UI).
export function SourceRow({ source, onEdit, onDeactivate }: SourceRowProps) {
  return (
    <tr className="border-b border-border last:border-0">
      <td className="px-4 py-3 font-medium">{source.name}</td>
      <td className="px-4 py-3">{PLATFORM_LABELS[source.platformType]}</td>
      <td className="max-w-xs truncate px-4 py-3">
        <a href={source.url ?? undefined} target="_blank" rel="noreferrer" className="text-primary underline-offset-4 hover:underline">
          {source.url}
        </a>
      </td>
      <td className="max-w-xs truncate px-4 py-3 text-muted-foreground">{source.notes}</td>
      <td className="px-4 py-3">
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-xs font-medium',
            source.active ? 'bg-secondary text-secondary-foreground' : 'bg-muted text-muted-foreground',
          )}
        >
          {source.active ? 'Active' : 'Inactive'}
        </span>
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-right">
        <Button variant="ghost" size="sm" onClick={() => onEdit(source)}>
          Edit
        </Button>
        {source.active && (
          <Button variant="ghost" size="sm" className="text-destructive" onClick={() => onDeactivate(source)}>
            Deactivate
          </Button>
        )}
      </td>
    </tr>
  );
}
