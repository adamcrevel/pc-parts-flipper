// Barrel for the data-access module. Every other part of apps/server reaches
// the database exclusively through the named exports re-exported here —
// never by importing @duckdb/node-api or a db/*.ts file directly — which is
// what keeps "all DuckDB access confined to one data-access module" true.
export * from './types.js';

export * from './queries/sources.js';
export * from './queries/listings.js';
export * from './queries/expectedParts.js';
export * from './queries/purchases.js';
export * from './queries/teardownResults.js';
export * from './queries/parts.js';
export * from './queries/saleListings.js';
export * from './queries/profit.js';
export * from './queries/sales.js';
