import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

// shadcn/ui base Button variants: visual style (`variant`) and sizing
// (`size`), composed via class-variance-authority so screens can pick a
// combination with `<Button variant="outline" size="sm" />` instead of
// hand-writing Tailwind classes per call site.
const buttonVariants = cva(
  'inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        // `bg-save`/`bg-cancel` rather than `bg-primary`/`bg-background`
        // directly: both equal the primary/background tokens in light mode
        // (no visual change there), but in dark mode they're toned down —
        // see index.css's `--save`/`--cancel` comment — so a Save button
        // isn't pure white and a Cancel button isn't pure black. Scoped to
        // these two variants only; `--primary` itself (and therefore
        // `text-primary` links elsewhere) is untouched.
        default: 'bg-save text-save-foreground shadow hover:bg-save/90',
        destructive: 'bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90',
        outline: 'border border-input bg-cancel shadow-sm hover:bg-accent hover:text-accent-foreground',
        secondary: 'bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 rounded-md px-3 text-xs',
        lg: 'h-10 rounded-md px-8',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  // When true, renders the single child element instead of a <button>,
  // passing button classes/props through via Radix's Slot — lets a caller
  // style a <Link> or <a> as a button without nesting interactive elements.
  asChild?: boolean;
}

// Standard shadcn/ui Button: a styled <button> (or, with `asChild`, its
// child element) wired to the variant/size classes above. Forwards `ref` so
// callers can focus it imperatively (e.g. after a form error).
const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot : 'button';
  return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
});
Button.displayName = 'Button';

export { Button, buttonVariants };
