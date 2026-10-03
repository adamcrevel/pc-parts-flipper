import pino from 'pino';

// Log levels this backend recognizes, ordered loosest-to-strictest the way pino
// expects. These line up with the project's logging convention: Error
// (unrecoverable failures), Warn (recoverable issues / fallback paths taken),
// Info (minimal flow-entry tracing between functions/modules), Debug (detailed
// in-function logic tracing), Trace (raw data dumps — local use only).
const VALID_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
type ValidLevel = (typeof VALID_LEVELS)[number];

/**
 * Resolves the active log level from the LOG_LEVEL environment variable,
 * falling back to 'info' when the variable is unset or holds a value pino
 * does not recognize. Centralizing this here keeps the fallback rule in one
 * place instead of being re-implemented wherever the logger is configured.
 */
function resolveLevel(): ValidLevel {
  // Normalize so LOG_LEVEL=Debug / DEBUG / debug all resolve the same way.
  const raw = (process.env.LOG_LEVEL ?? '').toLowerCase();
  return (VALID_LEVELS as readonly string[]).includes(raw) ? (raw as ValidLevel) : 'info';
}

/**
 * The single structured logger instance for the backend. Routes and modules
 * added in later tasks (T5+) import this directly rather than constructing
 * their own pino instance, so every log line shares one level configuration
 * and output format. Passed into Fastify as `loggerInstance` in index.ts so
 * request/response logging and application logging share the same sink.
 */
export const logger = pino({
  level: resolveLevel(),
  // ISO timestamps are easier to correlate against user-entered dates
  // (listing dates, purchase dates, etc.) during manual debugging.
  timestamp: pino.stdTimeFunctions.isoTime,
});
