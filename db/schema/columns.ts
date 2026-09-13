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
