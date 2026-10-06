// DDL for every table in the core workflow (Requirements 1-9). Statements are
// grouped into three ordered phases — enums, tables, indexes — and every
// statement uses an IF NOT EXISTS/OR REPLACE guard so migrate.ts (which runs
// this on every server start) is idempotent. Table order matches FK
// dependency order: sources -> listings -> expected_parts, purchases ->
// teardown_results, purchases -> parts -> sale_listings/sales.

// -- Phase 1: enums ------------------------------------------------------
// DuckDB enums back the fixed vocabularies named in the Requirements so an
// out-of-range value is rejected by the database itself, not just by the API
// layer built in later tasks.
export const ENUM_STATEMENTS: readonly string[] = [
  `CREATE TYPE IF NOT EXISTS platform_type AS ENUM ('ebay', 'facebook_marketplace', 'other')`,
  `CREATE TYPE IF NOT EXISTS listing_status AS ENUM ('open', 'accepted', 'rejected')`,
  `CREATE TYPE IF NOT EXISTS purchase_status AS ENUM ('ordered', 'shipped', 'received', 'torn_down', 'closed')`,
  `CREATE TYPE IF NOT EXISTS component_category AS ENUM
    ('CPU', 'GPU', 'Motherboard', 'RAM', 'Storage', 'PSU', 'Case', 'Cooler', 'Other')`,
  `CREATE TYPE IF NOT EXISTS teardown_result_type AS ENUM
    ('present_as_expected', 'present_but_different', 'missing', 'additional')`,
  `CREATE TYPE IF NOT EXISTS part_status AS ENUM ('ready_to_list', 'listed', 'sold', 'unsellable')`,
];

// -- Phase 2: tables -------------------------------------------------------
// Every primary key is a UUID generated in application code (see
// db/id.ts), never a sequence, so concurrent inserts from parallel requests
// (proven in T14) can never race over the same generated value. Every
// monetary column carries a `>= 0` CHECK so Req 13's "no negative monetary
// value" rule holds even if a caller bypasses the API-layer validation.
export const TABLE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS sources (
    id UUID PRIMARY KEY,
    name VARCHAR NOT NULL,
    platform_type platform_type NOT NULL,
    url VARCHAR,
    notes VARCHAR,
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
    updated_at TIMESTAMP NOT NULL DEFAULT current_timestamp
  )`,
  `CREATE TABLE IF NOT EXISTS listings (
    id UUID PRIMARY KEY,
    source_id UUID NOT NULL REFERENCES sources(id),
    title VARCHAR NOT NULL,
    description VARCHAR,
    listing_url VARCHAR,
    asking_price DECIMAL(10, 2) NOT NULL CHECK (asking_price >= 0),
    listing_date DATE NOT NULL,
    status listing_status NOT NULL DEFAULT 'open',
    acquisition_fees DECIMAL(10, 2) NOT NULL DEFAULT 0 CHECK (acquisition_fees >= 0),
    -- JSON-encoded array of local-disk photo paths (assumption A4); stored as
    -- text rather than a native DuckDB LIST to avoid its empty-array type-
    -- inference ambiguity in the Node client, and parsed in queries/listings.ts.
    photo_paths VARCHAR NOT NULL DEFAULT '[]',
    created_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
    updated_at TIMESTAMP NOT NULL DEFAULT current_timestamp
  )`,
  `CREATE TABLE IF NOT EXISTS part_reference_photos (
    id UUID PRIMARY KEY,
    category component_category NOT NULL,
    brand VARCHAR NOT NULL,
    part_number VARCHAR,
    photo_path VARCHAR NOT NULL,
    source VARCHAR NOT NULL,
    listing_id UUID REFERENCES listings(id),
    created_at TIMESTAMP NOT NULL DEFAULT current_timestamp
  )`,
  `CREATE TABLE IF NOT EXISTS part_reference_sourcing_attempts (
    id UUID PRIMARY KEY,
    category component_category NOT NULL,
    brand VARCHAR NOT NULL,
    part_number VARCHAR NOT NULL,
    attempted_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
    succeeded BOOLEAN NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS expected_parts (
    id UUID PRIMARY KEY,
    listing_id UUID NOT NULL REFERENCES listings(id),
    component_category component_category NOT NULL,
    description VARCHAR NOT NULL,
    estimated_resale_value DECIMAL(10, 2) NOT NULL CHECK (estimated_resale_value >= 0),
    created_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
    updated_at TIMESTAMP NOT NULL DEFAULT current_timestamp
  )`,
  `CREATE TABLE IF NOT EXISTS purchases (
    id UUID PRIMARY KEY,
    listing_id UUID NOT NULL REFERENCES listings(id),
    status purchase_status NOT NULL DEFAULT 'ordered',
    price_paid DECIMAL(10, 2) NOT NULL CHECK (price_paid >= 0),
    purchase_date DATE NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
    updated_at TIMESTAMP NOT NULL DEFAULT current_timestamp
  )`,
  `CREATE TABLE IF NOT EXISTS teardown_results (
    id UUID PRIMARY KEY,
    purchase_id UUID NOT NULL REFERENCES purchases(id),
    -- Null when this row records an Additional Part not on the Listing.
    expected_part_id UUID REFERENCES expected_parts(id),
    result teardown_result_type NOT NULL,
    note VARCHAR,
    created_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
    updated_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
    -- Guards against a non-atomic read-then-write route handler racing
    -- itself into two reconciliation rows for the same Expected Part.
    -- DuckDB (like every ANSI-SQL engine) treats NULL as distinct from
    -- every other NULL for uniqueness purposes, so this constraint still
    -- allows any number of expected_part_id IS NULL rows ('additional'
    -- Parts found during teardown that weren't on the Expected Parts
    -- list) per purchase_id — verified empirically against a real DuckDB
    -- connection; DuckDB has no partial/filtered UNIQUE index to fall
    -- back on if that weren't true.
    UNIQUE (purchase_id, expected_part_id)
  )`,
  `CREATE TABLE IF NOT EXISTS parts (
    id UUID PRIMARY KEY,
    purchase_id UUID NOT NULL REFERENCES purchases(id),
    category component_category NOT NULL,
    description VARCHAR NOT NULL,
    status part_status NOT NULL DEFAULT 'ready_to_list',
    unsellable_reason VARCHAR,
    created_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
    updated_at TIMESTAMP NOT NULL DEFAULT current_timestamp
  )`,
  `CREATE TABLE IF NOT EXISTS sale_listings (
    id UUID PRIMARY KEY,
    part_id UUID NOT NULL REFERENCES parts(id),
    platform platform_type NOT NULL,
    title VARCHAR NOT NULL,
    description VARCHAR,
    asking_price DECIMAL(10, 2) NOT NULL CHECK (asking_price >= 0),
    -- Set only when the user confirms they've manually posted it (A5).
    listed_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
    updated_at TIMESTAMP NOT NULL DEFAULT current_timestamp
  )`,
  `CREATE TABLE IF NOT EXISTS sales (
    id UUID PRIMARY KEY,
    -- One Sale per Part: guards the same non-atomic read-then-write race
    -- (concurrent POSTs past the 'listed' status check) from inserting two
    -- Sale rows for one Part, which would double-count revenue in the Req
    -- 10 profit rollup.
    part_id UUID NOT NULL REFERENCES parts(id) UNIQUE,
    sold_price DECIMAL(10, 2) NOT NULL CHECK (sold_price >= 0),
    sold_date DATE NOT NULL,
    platform_fee DECIMAL(10, 2) NOT NULL DEFAULT 0 CHECK (platform_fee >= 0),
    shipping_cost DECIMAL(10, 2) NOT NULL DEFAULT 0 CHECK (shipping_cost >= 0),
    buyer_note VARCHAR,
    created_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
    updated_at TIMESTAMP NOT NULL DEFAULT current_timestamp
  )`,
];

// -- Phase 3: alters ---------------------------------------------------
// Columns later features add on top of the original schema. Uses
// ADD COLUMN IF NOT EXISTS so this phase is safe to re-run on every boot,
// same as the table/index phases above.
//
// The ebay-scanning feature: a per-source connector_config (JSON-encoded
// EbayConnectorConfig, see packages/shared/src/connectors.ts) driving what
// each source's scheduled eBay scan searches for, last_scanned_at/
// last_scan_found_count so the UI can show scan recency and yield, and
// external_source/external_item_id on listings so an eBay-sourced listing
// can be deduped against a listing a user already entered manually from the
// same eBay item.
//
// The brand/model feature: brand and part_number on both expected_parts and
// parts, so a component's manufacturer and model/part number are first-class
// structured fields rather than prose buried in `description` (which keeps
// its role as condition notes and remaining context). Both are nullable on
// purpose: a part that cannot be confidently identified is left blank, never
// guessed or filled with placeholder text.
export const ALTER_STATEMENTS: readonly string[] = [
  `ALTER TABLE sources ADD COLUMN IF NOT EXISTS connector_config VARCHAR`,
  `ALTER TABLE sources ADD COLUMN IF NOT EXISTS last_scanned_at TIMESTAMP`,
  `ALTER TABLE sources ADD COLUMN IF NOT EXISTS last_scan_found_count INTEGER`,
  `ALTER TABLE listings ADD COLUMN IF NOT EXISTS external_source VARCHAR`,
  `ALTER TABLE listings ADD COLUMN IF NOT EXISTS external_item_id VARCHAR`,
  `ALTER TABLE expected_parts ADD COLUMN IF NOT EXISTS brand VARCHAR`,
  `ALTER TABLE expected_parts ADD COLUMN IF NOT EXISTS part_number VARCHAR`,
  `ALTER TABLE parts ADD COLUMN IF NOT EXISTS brand VARCHAR`,
  `ALTER TABLE parts ADD COLUMN IF NOT EXISTS part_number VARCHAR`,
  // JSON-encoded array of IdentityCandidate objects (see
  // packages/shared/src/aiIdentification.ts), stored as text for the same
  // reason as listings.photo_paths above: DuckDB's native LIST type has
  // empty-array type-inference ambiguity in the Node client, so the column
  // is a VARCHAR and parsed/stringified in queries/expectedParts.ts and
  // queries/parts.ts instead.
  `ALTER TABLE expected_parts ADD COLUMN IF NOT EXISTS identity_candidates VARCHAR DEFAULT '[]'`,
  `ALTER TABLE parts ADD COLUMN IF NOT EXISTS identity_candidates VARCHAR DEFAULT '[]'`,
];

// -- Phase 4: indexes ------------------------------------------------------
// Supports the filtered/paginated queue and dashboard screens (Req 10-12)
// without a full table scan per request. Deliberately NOT indexed: the
// `status` columns on listings/purchases/parts. DuckDB rejects an UPDATE of
// any column that is both indexed and on a table referenced by another
// table's FOREIGN KEY ("Violates foreign key constraint ... still
// referenced ... different table") — and status is exactly the column every
// lifecycle transition (Req 4-7) updates on these three parent tables. The
// columns below are safe because nothing ever updates them after insert.
// The unique index on listings(source_id, external_item_id) de-dupes
// eBay-scanned listings per source; DuckDB treats multiple NULLs as
// distinct (standard SQL semantics), so manually-entered listings, which
// always have a NULL external_item_id, are unaffected by this constraint.
export const INDEX_STATEMENTS: readonly string[] = [
  `CREATE INDEX IF NOT EXISTS idx_listings_source_id ON listings(source_id)`,
  `CREATE INDEX IF NOT EXISTS idx_expected_parts_listing_id ON expected_parts(listing_id)`,
  `CREATE INDEX IF NOT EXISTS idx_purchases_listing_id ON purchases(listing_id)`,
  `CREATE INDEX IF NOT EXISTS idx_teardown_results_purchase_id ON teardown_results(purchase_id)`,
  `CREATE INDEX IF NOT EXISTS idx_parts_purchase_id ON parts(purchase_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sale_listings_part_id ON sale_listings(part_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sales_part_id ON sales(part_id)`,
  `CREATE INDEX IF NOT EXISTS idx_reference_photos_category_brand ON part_reference_photos(category, brand)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_reference_photos_dedup ON part_reference_photos(category, brand, part_number, photo_path)`,
  // part_number is NOT NULL on this table, so this unique index alone
  // prevents a duplicate attempt row for the same combo (Req 6's
  // already-attempted skip) — no NULL-distinctness workaround needed, unlike
  // part_reference_photos's own dedup index above.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_sourcing_attempts_dedup ON part_reference_sourcing_attempts(category, brand, part_number)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_listings_source_external_item ON listings(source_id, external_item_id)`,
];
