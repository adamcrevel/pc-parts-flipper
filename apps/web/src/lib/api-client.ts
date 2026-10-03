// Typed fetch wrapper for calling the apps/server Fastify API. Resource-specific
// modules (added by T5-T13, e.g. a future src/lib/api/sources.ts) build on
// `apiClient` below instead of calling `fetch` directly, so every HTTP call in
// the app shares one base URL, one JSON (de)serialization path, and one error
// shape (ApiError). Once packages/shared exports real domain types (Source,
// Listing, Purchase, Part, ...), callers import them here as the `TResponse`
// generic, e.g. `apiClient.get<Source[]>('/api/sources')`.

// Base URL for the backend API. Overridable via VITE_API_BASE_URL (see
// src/vite-env.d.ts) for non-default deployments; defaults to the local
// Fastify dev server started by T3's app shell.
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3001';

// Thrown by apiRequest when the backend responds with a non-2xx status, so
// callers can distinguish a reachable-but-rejecting API from a network
// failure and surface `message` in an ErrorBanner.
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface RequestOptions {
  method?: HttpMethod;
  body?: unknown;
  signal?: AbortSignal;
}

// Parses JSON, returning the raw text instead of throwing when the body isn't
// valid JSON (e.g. an HTML error page from a proxy in front of the API) — this
// keeps apiRequest's error path informative rather than masking a non-JSON
// backend response with an unrelated SyntaxError.
function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// Reads a Response's body once as text, attempts JSON parsing, and throws
// ApiError on any non-2xx status — shared by apiRequest (JSON bodies) and
// apiRequestForm (multipart bodies) below so both error paths agree on the
// same `{ error: { message, statusCode } }` shape the backend's centralized
// error handler (apps/server/src/error-handler.ts) sends.
async function parseResponse<TResponse>(path: string, response: Response): Promise<TResponse> {
  // Read the body once as text, then attempt JSON parsing — some error
  // responses (e.g. a 502 from a proxy) are never JSON at all.
  const rawText = await response.text();
  const parsed = rawText.length > 0 ? safeJsonParse(rawText) : undefined;

  if (!response.ok) {
    // Prefer the message field the backend's centralized error handler sends;
    // fall back to a generic message so ApiError always has something
    // displayable even for a non-JSON/unexpected error body.
    const backendMessage = (parsed as { error?: { message?: string } } | undefined)?.error?.message;
    throw new ApiError(response.status, parsed, backendMessage ?? `Request to ${path} failed with status ${response.status}`);
  }

  return parsed as TResponse;
}

// Core request function every JSON HTTP verb helper below delegates to.
// Serializes `body` as JSON when present and parses the response via
// parseResponse so callers can rely on try/catch instead of checking
// `response.ok` themselves on every call site.
async function apiRequest<TResponse>(path: string, options: RequestOptions = {}): Promise<TResponse> {
  const { method = 'GET', body, signal } = options;
  const hasBody = body !== undefined;

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    signal,
    headers: hasBody ? { 'Content-Type': 'application/json' } : undefined,
    body: hasBody ? JSON.stringify(body) : undefined,
  });

  return parseResponse<TResponse>(path, response);
}

// POSTs a FormData body (e.g. file uploads, used by the listing photo
// endpoint) rather than JSON. Deliberately omits a Content-Type header —
// the browser sets `multipart/form-data; boundary=...` itself, which
// apiRequest's fixed `application/json` header would otherwise override.
async function apiRequestForm<TResponse>(path: string, formData: FormData, signal?: AbortSignal): Promise<TResponse> {
  const response = await fetch(`${API_BASE_URL}${path}`, { method: 'POST', body: formData, signal });
  return parseResponse<TResponse>(path, response);
}

// Typed GET/POST/PUT/PATCH/DELETE helpers that resource-specific API modules
// call instead of apiRequest directly. `TResponse` is the expected decoded
// JSON shape for a successful response.
export const apiClient = {
  get: <TResponse>(path: string, signal?: AbortSignal): Promise<TResponse> => apiRequest<TResponse>(path, { method: 'GET', signal }),
  post: <TResponse>(path: string, body?: unknown, signal?: AbortSignal): Promise<TResponse> =>
    apiRequest<TResponse>(path, { method: 'POST', body, signal }),
  put: <TResponse>(path: string, body?: unknown, signal?: AbortSignal): Promise<TResponse> =>
    apiRequest<TResponse>(path, { method: 'PUT', body, signal }),
  patch: <TResponse>(path: string, body?: unknown, signal?: AbortSignal): Promise<TResponse> =>
    apiRequest<TResponse>(path, { method: 'PATCH', body, signal }),
  delete: <TResponse>(path: string, signal?: AbortSignal): Promise<TResponse> => apiRequest<TResponse>(path, { method: 'DELETE', signal }),
  postForm: <TResponse>(path: string, formData: FormData, signal?: AbortSignal): Promise<TResponse> =>
    apiRequestForm<TResponse>(path, formData, signal),
};
