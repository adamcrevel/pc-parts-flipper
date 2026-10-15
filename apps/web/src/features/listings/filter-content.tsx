import { Button } from '@/components/ui/button';

// The three filter bodies a FilterableHeader's popover can render, one per
// column *type* rather than per column: free text, a checkbox multi-select
// over caller-supplied options, and a min/max number pair. None of them
// knows anything about the Listings page — no Source list, no status enum,
// no query-param names — so every one of them is reusable by any table
// that wants the same shape of filter. The caller owns the value and
// decides what a change means (when to refetch, whether to debounce);
// these components hold no filter state of their own, exactly like the
// rest of this directory's controlled components.
//
// Clear behaviour, consistent across all three: a Clear button reports the
// column's empty value (`''`, `[]`, `{}`) and leaves the popover **open**,
// which is both the simpler implementation (a plain button, no
// PopoverClose wiring) and lets a user clear and immediately retype
// without reopening. Each Clear only ever touches its own component's
// value — it calls that component's own `onChange` and nothing else.

const INPUT_CLASS = 'w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm';

/**
 * One free-text filter input plus its Clear button. `value` is the exact
 * string the caller currently has applied, `''` meaning "no filter on this
 * column"; every keystroke reports the new string up, and Clear reports
 * `''`. Interpretation of the string (substring, case sensitivity) is the
 * caller's business, not this component's.
 */
export function TextFilterContent({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1 text-sm font-medium">
        {label}
        <input type="text" className={INPUT_CLASS} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      </label>
      <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => onChange('')}>
        Clear
      </Button>
    </div>
  );
}

/**
 * One checkbox per caller-supplied option, reporting the whole checked set
 * on every toggle. The reported array is always ordered the way `options`
 * is, so two equivalent selections never differ by click order. An empty
 * array means "no filter on this column" (not "match nothing"), so
 * unchecking the last box and clicking Clear report the same thing.
 */
export function EnumFilterContent<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T[];
  onChange: (value: T[]) => void;
}) {
  const checked = new Set(value);

  const toggle = (option: T) => {
    const next = new Set(checked);
    if (next.has(option)) {
      next.delete(option);
    } else {
      next.add(option);
    }
    onChange(options.filter((o) => next.has(o.value)).map((o) => o.value));
  };

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium">{label}</p>
      <div className="flex flex-col gap-1.5">
        {options.map((option) => (
          <label key={option.value} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={checked.has(option.value)} onChange={() => toggle(option.value)} />
            {option.label}
          </label>
        ))}
      </div>
      <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => onChange([])}>
        Clear
      </Button>
    </div>
  );
}

/**
 * An inclusive numeric range: a Min and a Max input, either or both of
 * which may be left blank meaning "no bound on that side". A blank (or
 * unparseable, e.g. mid-typed `-`) input reports `undefined` for that side
 * rather than `0`, so "no lower bound" is never confused with "at least
 * zero"; Clear reports `{}`, both bounds unset.
 */
export function NumberRangeFilterContent({
  label,
  value,
  onChange,
}: {
  label: string;
  value: { min?: number; max?: number };
  onChange: (value: { min?: number; max?: number }) => void;
}) {
  // An empty string is the only way the DOM can say "no bound"; anything
  // else that doesn't parse to a finite number (a lone `-`, `e`) is
  // treated the same way rather than reported as NaN.
  const parse = (raw: string): number | undefined => {
    if (raw.trim() === '') return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium">{label}</p>
      <div className="flex items-center gap-2">
        <label className="flex flex-1 flex-col gap-1 text-xs text-muted-foreground">
          Min
          <input type="number" className={INPUT_CLASS} value={value.min ?? ''} onChange={(e) => onChange({ ...value, min: parse(e.target.value) })} />
        </label>
        <label className="flex flex-1 flex-col gap-1 text-xs text-muted-foreground">
          Max
          <input type="number" className={INPUT_CLASS} value={value.max ?? ''} onChange={(e) => onChange({ ...value, max: parse(e.target.value) })} />
        </label>
      </div>
      <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => onChange({})}>
        Clear
      </Button>
    </div>
  );
}
