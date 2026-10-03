/// <reference types="vite/client" />

// Augments Vite's built-in ImportMetaEnv so `import.meta.env.VITE_API_BASE_URL`
// is typed; see src/lib/api-client.ts for where this is consumed.
interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
