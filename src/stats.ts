import type { Database } from "bun:sqlite";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { type Row, rows } from "./db.ts";
import { SKILLS_DIR } from "./paths.ts";
import { PROVIDER_NAME } from "./config.ts";

/**
 * Skill directory names. Dirent.isDirectory() is false for symlinks, so linked skills would
 * vanish from the list and be reported as unused — stat() follows the link.
 */
export function skillDirectories(): string[] {
  let entries: string[];
  try {
    entries = readdirSync(SKILLS_DIR);
  } catch {
    return []; // some installs have no skills directory
  }
  return entries.filter((name) => {
    try {
      return statSync(join(SKILLS_DIR, name)).isDirectory();
    } catch {
      return false; // broken link
    }
  });
}

export type StatsOptions = { limit?: number; since?: string | null };

export function statTools(
  db: Database,
  { limit = 20, since = null }: StatsOptions = {},
  mainOnly = false,
): Row[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (since) {
    clauses.push("ts >= ?");
    params.push(since);
  }
  if (mainOnly) clauses.push("is_sidechain = 0");
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return rows(
    db,
    `SELECT tool_name, COUNT(*) calls, SUM(is_error) errors, COUNT(DISTINCT session_id) sessions
     FROM tool_calls ${where}
     GROUP BY tool_name ORDER BY calls DESC LIMIT ?`,
    [...params, limit],
  );
}

export function statHookRuns(db: Database, { limit = 20, since = null }: StatsOptions = {}): Row[] {
  const where = since ? "WHERE ts >= ?" : "";
  const params = since ? [since] : [];
  return rows(
    db,
    `SELECT hook_name, hook_event, COUNT(*) runs,
            SUM(subtype='hook_cancelled') cancelled,
            SUM(subtype LIKE 'hook_%error%') errored,
            CAST(AVG(duration_ms) AS INT) avg_ms, MAX(duration_ms) max_ms
     FROM hook_events ${where}
     GROUP BY hook_name, hook_event ORDER BY runs DESC LIMIT ?`,
    [...params, limit],
  );
}

// The hook name only appears inside the denial message as [bash …/name.sh].
const HOOK_NAME = /\[bash [^\]]*?\/([\w.-]+?)\.sh\]/;

export function statHookFriction(
  db: Database,
  { limit = 20, since = null }: StatsOptions = {},
): Row[] {
  let where = "WHERE p.denial_kind='permission-rule'";
  const params: unknown[] = [];
  if (since) {
    where += " AND p.ts >= ?";
    params.push(since);
  }
  const found = rows(
    db,
    `SELECT tc.tool_name blocked_tool, p.detail
     FROM permission_events p
     LEFT JOIN tool_calls tc ON tc.tool_use_id = p.tool_use_id
     ${where}`,
    params,
  );
  const counts = new Map<string, Row>();
  for (const row of found) {
    const hook = String(row.detail ?? "").match(HOOK_NAME)?.[1] ?? "(unknown)";
    const tool = (row.blocked_tool as string) ?? "(unknown)";
    const key = `${hook} ${tool}`;
    const existing = counts.get(key);
    if (existing) existing.blocks = (existing.blocks as number) + 1;
    else counts.set(key, { hook, blocked_tool: tool, blocks: 1 });
  }
  return [...counts.values()]
    .sort((a, b) => (b.blocks as number) - (a.blocks as number))
    .slice(0, limit);
}

export function statSkills(db: Database, { limit = 50, since = null }: StatsOptions = {}): Row[] {
  let where = "WHERE attribution_skill IS NOT NULL";
  const params: unknown[] = [];
  if (since) {
    where += " AND ts >= ?";
    params.push(since);
  }
  const used = rows(
    db,
    `SELECT attribution_skill skill, COUNT(*) uses, COUNT(DISTINCT session_id) sessions
     FROM tool_calls ${where}
     GROUP BY attribution_skill ORDER BY uses DESC LIMIT ?`,
    [...params, limit],
  );
  const bare = new Set(used.filter((r) => !String(r.skill).includes(":")).map((r) => r.skill));
  const onDisk = skillDirectories();
  for (const name of onDisk.sort()) {
    if (!bare.has(name)) used.push({ skill: name, uses: 0, sessions: 0 });
  }
  return used;
}

export function statSessions(db: Database, { limit = 20, since = null }: StatsOptions = {}): Row[] {
  const where = since ? "WHERE s.last_ts >= ?" : "";
  const params = since ? [since] : [];
  return rows(
    db,
    `SELECT s.session_id, s.cwd, s.git_branch, s.first_ts, s.last_ts,
            COUNT(tc.tool_use_id) tool_calls, SUM(tc.is_error) errors
     FROM sessions s LEFT JOIN tool_calls tc ON tc.session_id = s.session_id
     ${where}
     GROUP BY s.session_id ORDER BY s.last_ts DESC LIMIT ?`,
    [...params, limit],
  );
}

export function statTokens(db: Database, { limit = 20, since = null }: StatsOptions = {}): Row[] {
  const where = since ? "WHERE ts >= ?" : "";
  const params = since ? [since] : [];
  return rows(
    db,
    `SELECT model, COUNT(*) turns, COUNT(DISTINCT session_id) sessions,
            SUM(input_tokens) input, SUM(cache_read) cache_read,
            SUM(cache_create) cache_create, SUM(output_tokens) output,
            SUM(thinking_tokens) thinking, ROUND(AVG(cache_read)) avg_cache_read,
            ROUND(100.0 * SUM(thinking_tokens) / NULLIF(SUM(output_tokens), 0), 1) thinking_pct
     FROM model_turns ${where}
     GROUP BY model ORDER BY cache_read DESC LIMIT ?`,
    [...params, limit],
  );
}

export function statIoKinds(db: Database, { since = null }: StatsOptions = {}): Row[] {
  const where = since ? "WHERE ts >= ?" : "";
  const params = since ? [since] : [];
  return rows(
    db,
    `SELECT kind, COUNT(*) refs, COUNT(DISTINCT ref) distinct_refs,
            COUNT(DISTINCT session_id) sessions, SUM(is_error) errors
     FROM io_refs ${where} GROUP BY kind ORDER BY refs DESC`,
    params,
  );
}

export function statIo(db: Database, { limit = 20, since = null }: StatsOptions = {}): Row[] {
  const where = since ? "WHERE ts >= ?" : "";
  const params = since ? [since] : [];
  return rows(
    db,
    `SELECT kind, ref, COUNT(*) refs, COUNT(DISTINCT session_id) sessions, SUM(is_error) errors
     FROM io_refs ${where} GROUP BY kind, ref ORDER BY refs DESC LIMIT ?`,
    [...params, limit],
  );
}

export function statMemoryChanges(db: Database, { limit = 20, since = null }: StatsOptions = {}): Row[] {
  const where = since ? "WHERE ts >= ?" : "";
  const params = since ? [since] : [];
  return rows(
    db,
    `SELECT substr(ts, 1, 19) ts, change, replace(path, rtrim(path, replace(path, '/', '')), '') file,
            session_id
     FROM memory_changes ${where} ORDER BY ts DESC LIMIT ?`,
    [...params, limit],
  );
}

/** Split mcp__server__tool. Names may contain __ themselves, so split at the first one only. */
function mcpParts(toolName: string): [string, string] {
  const rest = toolName.slice("mcp__".length);
  const cut = rest.indexOf("__");
  if (cut < 0) return [rest, "(unknown)"];
  return [rest.slice(0, cut), rest.slice(cut + 2) || "(unknown)"];
}

type Bucket = { calls: number; errors: number; sessions: Set<string> };

/** Server identity comes from tool_name; the attribution columns also appear on non-MCP calls. */
export function statMcp(
  db: Database,
  { limit = 20, since = null }: StatsOptions = {},
): [Row[], Row[]] {
  let where = "WHERE is_mcp = 1";
  const params: unknown[] = [];
  if (since) {
    where += " AND ts >= ?";
    params.push(since);
  }
  const servers = new Map<string, Bucket>();
  const tools = new Map<string, Bucket>();
  for (const row of rows(db, `SELECT tool_name, is_error, session_id FROM tool_calls ${where}`, params)) {
    const [server, tool] = mcpParts(String(row.tool_name));
    const targets: [Map<string, Bucket>, string][] = [
      [servers, server],
      [tools, `${server} ${tool}`],
    ];
    for (const [bucket, key] of targets) {
      const found = bucket.get(key) ?? { calls: 0, errors: 0, sessions: new Set<string>() };
      found.calls += 1;
      found.errors += Number(row.is_error ?? 0);
      found.sessions.add(String(row.session_id));
      bucket.set(key, found);
    }
  }
  const finish = (bucket: Map<string, Bucket>, split: boolean): Row[] =>
    [...bucket.entries()]
      .map(([key, value]) => {
        const [server, tool] = key.split(" ");
        const name = split ? { server, tool } : { server };
        return {
          ...name,
          calls: value.calls,
          errors: value.errors,
          error_pct: Math.round((1000 * value.errors) / value.calls) / 10,
          sessions: value.sessions.size,
        };
      })
      .sort((a, b) => (b.calls as number) - (a.calls as number))
      .slice(0, limit);
  return [finish(servers, false), finish(tools, true)];
}

export function currentProvider(): string {
  return PROVIDER_NAME();
}
