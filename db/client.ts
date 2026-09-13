import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import * as schema from "./schema";

// The DB module is imported from two runtimes: the seed script runs under Bun
// (bun:sqlite, zero-install) and the Next.js server runs under Node
// (better-sqlite3, which Next auto-externalizes). Pick the driver that exists
// in the current runtime so the same import works in both with no launch flag.
const nodeRequire = createRequire(import.meta.url);
const dbPath = process.env.DATABASE_URL ?? path.join(process.cwd(), "db", "sqlite.db");
const isBun = "Bun" in globalThis;

type Db = BaseSQLiteDatabase<"sync", unknown, typeof schema>;
type RawClient = { exec: (sql: string) => unknown };

/** The append-only guard DDL. `triggers.sql` is the single source of truth. */
const triggerDdl = (): string => readFileSync(path.join(process.cwd(), "db", "triggers.sql"), "utf8");

/** Names parsed out of that same DDL, so the two can never drift apart. */
const triggerNames = (): string[] =>
  [...triggerDdl().matchAll(/create trigger if not exists (\w+)/gi)].map((m) => m[1]);

// The raw driver handle, kept for the two operations drizzle has no API for:
// pragmas and trigger DDL. Assigned by connect() below.
let rawClient: RawClient;

function connect(): Db {
  const migrationsFolder = path.join(process.cwd(), "drizzle");
  const triggers = triggerDdl();

  if (isBun) {
    // Computed specifier keeps the Node bundler from resolving the Bun-only
    // builtin; this branch never runs under Node.
    const { Database } = nodeRequire(["bun", "sqlite"].join(":"));
    const { drizzle } = nodeRequire("drizzle-orm/bun-sqlite");
    const { migrate } = nodeRequire("drizzle-orm/bun-sqlite/migrator");
    const sqlite = new Database(dbPath, { create: true });
    rawClient = sqlite;
    const db = drizzle({ client: sqlite, schema });
    migrateThenGuard(sqlite, () => migrate(db, { migrationsFolder }), triggers);
    return db;
  }

  const Database = nodeRequire("better-sqlite3");
  const { drizzle } = nodeRequire("drizzle-orm/better-sqlite3");
  const { migrate } = nodeRequire("drizzle-orm/better-sqlite3/migrator");
  const sqlite = new Database(dbPath);
  rawClient = sqlite;
  const db = drizzle({ client: sqlite, schema });
  migrateThenGuard(sqlite, () => migrate(db, { migrationsFolder }), triggers);
  return db;
}

/**
 * Ordering here is load-bearing, and both halves of it are easy to get wrong.
 *
 * 1. `foreign_keys` must be OFF *while migrating*. SQLite cannot ALTER a
 *    CHECK constraint, so drizzle-kit implements those changes as the standard
 *    12-step rebuild: create `__new_x`, copy, `DROP TABLE x`, rename. That drop
 *    fails against any table another table references (`policy.recommendation_id`
 *    -> `recommendation`). drizzle-kit emits `PRAGMA foreign_keys=OFF` inside
 *    the migration file, but the migrator runs the file in a transaction and
 *    SQLite silently ignores that pragma inside one — so it has to be set here,
 *    on the connection, before the transaction opens. Re-enabled straight after.
 * 2. The append-only triggers are applied *after* migrating, never before. A
 *    rebuild drops the table the trigger is attached to (taking the trigger with
 *    it), and a `BEFORE DELETE` guard on a table mid-rebuild is a good way to
 *    abort a migration halfway.
 */
function migrateThenGuard(sqlite: RawClient, run: () => void, triggers: string): void {
  sqlite.exec("pragma foreign_keys = off;");
  try {
    run();
  } finally {
    sqlite.exec("pragma foreign_keys = on;");
  }
  sqlite.exec(triggers);
}

export const db = connect();

/**
 * Re-apply the append-only guards. Idempotent (`create trigger if not exists`).
 */
export function applyAppendOnlyGuards(): void {
  rawClient.exec(triggerDdl());
}

/**
 * Drop the append-only guards.
 *
 * The guards exist to stop application code from rewriting history, and they
 * do their job a little too well: `BEFORE DELETE` also blocks the teardown at
 * the top of the seed script, which is the one place a full wipe is the point.
 * Only `db/seed/run.ts` should call this, and only inside the transaction that
 * re-loads the fixtures — a rollback restores the triggers with everything
 * else, since SQLite DDL is transactional.
 */
export function dropAppendOnlyGuards(): void {
  rawClient.exec(triggerNames().map((name) => `drop trigger if exists ${name};`).join("\n"));
}
