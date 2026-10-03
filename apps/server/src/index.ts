import Fastify from 'fastify';
import cors from '@fastify/cors';
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
import { startScheduler } from './scan/scheduler.js';

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

// Registers the once-daily scheduled scan job (T8, Req 6, 9) so eligible
// Sources are re-scanned automatically, not only via T7's manual route.
startScheduler();

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
