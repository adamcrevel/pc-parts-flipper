import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { logger } from './logger.js';
import { registerErrorHandler } from './error-handler.js';
import { registerSourcesRoutes } from './routes/sources.js';
import { registerListingsRoutes } from './routes/listings.js';
import { registerPurchasesRoutes } from './routes/purchases.js';
import { registerTeardownRoutes } from './routes/teardown.js';
import { registerPartsRoutes } from './routes/parts.js';
import { registerSaleListingsRoutes } from './routes/saleListings.js';
import { registerSalesRoutes } from './routes/sales.js';
import { registerProfitRoutes } from './routes/profit.js';
import { registerScanRoutes } from './routes/scan.js';
import { registerIdentifyPartsRoutes } from './routes/identifyParts.js';
import { registerIdentifyPartsJobsRoutes } from './routes/identifyPartsJobs.js';
import { startScheduler } from './scan/scheduler.js';
import { startIdentifyPartsWorkerPool } from './jobs/identifyPartsWorkerPool.js';
import { closeConnection } from './db/client.js';
import { PHOTOS_DIR } from './photos/photoStorage.js';

// Backend app shell. Builds the Fastify instance wired to the shared pino
// logger (see logger.ts for level conventions) and the centralized error
// handler (see error-handler.ts). Route modules (T5+) register themselves on
// `server` the same way registerSourcesRoutes and the /health route below do.
const server = Fastify({ loggerInstance: logger });

registerErrorHandler(server);

// apps/web (Vite dev server, default port 5173) and apps/server (default
// port 3001) are always different origins — even in production, the static
// frontend build and this API are served separately — so the browser's
// same-origin policy blocks every fetch call from api-client.ts (T4) unless
// the API opts in via CORS. Wide open (`origin: true`, reflecting whatever
// origin asked) is acceptable for a local-only, single-user app (assumption
// A7/A4) with no cookies/credentials in play. `methods` is listed explicitly
// (rather than left to @fastify/cors's default reflection) since this plugin
// registers before any route modules (T5+ add PUT/PATCH/DELETE routes),
// so there would otherwise be nothing yet to reflect methods from.
await server.register(cors, { origin: true, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] });

// Serves every stored listing photo over HTTP so the frontend can render
// real thumbnails and link to full-size images (photo-upload.tsx), instead
// of the raw filename list it showed before a serving route existed.
// `root` is scoped EXACTLY to PHOTOS_DIR (not DATA_DIR, its parent) because
// DATA_DIR also holds pc-parts-flipper.duckdb — the entire application
// database. Pointing this plugin at DATA_DIR (or any ancestor) would make
// that file downloadable over plain HTTP; scoping to PHOTOS_DIR means
// @fastify/static's root-jail only ever resolves inside the photos/
// subdirectory, regardless of path-traversal attempts in the URL. Its
// default dotfile/path-traversal protections are left on (no `allowedPath`
// override) deliberately, as a second layer behind the directory scoping
// itself.
await server.register(fastifyStatic, { root: PHOTOS_DIR, prefix: '/photos/' });

// Health-check route — confirms the server process is alive and reachable.
server.get('/health', async () => ({ status: 'ok' }));

await registerSourcesRoutes(server);
await registerListingsRoutes(server);
await registerPurchasesRoutes(server);
await registerTeardownRoutes(server);
await registerPartsRoutes(server);
await registerSaleListingsRoutes(server);
await registerSalesRoutes(server);
await registerProfitRoutes(server);
await registerScanRoutes(server);
await registerIdentifyPartsRoutes(server);
await registerIdentifyPartsJobsRoutes(server);

// Registers the once-daily scheduled scan job (T8, Req 6, 9) so eligible
// Sources are re-scanned automatically, not only via T7's manual route.
// Capturing the returned ScheduledTask so the SIGTERM/SIGINT handler below
// can stop it cleanly during shutdown instead of leaving a dangling cron
// timer.
const scheduledTask = startScheduler();
// Starts the identify-parts worker pool (T2, Req 1–4) that processes queued
// identify-parts jobs concurrently, up to IDENTIFY_PARTS_POOL_SIZE (default 1).
// Capturing the returned handle so the SIGTERM/SIGINT handler below can stop
// the pool cleanly during shutdown before closing the server.
const identifyPartsPool = startIdentifyPartsWorkerPool();

// Port the server listens on; configurable for deployment, defaults to 3001
// for local development.
const PORT = Number(process.env.PORT ?? 3001);

// Entry point: starts listening on all interfaces on the configured port.
server
  .listen({ port: PORT, host: '0.0.0.0' })
  .then(() => {
    logger.info({ port: PORT }, 'Server listening');
  })
  .catch((err: unknown) => {
    logger.error({ err }, 'Failed to start server');
    process.exit(1);
  });

// Guards gracefulShutdown against running twice: SIGTERM/SIGINT can each
// fire more than once (e.g. a process manager sending SIGTERM followed by
// SIGKILL-adjacent SIGTERM retries, or a user hitting Ctrl+C twice), and
// re-entering the shutdown sequence concurrently (e.g. a second
// closeConnection() racing the first) is unsafe.
let shuttingDown = false;

// Exists specifically to prevent DuckDB WAL corruption on shutdown: without
// a handler, SIGTERM's (or SIGHUP's — see below) default action kills the
// process immediately, with no chance to flush the DuckDB write-ahead log
// into the main database file. Any write since the last checkpoint left in
// that WAL file at that point makes the *next* startup's WAL replay fail
// outright, 500ing every DB-touching request until the stale .duckdb.wal
// file is deleted by hand (losing all data back to the last checkpoint —
// see client.ts's closeConnection for the full mechanism). Stopping the
// scheduler and closing the Fastify server first, before closing the DB
// connection, ensures no new work tries to use the connection after it
// starts closing. SIGHUP is handled here for the same reason as SIGTERM/
// SIGINT: a PTY-session or process-tree teardown (e.g. a process
// supervisor stopping the dev server's nested shell chain) can deliver
// SIGHUP alongside SIGTERM within about a millisecond of each other. With
// SIGHUP left unhandled, its default action terminates the process
// synchronously and immediately, racing ahead of SIGTERM's async
// gracefulShutdown() (`await server.close(); await closeConnection();`)
// and killing the process before either await completes — reintroducing
// the exact WAL corruption this fix exists to prevent.
async function gracefulShutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info({ signal }, 'Shutdown signal received, starting graceful shutdown');
  scheduledTask.stop();
  identifyPartsPool.stop();
  await server.close();
  await closeConnection();
  logger.info('Graceful shutdown complete');
  process.exit(0);
}

// All three signal handlers (SIGTERM/SIGINT/SIGHUP) route rejected
// gracefulShutdown() calls (e.g.
// closeConnection()'s CHECKPOINT failing) through this handler instead of
// leaving them as an unhandled promise rejection, which would otherwise
// crash the process with a generic Node trace instead of a clean, logged,
// structured error exit.
function handleShutdownFailure(err: unknown): void {
  logger.error({ err }, 'Graceful shutdown failed');
  process.exit(1);
}

process.on('SIGTERM', () => {
  gracefulShutdown('SIGTERM').catch(handleShutdownFailure);
});
process.on('SIGINT', () => {
  gracefulShutdown('SIGINT').catch(handleShutdownFailure);
});
process.on('SIGHUP', () => {
  gracefulShutdown('SIGHUP').catch(handleShutdownFailure);
});
