import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { PartSummary } from '@pc-parts-flipper/shared';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { PartUnsellableForm } from '@/features/parts/part-unsellable-form';

// Visual treatment per Part status, so the list is scannable at a glance —
// emerald for the sold terminal state, amber for in-flight listed, red for
// the unsellable side-branch, neutral for the starting ready_to_list state.
const STATUS_BADGE_CLASSES: Record<PartSummary['status'], string> = {
  ready_to_list: 'border-border text-muted-foreground',
  listed: 'border-amber-600 bg-amber-600/10 text-amber-700',
  sold: 'border-emerald-600 bg-emerald-600/10 text-emerald-700',
  unsellable: 'border-destructive bg-destructive/10 text-destructive',
};
const STATUS_LABELS: Record<PartSummary['status'], string> = {
  ready_to_list: 'Ready to List',
  listed: 'Listed',
  sold: 'Sold',
  unsellable: 'Unsellable',
};

interface PartsTableProps {
  parts: PartSummary[];
  onMarkUnsellable: (id: string, reason: string) => Promise<void>;
}

/**
 * The Parts list table: category, description, status badge, the owning
 * Purchase's Listing title, and — for `ready_to_list` rows only — a "Mark
 * Unsellable" action that opens an inline required-reason form (Req 7, 13)
 * plus a "Prepare Sale Listing" action that navigates to T11's Sale
 * Listing draft flow (Req 8), which is what actually drives the
 * `ready_to_list -> listed` transition. `listed` rows instead show a
 * "Record Sale" action that navigates to T12's Sale-recording form, which
 * drives the `listed -> sold` transition (Req 7, 9).
 */
export function PartsTable({ parts, onMarkUnsellable }: PartsTableProps) {
  const [openRowId, setOpenRowId] = useState<string | null>(null);
  const navigate = useNavigate();

  if (parts.length === 0) {
    return <p className="text-sm text-muted-foreground">No parts match the current filter.</p>;
  }

  async function handleConfirm(id: string, reason: string) {
    await onMarkUnsellable(id, reason);
    setOpenRowId(null);
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-border text-muted-foreground">
            <th className="px-4 py-2 font-medium">Category</th>
            <th className="px-4 py-2 font-medium">Description</th>
            <th className="px-4 py-2 font-medium">Status</th>
            <th className="px-4 py-2 font-medium">Listing</th>
            <th className="px-4 py-2 font-medium" />
          </tr>
        </thead>
        <tbody>
          {parts.map((part) => (
            <tr key={part.id} className="border-b border-border last:border-0 align-top">
              <td className="px-4 py-3 font-medium">{part.category}</td>
              <td className="px-4 py-3">{part.description}</td>
              <td className="px-4 py-3">
                <span className={cn('inline-block rounded-full border px-3 py-1 text-xs font-medium', STATUS_BADGE_CLASSES[part.status])}>
                  {STATUS_LABELS[part.status]}
                </span>
                {part.status === 'unsellable' && part.unsellableReason && (
                  <p className="mt-1 max-w-xs text-xs text-muted-foreground">{part.unsellableReason}</p>
                )}
              </td>
              <td className="px-4 py-3">{part.purchase.listingTitle}</td>
              <td className="px-4 py-3 text-right">
                {part.status === 'ready_to_list' && openRowId !== part.id && (
                  <div className="flex justify-end gap-2">
                    <Button type="button" size="sm" onClick={() => navigate(`/sale-listings/new/${part.id}`)}>
                      Prepare Sale Listing
                    </Button>
                    <Button type="button" size="sm" variant="outline" onClick={() => setOpenRowId(part.id)}>
                      Mark Unsellable
                    </Button>
                  </div>
                )}
                {part.status === 'listed' && (
                  <Button type="button" size="sm" onClick={() => navigate(`/record-sale/${part.id}`)}>
                    Record Sale
                  </Button>
                )}
                {openRowId === part.id && (
                  <PartUnsellableForm onSubmit={(reason) => handleConfirm(part.id, reason)} onCancel={() => setOpenRowId(null)} />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
