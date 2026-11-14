// THE ONLY module in apps/server allowed to construct a DuckDB
// instance/connection (standing check: "All DuckDB access is confined to one
// data-access module"). Enforced by the no-restricted-imports override in
// the root eslint.config.mjs, which blocks `@duckdb/node-api` imports
// everywhere under apps/server/src/ except this db/ directory — the data-
// access module as a whole, which the other files here (sales.ts, etc.) may
// also import for value-construction helpers like listValue(). Every file
// outside db/ must call getConnection() (or a query function) from here,
// never DuckDBInstance.create() directly.
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from './migrate.js';

// apps/server/src/db/client.ts -> apps/server/src/db -> apps/server/src ->
// apps/server -> apps -> <worktree root>. The compiled apps/server/dist/db/
// tree mirrors this same depth, so the same four `..` segments resolve
// correctly whether this runs via tsx (from src) or node (from dist).
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = path.resolve(moduleDir, '../../../../data');

// Allows tests/tooling to point at an isolated database file without
// touching the shared dev database (assumption A4: file lives under the
// gitignored data/ directory, never in source control).
const DATA_DIR = process.env.DUCKDB_DATA_DIR ?? DEFAULT_DATA_DIR;
const DB_PATH = path.join(DATA_DIR, 'pc-parts-flipper.duckdb');

// Module-level singleton: per assumption A7, exactly one Fastify process
// opens this file, so one lazily-created connection, reused for the life of
// the process, is sufficient — no pool is needed for a single-user local
// app. However, the DuckDB node binding's `run`/`runAndReadAll` calls share
// mutable prepared-statement state on a single DuckDBConnection; firing two
// of them concurrently on the same connection races and corrupts that
// state (observed as intermittent HTTP 500s under real concurrent load —
// see T14's concurrency.test.ts). getConnection() below wraps the raw
// connection in a serializing proxy so every run/runAndReadAll call queues
// behind the previous one instead of interleaving.
let connectionPromise: Promise<DuckDBConnection> | null = null;

// Companion to connectionPromise: the underlying DuckDBInstance that owns
// the open database file handle. DuckDBConnection has no way to reach back
// to the DuckDBInstance that created it, so closeConnection() below needs
// this separate reference to close the instance itself once the connection
// is done. Set alongside connectionPromise in initializeConnection, cleared
// alongside it in closeConnection.
let dbInstance: DuckDBInstance | null = null;

// Module-scoped (not local to serializeConnection) so closeConnection()
// below can await the full FIFO queue — not just its own CHECKPOINT call —
// before disconnecting. A single shared connection only ever needs one
// queue for its lifetime, so one module-level tail is sufficient; scoping
// it inside serializeConnection instead would hide it from closeConnection,
// leaving a gap where a run/runAndReadAll call enqueued concurrently with
// shutdown is still waiting its turn in the queue when disconnectSync()
// fires on the now-closing connection.
let queueTail: Promise<unknown> = Promise.resolve();

// Set only by the real process-shutdown sequence (index.ts's
// gracefulShutdown, via beginShutdown() below) — NOT by every
// closeConnection() call. Several test files in apps/server/test/ call
// closeConnection() mid-run to release a seeding connection before
// spawning a separate server process against the same data directory,
// then later call getConnection() again in THIS process (e.g.
// pricePartsConcurrency.test.ts reopens after the spawned server stops,
// to read back final state) — that reopen is a legitimate, non-shutdown
// reuse of the module and must keep working. Only a caller that has
// explicitly called beginShutdown() (the real shutdown path) should have
// getConnection() refuse to lazily reopen a fresh DuckDBInstance/rerun
// migrations afterward.
let shuttingDown = false;

/**
 * Marks the shutdown sequence as started. After this call, getConnection()
 * refuses to open a fresh connection (it would otherwise silently reopen
 * the database file and rerun every migration if called after
 * closeConnection() has already nulled out connectionPromise — see
 * getConnection()'s own doc). index.ts's gracefulShutdown() calls this
 * before closeConnection() so a price/identify job that is still mid-
 * flight (e.g. awaiting the AI runner, not yet at any run/runAndReadAll
 * call) cannot slip a getConnection() call in after the connection has
 * started closing. There is no matching "end shutdown" reset: once a real
 * process shutdown begins, the process exits shortly after, so the flag
 * never needs to flip back.
 */
export function beginShutdown(): void {
  shuttingDown = true;
}

/**
 * Wraps `connection` so calls to `run`/`runAndReadAll` — the only two
 * methods any query module in this codebase invokes (see queries/*.ts and
 * migrate.ts) — are serialized through a single FIFO queue, regardless of
 * how many concurrent callers invoke getConnection(). Each call still waits
 * for its own result and still throws/rejects as normal; only the ordering
 * of calls against the underlying connection is constrained. Other methods
 * pass through untouched.
 */
function serializeConnection(connection: DuckDBConnection): DuckDBConnection {
  const SERIALIZED_METHODS: Record<string, true> = { run: true, runAndReadAll: true };
  return new Proxy(connection, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== 'string' || !SERIALIZED_METHODS[prop] || typeof value !== 'function') {
        return value;
      }
      return (...args: unknown[]) => {
        // Chain this call after whatever is already queued, so two
        // concurrent requests never have both calls in flight on the
        // underlying connection at once. The queue itself must never
        // reject (a rejected tail would permanently wedge the queue), so
        // the tracked tail swallows errors while the returned promise
        // still carries the real result/rejection back to the caller.
        const call = queueTail.then(
          () => (value as (...fnArgs: unknown[]) => unknown).apply(target, args),
        );
        queueTail = call.then(
          () => undefined,
          () => undefined,
        );
        return call;
      };
    },
  }) as DuckDBConnection;
}

/**
 * Returns the shared DuckDB connection for this process, creating the
 * database file and running migrations on first call. Every exported query
 * function in this module's sibling files (sources.ts, listings.ts, etc.)
 * calls this instead of touching DuckDB directly. The returned connection
 * is wrapped so concurrent callers queue rather than race (see
 * serializeConnection above).
 *
 * Rejects without opening anything once beginShutdown() has been called
 * (real process shutdown in progress) — otherwise a caller mid-flight when
 * shutdown starts (e.g. a price job awaiting the AI runner, not yet at any
 * run/runAndReadAll call) could reach this after closeConnection() has
 * already nulled connectionPromise, silently reopening a fresh
 * DuckDBInstance and rerunning every migration on a database the process
 * is in the middle of shutting down.
 */
export function getConnection(): Promise<DuckDBConnection> {
  if (shuttingDown) {
    return Promise.reject(
      new Error('cannot open database connection: shutdown already in progress'),
    );
  }
  connectionPromise ??= initializeConnection();
  return connectionPromise;
}

/**
 * Flushes and closes the shared DuckDB connection/instance opened by
 * getConnection(), if one was ever created.
 *
 * Why this exists: DuckDB only flushes writes into the main .duckdb file at
 * a checkpoint; in between, they live in a separate .duckdb.wal file that
 * gets replayed on the next open. If this process is killed (e.g. by an
 * unhandled SIGTERM, whose default action is immediate termination) while
 * that WAL file has any uncheckpointed writes in it, the next startup's WAL
 * replay can fail outright ("Calling DatabaseManager::GetDefaultDatabase
 * with no default database set"), leaving every DB-touching request 500ing
 * until the stale .duckdb.wal file is deleted by hand — losing all data
 * back to the last checkpoint. Running CHECKPOINT before close flushes the
 * WAL into the main file so there is nothing left to replay; index.ts's
 * SIGTERM/SIGINT handlers call this during graceful shutdown specifically
 * to prevent that corruption.
 *
 * Safe to call even if no connection was ever created (e.g. the process
 * was killed before any request arrived) — a no-op in that case.
 */
export async function closeConnection(): Promise<void> {
  if (!connectionPromise) {
    return;
  }
  const connection = await connectionPromise;
  await connection.run('CHECKPOINT');
  // connection.run('CHECKPOINT') above only waits for the CHECKPOINT
  // operation itself to settle; by the time it resolves, the module-level
  // queueTail has already advanced past it, but anything enqueued
  // *concurrently* with this shutdown (after CHECKPOINT was enqueued but
  // before it ran) would still be chained behind it and not yet started.
  // Awaiting the queue's current tail here closes that gap, so
  // disconnectSync() below never fires while a still-queued
  // run/runAndReadAll call is waiting its turn on this connection.
  await queueTail;
  connection.disconnectSync();
  dbInstance?.closeSync();
  connectionPromise = null;
  dbInstance = null;
}

// Creates the data directory if missing, opens (or creates) the DuckDB file,
// and applies every pending migration before handing back the connection.
// Migrations run through the same serializing wrapper every other caller
// uses (wrap first, migrate second) rather than on the raw connection, so
// migrate.ts's statements queue identically to every other run/
// runAndReadAll call instead of bypassing the proxy — there is no code
// path left that touches this connection without going through the queue.
async function initializeConnection(): Promise<DuckDBConnection> {
  await mkdir(DATA_DIR, { recursive: true });
  // Info: trace connection target. T3's pino logger supersedes this console
  // call once the data-access module is wired into the live server.
  console.log(`[db] opening DuckDB file at ${DB_PATH}`);
  const instance = await DuckDBInstance.create(DB_PATH);
  const connection = await instance.connect();
  const wrapped = serializeConnection(connection);
  await runMigrations(wrapped);
  dbInstance = instance;
  return wrapped;
}

