import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_DB } from "./paths.ts";
import { SCHEMA } from "./schema.ts";

export type Row = Record<string, unknown>;

export function connect(path: string = DEFAULT_DB): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec(SCHEMA);
  syncViews(db);
  return db;
}

/**
 * Recreate the view only when its definition changed.
 *
 * Dropping and recreating on every connect turns read commands into writers; one stuck
 * process then blocks everything with SQLITE_BUSY.
 */
function syncViews(db: Database): void {
  const expected = SCHEMA.match(/CREATE VIEW IF NOT EXISTS io_refs AS([\s\S]*?);\n/);
  if (!expected) return;
  const stored = db.query("SELECT sql FROM sqlite_master WHERE type='view' AND name='io_refs'")
    .get() as { sql: string | null } | null;
  if (stored?.sql?.includes(expected[1]!.trim())) return;
  db.exec(`DROP VIEW IF EXISTS io_refs; CREATE VIEW io_refs AS${expected[1]};`);
}

export function rows(db: Database, sql: string, params: unknown[] = []): Row[] {
  return db.query(sql).all(...(params as never[])) as Row[];
}
