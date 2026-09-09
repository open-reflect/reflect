/**
 * Detect memory files that changed during a turn by comparing mtime/size against a snapshot.
 * Runs from the Stop hook. Tool-independent, so it catches writes the tool-call parser cannot see
 * (heredocs, cp, shell variables, editors). Reads leave no trace here.
 */
import type { Database } from "bun:sqlite";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { PROJECTS_ROOT } from "./paths.ts";

type Entry = { path: string; mtime: number; size: number };

function memoryFiles(root: string): Entry[] {
  const out: Entry[] = [];
  let projects: string[];
  try {
    projects = readdirSync(root);
  } catch {
    return out;
  }
  for (const project of projects) {
    const directory = join(root, project, "memory");
    let names: string[];
    try {
      names = readdirSync(directory);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".md")) continue;
      const path = join(directory, name);
      try {
        const stat = statSync(path);
        out.push({ path, mtime: stat.mtimeMs, size: stat.size });
      } catch {
        // vanished between readdir and stat
      }
    }
  }
  return out;
}

/**
 * Record created/modified/deleted memory files since the last call and refresh the snapshot.
 * An empty snapshot is seeded silently — the first run must not report every file as created.
 * Returns the number of changes recorded.
 */
export function scanMemoryChanges(db: Database, sessionId: string, root: string = PROJECTS_ROOT,
                                  now: string = new Date().toISOString()): number {
  const current = new Map(memoryFiles(root).map((entry) => [entry.path, entry]));
  const previous = new Map(
    (db.query("SELECT path, mtime, size FROM memory_snapshot").all() as Entry[]).map((e) => [e.path, e]),
  );
  const changes: [string, string][] = [];
  if (previous.size) {
    for (const [path, entry] of current) {
      const before = previous.get(path);
      if (!before) changes.push([path, "created"]);
      else if (before.mtime !== entry.mtime || before.size !== entry.size) changes.push([path, "modified"]);
    }
    for (const path of previous.keys()) {
      if (!current.has(path)) changes.push([path, "deleted"]);
    }
  }

  const write = db.transaction(() => {
    for (const [path, change] of changes) {
      db.run("INSERT OR IGNORE INTO memory_changes (session_id, ts, path, change) VALUES (?,?,?,?)",
             [sessionId, now, path, change]);
    }
    db.run("DELETE FROM memory_snapshot");
    for (const entry of current.values()) {
      db.run("INSERT INTO memory_snapshot (path, mtime, size) VALUES (?,?,?)", [entry.path, entry.mtime, entry.size]);
    }
  });
  write();
  return changes.length;
}
