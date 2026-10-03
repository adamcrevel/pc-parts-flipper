import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ErrorBanner } from '@/components/error-banner';

interface ErrorBoundaryProps {
  children: ReactNode;
  // Optional override shown instead of the caught error's own message —
  // useful when that message is a raw stack trace not fit for end users.
  fallbackMessage?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

// Catches render-time exceptions thrown by its subtree and shows an
// <ErrorBanner> instead of crashing the whole app shell. Convention: the app
// router (see router.tsx) wraps the <Outlet/> content with one instance of
// this at the layout level, so one broken screen shows an error banner in
// the content area while the sidebar nav stays usable — screens don't need
// to add their own boundary. Only catches render/lifecycle errors, not
// errors from event handlers or async code; those still need a try/catch
// paired with <ErrorBanner> directly.
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  // React lifecycle hook: derives the next render's state from a thrown
  // error, invoked before componentDidCatch.
  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  // Logs the caught error and its component stack for debugging;
  // componentDidCatch is the only lifecycle where React guarantees both are
  // available together.
  componentDidCatch(error: Error, info: ErrorInfo): void {
    // No browser-side logger exists yet (pino in T3 is server-only); console
    // is the only sink available client-side for this.
    console.error('[ErrorBoundary] caught render error', error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return <ErrorBanner message={this.props.fallbackMessage ?? this.state.error.message} />;
    }
    return this.props.children;
  }
}
