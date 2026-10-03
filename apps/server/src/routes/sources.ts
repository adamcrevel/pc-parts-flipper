// HTTP routes for Source CRUD (Req 1: create, list, edit, deactivate). Every
// handler below reaches the database exclusively through the named exports
// of apps/server/src/db (barrel at db/index.ts) — never a direct DuckDB
// call — per the "all DuckDB access confined to db/**" standing check.
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
import type { CreateSourceInput, PlatformType } from '@pc-parts-flipper/shared';
import { createSource, getSourceById, listSources, updateSource } from '../db/index.js';
import { AppError } from '../error-handler.js';
import { logger } from '../logger.js';

// The only values DuckDB's platform_type ENUM column accepts; mirrors
// apps/server/src/db/types.ts's PlatformType union.
const VALID_PLATFORM_TYPES: readonly PlatformType[] = ['ebay', 'facebook_marketplace', 'other'];

// Loosely-typed shape of an incoming create/update request body — fields are
// `unknown` until validateSourceInput below confirms their type, since the
// body is untrusted request input.
interface SourceRequestBody {
  name?: unknown;
  platformType?: unknown;
  url?: unknown;
  notes?: unknown;
}

/**
 * Validates and normalizes a create/update request body, throwing an
 * AppError(400) with a field-level message on the first blank required
 * field (Requirement 13: "reject save on blank required fields ... with
 * inline error"). Returns the normalized input ready to pass to the db layer.
 */
function validateSourceInput(body: SourceRequestBody): CreateSourceInput {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name.length === 0) {
    throw new AppError('name is required', 400);
  }

  // Guard against non-string/garbage values before the union-membership check below.
  const platformTypeRaw = typeof body.platformType === 'string' ? body.platformType : '';
  if (!VALID_PLATFORM_TYPES.includes(platformTypeRaw as PlatformType)) {
    throw new AppError('platformType is required and must be one of: ebay, facebook_marketplace, other', 400);
  }

  const url = typeof body.url === 'string' ? body.url.trim() : '';
  if (url.length === 0) {
    throw new AppError('url is required', 400);
  }

  // notes is optional — blank/missing normalizes to null rather than an empty string.
  const notes = typeof body.notes === 'string' && body.notes.trim().length > 0 ? body.notes.trim() : null;

  return { name, platformType: platformTypeRaw as PlatformType, url, notes };
}

/**
 * Registers all `/api/sources` routes on the given Fastify instance. Called
 * once from index.ts during server bootstrap, the same way
 * registerErrorHandler is. The generic re-declaration (matching
 * error-handler.ts's registerErrorHandler) lets TypeScript infer this
 * server's actual Logger type from the argument instead of defaulting to
 * FastifyBaseLogger, which the pino-backed `server` instance in index.ts is
 * not structurally assignable to.
 */
export async function registerSourcesRoutes<
  RawServer extends RawServerBase = RawServerDefault,
  RawRequestType extends RawRequestDefaultExpression<RawServer> = RawRequestDefaultExpression<RawServer>,
  RawReplyType extends RawReplyDefaultExpression<RawServer> = RawReplyDefaultExpression<RawServer>,
  Logger extends FastifyBaseLogger = FastifyBaseLogger,
  TypeProvider extends FastifyTypeProvider = FastifyTypeProviderDefault,
>(server: FastifyInstance<RawServer, RawRequestType, RawReplyType, Logger, TypeProvider>): Promise<void> {
  server.post('/api/sources', async (request, reply) => {
    logger.info({ route: 'POST /api/sources' }, 'Creating source');
    const input = validateSourceInput(request.body as SourceRequestBody);
    const source = await createSource(input);
    reply.status(201);
    return source;
  });

  server.get('/api/sources', async (request) => {
    // `activeOnly=true` restricts the list to active rows; omitted/any other
    // value returns every Source, active and inactive (per Requirement:
    // "include inactive unless filtered").
    const { activeOnly } = request.query as { activeOnly?: string };
    logger.info({ route: 'GET /api/sources', activeOnly }, 'Listing sources');
    return listSources({ activeOnly: activeOnly === 'true' });
  });

  server.get('/api/sources/:id', async (request) => {
    const { id } = request.params as { id: string };
    logger.info({ route: 'GET /api/sources/:id', id }, 'Fetching source');
    const source = await getSourceById(id);
    if (!source) {
      throw new AppError(`Source ${id} not found`, 404);
    }
    return source;
  });

  server.put('/api/sources/:id', async (request) => {
    const { id } = request.params as { id: string };
    logger.info({ route: 'PUT /api/sources/:id', id }, 'Updating source');
    const input = validateSourceInput(request.body as SourceRequestBody);
    const source = await updateSource(id, input);
    if (!source) {
      throw new AppError(`Source ${id} not found`, 404);
    }
    return source;
  });

  server.patch('/api/sources/:id/deactivate', async (request) => {
    const { id } = request.params as { id: string };
    logger.info({ route: 'PATCH /api/sources/:id/deactivate', id }, 'Deactivating source');
    // Deactivate never hard-deletes — it flips `active` to false via the same
    // partial-update path updateSource uses for edits.
    const source = await updateSource(id, { active: false });
    if (!source) {
      throw new AppError(`Source ${id} not found`, 404);
    }
    return source;
  });
}
