// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { ErrorBoundary } from '../src/components/error-boundary';

// Tells React this is an act()-aware test environment (otherwise React logs
// a "not configured to support act" warning on every render commit below).
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// A child that always throws during render, standing in for any real screen
// crashing — the scenario ErrorBoundary exists to contain. React's client
// reconciler (unlike the Fizz server renderer, whose only recoverable unit
// is a <Suspense> boundary, not an arbitrary getDerivedStateFromError class)
// is what actually honors a custom error boundary, so this test mounts with
// react-dom/client in a jsdom document rather than server-rendering.
function Bomb(): never {
  throw new Error('boom: teardown screen crashed');
}

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

// Mounts `element` into a fresh detached <div> via createRoot, inside an
// async act() so both the initial commit and React's post-error recovery
// re-render (scheduled as a separate concurrent-root task, not synchronous
// with the initial commit) flush before this returns, then hands back that
// div for assertions on its contents.
async function mount(element: React.ReactElement): Promise<HTMLDivElement> {
  container = document.createElement('div');
  await act(async () => {
    root = createRoot(container!);
    root.render(element);
  });
  return container;
}

describe('ErrorBoundary', () => {
  it('catches a thrown render error from its subtree and renders the ErrorBanner fallback instead of crashing', async () => {
    const el = await mount(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );

    const banner = el.querySelector('[role="alert"]');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toBe('boom: teardown screen crashed');
    // The crash must not have reached the DOM at all — only the fallback.
    expect(el.textContent).toBe('boom: teardown screen crashed');
  });

  it('renders children unchanged when nothing throws', async () => {
    const el = await mount(
      <ErrorBoundary>
        <div data-testid="child">all good</div>
      </ErrorBoundary>,
    );

    expect(el.querySelector('[role="alert"]')).toBeNull();
    expect(el.textContent).toBe('all good');
  });
});
