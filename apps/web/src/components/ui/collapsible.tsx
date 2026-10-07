import * as React from 'react';
import * as CollapsiblePrimitive from '@radix-ui/react-collapsible';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

// shadcn/ui-style Collapsible primitives: thin re-exports of
// @radix-ui/react-collapsible's own root/trigger/content, named to match
// the rest of this directory's components/ui files so callers import them
// the same way as Card or Button. Radix already owns open/close animation
// hooks (via `data-state`) and the ARIA wiring (aria-expanded,
// aria-controls) — these wrappers add nothing but the naming convention,
// so later call sites (T2/T3/T5's listing-form sections) can build on a
// stable local import path instead of reaching into @radix-ui directly.
const Collapsible = CollapsiblePrimitive.Root;
const CollapsibleTrigger = CollapsiblePrimitive.CollapsibleTrigger;
const CollapsibleContent = CollapsiblePrimitive.CollapsibleContent;

export interface CollapsibleSectionProps {
  // The trigger row's own label/content — usually a short heading, but any
  // node is accepted since callers may want to combine a title with a
  // count or badge (e.g. "Expected Parts (3)").
  trigger: React.ReactNode;
  // Controlled open state and its setter, mirroring Radix's own
  // Collapsible.Root API. Kept controlled-only (no uncontrolled
  // defaultOpen fallback) because every known caller (T2/T3/T5) already
  // owns a piece of form state it needs this section's openness to stay
  // in sync with — e.g. collapsing a section whose fields just failed
  // validation would hide the error without a controlling parent.
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // The section's body, rendered inside CollapsibleContent and therefore
  // only mounted/visible while `open` is true.
  children: React.ReactNode;
  className?: string;
  triggerClassName?: string;
  contentClassName?: string;
}

/**
 * A bordered, titled section that expands/collapses its body on click,
 * built from the Collapsible primitives above. The trigger row always
 * renders — label plus a chevron that rotates to point down when open and
 * right when closed — so the section's current state is visible even
 * before any animation finishes. The trigger row uses the `surfaceContrast`
 * background token (a darker, visually distinct gray in light mode; equal
 * to `--muted` in dark mode, so dark mode is unchanged by its introduction)
 * to set it apart from the surrounding page background.
 *
 * Fully controlled: callers pass `open`/`onOpenChange` rather than this
 * component owning its own state, so a parent form can keep a section
 * open across a failed validation pass, or collapse every section but the
 * one containing an error.
 */
function CollapsibleSection({ trigger, open, onOpenChange, children, className, triggerClassName, contentClassName }: CollapsibleSectionProps) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className={cn('rounded-md border', className)}>
      <CollapsibleTrigger
        className={cn(
          'flex w-full items-center justify-between gap-2 rounded-t-md bg-surfaceContrast px-4 py-2 text-left text-sm font-medium transition-colors hover:bg-surfaceContrast/80',
          !open && 'rounded-b-md',
          triggerClassName,
        )}
      >
        <span>{trigger}</span>
        <ChevronDown className={cn('h-4 w-4 shrink-0 transition-transform duration-200', open ? 'rotate-0' : '-rotate-90')} aria-hidden="true" />
      </CollapsibleTrigger>
      <CollapsibleContent className={cn('px-4 py-3', contentClassName)}>{children}</CollapsibleContent>
    </Collapsible>
  );
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent, CollapsibleSection };
