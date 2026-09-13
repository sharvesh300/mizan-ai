// Shared column helpers so every table declares primary keys, timestamps,
// and money amounts the same way.

import { sql } from "drizzle-orm";
import { integer, numeric, text } from "drizzle-orm/sqlite-core";

/** `uuid primary key default gen_random_uuid()` */
export const uuidPk = (name = "id") =>
  text(name)
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

/** `timestamptz not null default now()` — stored as unix seconds. */
export const createdAt = (name = "created_at") =>
  integer(name, { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`);

/** `numeric(p,s)` money/score amount — stored with SQLite's NUMERIC affinity (avoids REAL float drift), mapped to a JS number. */
export const amount = (name: string) => numeric(name, { mode: "number" });

/**
 * An UNQUALIFIED column reference, for use inside CHECK constraint bodies.
 *
 * Interpolating a drizzle column (`${table.confidence}`) into a `sql` template
 * emits it table-qualified: `"recommendation"."confidence"`. That is correct
 * SQL and works fine at CREATE TABLE time — but it makes the constraint
 * unsurvivable. SQLite cannot ALTER a CHECK, so drizzle-kit implements any
 * later change to such a table as the 12-step rebuild: create `__new_x`, copy,
 * drop, `ALTER TABLE __new_x RENAME TO x`. On that rename SQLite re-parses the
 * schema, the `"__new_x"."col"` qualifier no longer resolves, and the migration
 * dies with `error in table x after rename: no such column`.
 *
 * Unqualified, the constraint survives the rebuild. Use `col("snake_name")`
 * for every column inside a `check()` — and only there; ordinary predicates
 * should keep using the typed column.
 */
export const col = (name: string) => sql.identifier(name);
