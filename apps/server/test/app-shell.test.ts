// T3 proof: Fastify app shell (src/index.ts), structured logger (logger.ts),
// and centralized error-handling middleware (error-handler.ts).
//
// Boots the *real* server as a child process via helpers.ts's
// startTestServer (same pattern T14's concurrency.test.ts uses — src/
// index.ts has no exported build function, it listens as a side effect of
// being imported, so there is no in-process bootstrap available without
// changing production code) and asserts two things about
// registerErrorHandler (error-handler.ts):
//
//   1. A route that throws AppError (POST /api/sources with a blank
//      required field — sources.ts's validateSourceInput, Requirement 13)
//      returns the documented `{ error: { message, statusCode } }` JSON
//      shape at AppError's own statusCode, not a generic 500.
//   2. A route that throws an *unexpected* error (GET /api/listings with a
//      non-numeric `limit` query param — listings.ts's `Number(limit)`
//      produces NaN, which DuckDB's driver rejects at bind time with a raw
//      `Conversion Error`, never an AppError) is still caught by the
//      centralized handler: the server responds with a 5xx instead of
//      crashing, and keeps serving later requests.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getJson, postJson, startTestServer, type TestServer } from './helpers.js';

// Arbitrary high port distinct from concurrency.test.ts's 34_591, so this
// suite can run standalone or alongside it without a port conflict.
const TEST_PORT = 34_601;

describe('app shell error handling (T3)', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer(TEST_PORT);
  }, 30_000);

  afterAll(async () => {
    await server.stop();
  }, 30_000);

  it('returns the AppError status/JSON shape when a route throws AppError', async () => {
    // POST /api/sources with no body at all fails validateSourceInput's
    // first check (blank `name`), which throws `new AppError('name is
    // required', 400)`.
    const res = await postJson<{ error: { message: string; statusCode: number } }>(
      `${server.baseUrl}/api/sources`,
      {},
    );

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'name is required', statusCode: 400 } });
  });

  it('catches an unexpected (non-AppError) thrown error without crashing the server', async () => {
    // GET /api/listings?limit=notanumber: listings.ts's route handler does
    // `limit !== undefined ? Number(limit) : 20`, so a non-numeric limit
    // becomes NaN and is bound straight into the SQL `LIMIT $limit` param
    // with no validation in between. DuckDB's driver throws a raw
    // `Conversion Error` for the NaN bind — a plain Error with no
    // `statusCode` property, never an AppError. This is exactly the
    // "unexpected thrown error" case the centralized handler exists for:
    // error-handler.ts's `hasStatusCode` guard fails and falls through to
    // the 500 default.
    const res = await getJson<{ error: { message: string; statusCode: number } }>(
      `${server.baseUrl}/api/listings?limit=notanumber`,
    );

    expect(res.status).toBe(500);
    expect(res.body.error.statusCode).toBe(500);
    // The raw DuckDB error (e.g. "Conversion Error: ...") must never reach
    // the client — only the fixed, generic message is safe to show.
    expect(res.body.error.message).toBe('Internal server error');
    expect(res.body.error.message).not.toMatch(/conversion|duckdb/i);

    // The centralized handler must have recovered the request without
    // taking the process down: a later, unrelated request still succeeds.
    const health = await getJson<{ status: string }>(`${server.baseUrl}/health`);
    expect(health.status).toBe(200);
    expect(health.body).toEqual({ status: 'ok' });

    // The real error detail must still reach the operator-facing log
    // (logger.error -> pino -> stdout), even though it was masked in the
    // HTTP response above — the fix must not silence diagnosability.
    expect(server.output()).toMatch(/conversion/i);
  });
});
