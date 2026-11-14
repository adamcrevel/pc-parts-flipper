// Entry point for code shared between apps/web and apps/server, so both
// sides import the same request/response shapes instead of each redefining
// them (e.g. apps/web's api-client calls and apps/server's route handlers
// both consume Source from here). Almost everything here is types, erased at
// build time; partIdentity.js is the exception — a real runtime helper, which
// is why the root `build`/`test`/`dev` scripts compile this package first.
export * from './sources.js';
export * from './purchases.js';
export * from './teardown.js';
export * from './parts.js';
export * from './listings.js';
export * from './sales.js';
export * from './saleListings.js';
export * from './profit.js';
export * from './connectors.js';
export * from './aiIdentification.js';
export * from './identifyPartsJob.js';
export * from './partIdentity.js';
export * from './priceComps.js';
