import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

// Standard shadcn/ui class-name helper: merges conditional class lists
// (clsx) and resolves conflicting Tailwind utility classes (tailwind-merge).
// Every generated shadcn component imports this.
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
