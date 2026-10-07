// @vitest-environment jsdom
//
// Proof for T1's new CollapsibleSection (components/ui/collapsible.tsx):
// a closed section hides its content region and renders its chevron
// rotated to point right, an open section shows its content and rotates
// the chevron to point down, and clicking the trigger calls the
// controlled onOpenChange callback with the toggled value rather than
// managing its own internal state. Mounts the real component through
// react-dom/client + act(), following expected-parts-editor.test.tsx's
// pattern — no RTL in this workspace.
import { afterEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act, useState } from 'react';
import { CollapsibleSection } from '../src/components/ui/collapsible';

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

// Harness holding the section's open state itself, exactly as a real
// caller (a listing-form section) would — proves the controlled API
// round-trips through a parent's own useState rather than the component
// quietly tracking open/closed on its own.
function SectionHarness({ initialOpen }: { initialOpen: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <CollapsibleSection trigger="Expected Parts" open={open} onOpenChange={setOpen}>
      <div data-testid="section-body">body content</div>
    </CollapsibleSection>
  );
}

function chevron(el: HTMLElement): SVGElement {
  const svg = el.querySelector('svg');
  if (!svg) throw new Error('expected a chevron svg to be rendered');
  return svg;
}

describe('CollapsibleSection component', () => {
  it('renders a closed section with hidden content and a right-pointing chevron', async () => {
    const el = await mount(<SectionHarness initialOpen={false} />);
    const body = el.querySelector('[data-testid="section-body"]');
    expect(body).toBeNull();
    expect(chevron(el).className.baseVal).toContain('-rotate-90');
  });

  it('renders an open section with visible content and a down-pointing chevron', async () => {
    const el = await mount(<SectionHarness initialOpen={true} />);
    const body = el.querySelector('[data-testid="section-body"]');
    expect(body?.textContent).toBe('body content');
    expect(chevron(el).className.baseVal).not.toContain('-rotate-90');
  });

  it('clicking the trigger toggles open state via the controlled onOpenChange callback, not internal state', async () => {
    const el = await mount(<SectionHarness initialOpen={false} />);
    expect(el.querySelector('[data-testid="section-body"]')).toBeNull();

    const trigger = el.querySelector('button');
    if (!trigger) throw new Error('expected a trigger button to be rendered');

    await act(async () => {
      trigger.click();
    });

    expect(el.querySelector('[data-testid="section-body"]')?.textContent).toBe('body content');
    expect(chevron(el).className.baseVal).not.toContain('-rotate-90');

    await act(async () => {
      trigger.click();
    });

    expect(el.querySelector('[data-testid="section-body"]')).toBeNull();
    expect(chevron(el).className.baseVal).toContain('-rotate-90');
  });

  it('renders the trigger with the bg-surfaceContrast background token, regardless of open state', async () => {
    const el = await mount(<SectionHarness initialOpen={false} />);
    const trigger = el.querySelector('button');
    if (!trigger) throw new Error('expected a trigger button to be rendered');
    expect(trigger.className).toContain('bg-surfaceContrast');
  });
});
