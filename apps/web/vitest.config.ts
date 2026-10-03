import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Minimal vitest config for apps/web (T4's test setup — no test runner was
// wired up for this workspace before). Mirrors vite.config.ts's "@" alias so
// test files can import app-shell modules (e.g. error-boundary.tsx, which
// itself imports "@/components/error-banner") the same way the app does.
// Environment stays 'node': tests here exercise api-client's fetch error
// path and ErrorBoundary's render-time catch via react-dom/server, neither
// of which needs a browser DOM, so no jsdom/happy-dom dependency is added.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  // Matches tsconfig.app.json's "jsx": "react-jsx" so .tsx test files (e.g.
  // error-boundary.test.tsx) transform through the automatic JSX runtime
  // instead of requiring `React` in scope, same as the app's own Vite build.
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.{ts,tsx}'],
  },
});
