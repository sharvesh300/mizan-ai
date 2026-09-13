import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as schema from "./schema";

const dbPath = process.env.DATABASE_URL ?? path.join(process.cwd(), "db", "sqlite.db");

const sqlite = new Database(dbPath, { create: true });
sqlite.exec("pragma foreign_keys = on;");

export const db = drizzle({ client: sqlite, schema });

// Local sqlite dev convenience: apply pending migrations, then the
// append-only guard trigger (see triggers.sql), on every connect. Both are
// idempotent — drizzle tracks applied migrations, and the trigger DDL uses
// `IF NOT EXISTS`.
migrate(db, { migrationsFolder: path.join(import.meta.dir, "..", "drizzle") });
sqlite.exec(readFileSync(path.join(import.meta.dir, "triggers.sql"), "utf8"));
