import type { Source } from '@pc-parts-flipper/shared';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// Human-readable labels for the PlatformType union — kept here (not shared)
// since display copy is a UI-only concern the API layer has no stake in.
const PLATFORM_LABELS: Record<Source['platformType'], string> = {
  ebay: 'eBay',
  mercari: 'Mercari',
  facebook_marketplace: 'Facebook Marketplace',
  other: 'Other',
};

// Platform types an automated "Scan now" is available for — must be kept
// in sync BY HAND with apps/server/src/connectors/registry.ts's
// CONNECTOR_REGISTRY, since apps/web may never import apps/server directly
// (existing import boundary, apps/web/test/eslint-import-boundary.test.ts)
// and so cannot read the registry's keys at runtime (T11).
const SCANNABLE_PLATFORM_TYPES: ReadonlyArray<Source['platformType']> = ['ebay', 'mercari', 'facebook_marketplace'];

interface SourceRowProps {
  source: Source;
  onEdit: (source: Source) => void;
  onDeactivate: (source: Source) => void;
  // Triggers an automated scan for this row's Source (T9); only ever called
  // from the Scan now button, which only renders for an eligible Source.
  onScan: (source: Source) => void;
  // The id of the Source currently mid-scan, or null — compared against
  // this row's own id so only the clicked row shows a pending state,
  // matching ListingsQueueTable's pendingListingId convention.
  scanningSourceId: string | null;
}

// Formats a Source's automated-scan status for the "Last Scanned" column:
// "Never scanned" when lastScannedAt is null, else a simple elapsed-hours
// summary. No date library is a project dependency (checked package.json),
// so this computes hours directly from the ISO timestamp rather than
// pulling one in for a single relative-time string. Shown for every Source
// regardless of platformType/connectorConfig — "Never scanned" reads
// naturally even for a Source that can never be auto-scanned, and a
// uniform column is simpler than conditionally hiding text per row.
function formatLastScanned(lastScannedAt: string | null, lastScanFoundCount: number | null): string {
  if (lastScannedAt === null) {
    return 'Never scanned';
  }
  const elapsedMs = Date.now() - new Date(lastScannedAt).getTime();
  const hours = Math.max(0, Math.round(elapsedMs / (60 * 60 * 1000)));
  return `Last scanned ${hours}h ago — ${lastScanFoundCount ?? 0} new`;
}

// One row of the Sources table: the Source's fields, an active/inactive
// badge, and row actions. Deactivate only ever renders for active rows —
// once inactive, the only path back is editing the row directly (soft
// deactivate is one-way through this UI). Req 7/T9/T11: Scan now only
// renders for a Source on a SCANNABLE_PLATFORM_TYPES platform with a
// configured connectorConfig — every other Source is ineligible for an
// automated scan and shows no button at all.
export function SourceRow({ source, onEdit, onDeactivate, onScan, scanningSourceId }: SourceRowProps) {
  const canScan = SCANNABLE_PLATFORM_TYPES.includes(source.platformType) && source.connectorConfig !== null;
  const isScanning = scanningSourceId === source.id;
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
      <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
        {formatLastScanned(source.lastScannedAt, source.lastScanFoundCount)}
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-right">
        {canScan && (
          <Button variant="ghost" size="sm" onClick={() => onScan(source)} disabled={isScanning}>
            {isScanning ? 'Scanning…' : 'Scan now'}
          </Button>
        )}
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
