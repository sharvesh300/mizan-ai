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

function connect(): Db {
  const migrationsFolder = path.join(process.cwd(), "drizzle");
  // Append-only guard trigger, re-applied every connect (idempotent — the DDL
  // uses `IF NOT EXISTS`). See triggers.sql.
  const triggers = readFileSync(path.join(process.cwd(), "db", "triggers.sql"), "utf8");

  if (isBun) {
    // Computed specifier keeps the Node bundler from resolving the Bun-only
    // builtin; this branch never runs under Node.
    const { Database } = nodeRequire(["bun", "sqlite"].join(":"));
    const { drizzle } = nodeRequire("drizzle-orm/bun-sqlite");
    const { migrate } = nodeRequire("drizzle-orm/bun-sqlite/migrator");
    const sqlite = new Database(dbPath, { create: true });
    sqlite.exec("pragma foreign_keys = on;");
    const db = drizzle({ client: sqlite, schema });
    migrate(db, { migrationsFolder });
    sqlite.exec(triggers);
    return db;
  }

  const Database = nodeRequire("better-sqlite3");
  const { drizzle } = nodeRequire("drizzle-orm/better-sqlite3");
  const { migrate } = nodeRequire("drizzle-orm/better-sqlite3/migrator");
  const sqlite = new Database(dbPath);
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle({ client: sqlite, schema });
  migrate(db, { migrationsFolder });
  sqlite.exec(triggers);
  return db;
}

export const db = connect();
