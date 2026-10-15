// @vitest-environment jsdom
//
// T4: direct unit coverage for the three generic filter bodies
// (src/features/listings/filter-content.tsx) a column header's popover can
// render. Each is mounted on its own — not through FilterableHeader and not
// through the Listings page (that is T5's scope) — proving the controlled
// contract each one promises: every edit reports the column's whole new
// value up, and Clear reports that column's empty value and nothing else.
// Follows expected-parts-editor.test.tsx's react-dom/client + act() pattern
// (no RTL in this workspace).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { EnumFilterContent, NumberRangeFilterContent, TextFilterContent } from '../src/features/listings/filter-content';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
});

async function mount(element: React.ReactElement): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(element);
  });
  return container;
}

function setValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  if (setter) {
    setter.call(input, value);
  } else {
    input.value = value;
  }
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
  });
}

function clearButtons(el: HTMLElement): HTMLButtonElement[] {
  return (Array.from(el.querySelectorAll('button')) as HTMLButtonElement[]).filter((b) => b.textContent === 'Clear');
}

function checkboxes(el: HTMLElement): HTMLInputElement[] {
  return (Array.from(el.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[]);
}

describe('TextFilterContent', () => {
  it('renders the current value and reports the typed string on every keystroke', async () => {
    const onChange = vi.fn();
    const el = await mount(<TextFilterContent label="Title" value="rt" onChange={onChange} />);

    const input = el.querySelector('input[type="text"]') as HTMLInputElement;
    expect(input.value).toBe('rt');
    expect(el.textContent).toContain('Title');

    await act(async () => {
      setValue(input, 'rtx 30');
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('rtx 30');
  });

  it('reports the empty string when its own Clear is clicked', async () => {
    const onChange = vi.fn();
    const el = await mount(<TextFilterContent label="Title" value="rtx" onChange={onChange} />);

    await click(clearButtons(el)[0]);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('');
  });
});

describe('EnumFilterContent', () => {
  const options = [
    { value: 'open', label: 'Open' },
    { value: 'accepted', label: 'Accepted' },
    { value: 'rejected', label: 'Rejected' },
  ];

  it('renders one checkbox per caller-supplied option, checked exactly for the values passed in', async () => {
    const el = await mount(<EnumFilterContent label="Status" options={options} value={['accepted']} onChange={() => {}} />);

    const boxes = checkboxes(el);
    expect(boxes).toHaveLength(3);
    expect(boxes.map((b) => b.checked)).toEqual([false, true, false]);
    expect(Array.from(el.querySelectorAll('label')).map((l) => l.textContent)).toEqual(['Open', 'Accepted', 'Rejected']);
  });

  it('reports the whole checked set, in option order, when an unchecked box is checked', async () => {
    const onChange = vi.fn();
    const el = await mount(<EnumFilterContent label="Status" options={options} value={['rejected']} onChange={onChange} />);

    await click(checkboxes(el)[0]);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(['open', 'rejected']);
  });

  it('reports an empty set when the last checked box is unchecked', async () => {
    const onChange = vi.fn();
    const el = await mount(<EnumFilterContent label="Status" options={options} value={['accepted']} onChange={onChange} />);

    await click(checkboxes(el)[1]);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('reports an empty set when its own Clear is clicked, leaving a sibling filter untouched', async () => {
    const onStatusChange = vi.fn();
    const onSourceChange = vi.fn();
    const el = await mount(
      <>
        <div data-testid="status">
          <EnumFilterContent label="Status" options={options} value={['open', 'accepted']} onChange={onStatusChange} />
        </div>
        <div data-testid="source">
          <EnumFilterContent label="Source" options={[{ value: 's1', label: 'Source One' }]} value={['s1']} onChange={onSourceChange} />
        </div>
      </>,
    );

    const statusClear = clearButtons(el.querySelector('[data-testid="status"]') as HTMLElement)[0];
    await click(statusClear);

    expect(onStatusChange).toHaveBeenCalledTimes(1);
    expect(onStatusChange).toHaveBeenCalledWith([]);
    expect(onSourceChange).not.toHaveBeenCalled();
  });
});

describe('NumberRangeFilterContent', () => {
  function bounds(el: HTMLElement): HTMLInputElement[] {
    return Array.from(el.querySelectorAll('input[type="number"]')) as HTMLInputElement[];
  }

  it('labels its two inputs Min and Max and shows the bounds currently applied', async () => {
    const el = await mount(<NumberRangeFilterContent label="Asking Price" value={{ min: 10, max: 200 }} onChange={() => {}} />);

    expect(Array.from(el.querySelectorAll('label')).map((l) => l.textContent)).toEqual(['Min', 'Max']);
    expect(bounds(el).map((i) => i.value)).toEqual(['10', '200']);
  });

  it('reports the new minimum with the existing maximum carried over', async () => {
    const onChange = vi.fn();
    const el = await mount(<NumberRangeFilterContent label="Asking Price" value={{ max: 200 }} onChange={onChange} />);

    await act(async () => {
      setValue(bounds(el)[0], '25');
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ min: 25, max: 200 });
  });

  it('reports the new maximum with the existing minimum carried over', async () => {
    const onChange = vi.fn();
    const el = await mount(<NumberRangeFilterContent label="Asking Price" value={{ min: 25 }} onChange={onChange} />);

    await act(async () => {
      setValue(bounds(el)[1], '400');
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ min: 25, max: 400 });
  });

  it('reports an unset bound (not 0) when one side is emptied, keeping the other', async () => {
    const onChange = vi.fn();
    const el = await mount(<NumberRangeFilterContent label="Expected Profit" value={{ min: 25, max: 400 }} onChange={onChange} />);

    await act(async () => {
      setValue(bounds(el)[0], '');
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ min: undefined, max: 400 });
  });

  it('reports a negative minimum as typed rather than discarding it', async () => {
    const onChange = vi.fn();
    const el = await mount(<NumberRangeFilterContent label="Expected Profit" value={{}} onChange={onChange} />);

    await act(async () => {
      setValue(bounds(el)[0], '-50');
    });

    expect(onChange).toHaveBeenCalledWith({ min: -50 });
  });

  it('reports both bounds unset when its own Clear is clicked', async () => {
    const onChange = vi.fn();
    const el = await mount(<NumberRangeFilterContent label="Asking Price" value={{ min: 25, max: 400 }} onChange={onChange} />);

    await click(clearButtons(el)[0]);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({});
  });
});
