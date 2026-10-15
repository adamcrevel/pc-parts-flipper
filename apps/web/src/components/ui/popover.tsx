import * as React from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { cn } from '@/lib/utils';

// shadcn/ui-style Popover primitives: thin, styled re-exports of
// @radix-ui/react-popover's own parts, named to match the rest of this
// directory (Card, Dialog, Collapsible) so callers import them the same way.
// Radix already owns positioning, click-outside-to-close, focus management,
// and the ARIA wiring (role="dialog", aria-modal on content) — these
// wrappers add only this project's surface styling via the shared `cn`
// helper and its animate-in/out keyframes (tailwindcss-animate, already a
// dependency).
//
// PopoverContent is styled consistently with DialogContent: same
// animate-in/out keyframe classes, same border/background/shadow matching
// this project's existing card/dialog surface styling. Callers compose
// padding, sizing, and internal layout via `className`.
const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;
const PopoverAnchor = PopoverPrimitive.Anchor;

const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = 'center', sideOffset = 4, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      className={cn(
        'z-50 w-72 rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
        className,
      )}
      {...props}
    />
  </PopoverPrimitive.Portal>
));
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

export { Popover, PopoverTrigger, PopoverAnchor, PopoverContent };
