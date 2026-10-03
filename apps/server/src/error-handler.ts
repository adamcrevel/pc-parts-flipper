import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyTypeProvider,
  FastifyTypeProviderDefault,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerBase,
  RawServerDefault,
} from 'fastify';
import { logger } from './logger.js';

/**
 * Application-level error carrying an explicit HTTP status code. Route
 * handlers (T5+) throw this for expected failure cases — e.g. Requirement 13's
 * "reject save on blank required/negative monetary fields with inline error" —
 * so the centralized handler below can respond with the right status and a
 * message safe to show the user, instead of every route reimplementing that
 * mapping itself.
 */
export class AppError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
  }
}

// Shape of the consistent JSON error body every failed request gets back,
// regardless of what threw.
interface ErrorResponseBody {
  error: {
    message: string;
    statusCode: number;
  };
}

// Narrows an unknown thrown value down to "has a numeric statusCode", which
// covers both AppError and Fastify's own validation/HTTP errors without
// needing to import Fastify's internal error types.
function hasStatusCode(err: unknown): err is { statusCode: number } {
  if (typeof err !== 'object' || err === null || !('statusCode' in err)) {
    return false;
  }
  // TS narrows `err` to include a `statusCode` key via the `in` check above,
  // but its value type is still `unknown` until confirmed numeric here.
  return typeof err.statusCode === 'number';
}

/**
 * Registers Fastify's centralized error handler on the given server instance.
 * Every error thrown from any route handler or hook funnels through here:
 * it is logged once at Error level (unrecoverable, per the logging
 * convention — by the time a handler throws, the request has already
 * failed) and converted to the consistent `{ error: { message, statusCode } }`
 * JSON shape later route-handling tasks (T5+) can rely on for validation
 * errors and other expected failures.
 */
export function registerErrorHandler<
  RawServer extends RawServerBase = RawServerDefault,
  RawRequestType extends RawRequestDefaultExpression<RawServer> = RawRequestDefaultExpression<RawServer>,
  RawReplyType extends RawReplyDefaultExpression<RawServer> = RawReplyDefaultExpression<RawServer>,
  Logger extends FastifyBaseLogger = FastifyBaseLogger,
  TypeProvider extends FastifyTypeProvider = FastifyTypeProviderDefault,
>(server: FastifyInstance<RawServer, RawRequestType, RawReplyType, Logger, TypeProvider>): void {
  server.setErrorHandler((err: unknown, request, reply) => {
    // Fastify's built-in schema-validation errors and AppError both carry a
    // statusCode; anything else (unexpected bugs, thrown non-Fastify errors)
    // is treated as a 500. `isUnexpected` distinguishes "this error already
    // carries its own intentional, client-safe statusCode/message" (AppError,
    // Fastify validation) from "this is a genuine unhandled failure" (a raw
    // DuckDB/native error, a bug) — only the latter gets its message masked
    // before it reaches the client.
    const isUnexpected = !hasStatusCode(err);
    const statusCode = isUnexpected ? 500 : err.statusCode;
    const realMessage = err instanceof Error ? err.message : 'Internal server error';

    logger.error(
      { err, statusCode, url: request.url, method: request.method },
      'Request failed',
    );

    // Unexpected errors (DuckDB/native errors, uncaught bugs) can carry
    // internal schema/path detail in their message — never forward that to
    // the client. AppError and Fastify validation errors already carry a
    // message that was written to be client-safe, so those pass through
    // unchanged.
    const message = isUnexpected ? 'Internal server error' : realMessage;

    const body: ErrorResponseBody = { error: { message, statusCode } };
    reply.status(statusCode).send(body);
  });
}
