import type { Database } from "bun:sqlite";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { type Row, rows } from "./db.ts";
import { CLAUDE_MD_PATH, PROJECTS_ROOT } from "./paths.ts";
import { skillDirectories, statHookFriction, statHookRuns, statSkills, statTools } from "./stats.ts";

export type Miner = (db: Database, since?: string | null) => Row[];

export function mineHookFriction(db: Database, since: string | null = null, minBlocks = 3): Row[] {
  return statHookFriction(db, { limit: 200, since }).filter((r) => (r.blocks as number) >= minBlocks);
}

/** Ignores `since`: "never used" is only meaningful over the whole record. */
export function mineUnusedSkills(db: Database): Row[] {
  return statSkills(db, { limit: 200 }).filter((r) => r.uses === 0);
}

export function mineUserRejections(db: Database, since: string | null = null, minCount = 2): Row[] {
  let where = "WHERE p.denial_kind IN ('user-rejected', 'automode-blocked')";
  const params: unknown[] = [];
  if (since) {
    where += " AND p.ts >= ?";
    params.push(since);
  }
  return rows(
    db,
    `SELECT p.denial_kind kind, COALESCE(tc.tool_name, '(unknown)') tool,
            COUNT(*) n, COUNT(DISTINCT p.session_id) sessions
     FROM permission_events p
     LEFT JOIN tool_calls tc ON tc.tool_use_id = p.tool_use_id
     ${where}
     GROUP BY kind, tool ORDER BY n DESC`,
    params,
  ).filter((r) => (r.n as number) >= minCount);
}

/**
 * Hooks that exited non-zero. 127 means the executable was not found: registered but never running.
 * NULL exit codes are not failures (hook_additional_context, hook_cancelled).
 */
export function mineHookFailures(db: Database, since: string | null = null, minCount = 1): Row[] {
  let where = "WHERE exit_code IS NOT NULL AND exit_code <> 0";
  const params: unknown[] = [];
  if (since) {
    where += " AND ts >= ?";
    params.push(since);
  }
  return rows(
    db,
    `SELECT hook_name, exit_code, COUNT(*) n, COUNT(DISTINCT session_id) sessions,
            MIN(SUBSTR(command, 1, 80)) command
     FROM hook_events ${where}
     GROUP BY hook_name, exit_code ORDER BY n DESC`,
    params,
  ).filter((r) => (r.n as number) >= minCount);
}

export function mineErrorRate(
  db: Database,
  since: string | null = null,
  minCalls = 20,
  minRate = 0.1,
): Row[] {
  const out: Row[] = [];
  for (const row of statTools(db, { limit: 200, since }, true)) {
    const calls = row.calls as number;
    const errors = (row.errors as number) ?? 0;
    if (calls < minCalls || !errors) continue;
    const rate = errors / calls;
    if (rate >= minRate) out.push({ ...row, error_rate: Math.round(rate * 1000) / 1000 });
  }
  return out;
}

export function mineCorrections(db: Database, since: string | null = null, minCount = 2): Row[] {
  const where = since ? "WHERE ts >= ?" : "";
  const params = since ? [since] : [];
  return rows(
    db,
    `SELECT pattern, COUNT(*) n, COUNT(DISTINCT session_id) sessions
     FROM corrections ${where} GROUP BY pattern ORDER BY n DESC`,
    params,
  ).filter((r) => (r.n as number) >= minCount);
}

// Coding naturally bounces between these; a pair of two core tools is rhythm, not an automation candidate.
const CORE_TOOLS = new Set([
  "Bash", "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "NotebookEdit",
]);

/**
 * Tool pairs repeated within one session — a loop run by hand, so an automation candidate.
 * Not global frequency: that would rank plain working rhythm at the top.
 */
export function mineToolSequences(
  db: Database,
  since: string | null = null,
  minPerSession = 5,
  minSessions = 3,
): Row[] {
  let where = "WHERE is_sidechain = 0";
  const params: unknown[] = [];
  if (since) {
    where += " AND ts >= ?";
    params.push(since);
  }
  const perSession = new Map<string, number>();
  let previousSession: string | null = null;
  let previousTool: string | null = null;
  for (const row of rows(
    db,
    `SELECT session_id, ts, tool_name FROM tool_calls ${where} ORDER BY session_id, ts`,
    params,
  )) {
    const session = String(row.session_id);
    const tool = String(row.tool_name);
    if (session !== previousSession) previousTool = null;
    if (previousTool && previousTool !== tool) {
      const key = `${session} ${previousTool} ${tool}`;
      perSession.set(key, (perSession.get(key) ?? 0) + 1);
    }
    previousTool = tool;
    previousSession = session;
  }

  type Pair = { sessions: number; max_in_session: number; total: number };
  const pairs = new Map<string, Pair>();
  for (const [key, count] of perSession) {
    if (count < minPerSession) continue;
    const [, from, to] = key.split(" ");
    const pairKey = `${from} ${to}`;
    const found = pairs.get(pairKey) ?? { sessions: 0, max_in_session: 0, total: 0 };
    found.sessions += 1;
    found.max_in_session = Math.max(found.max_in_session, count);
    found.total += count;
    pairs.set(pairKey, found);
  }

  return [...pairs.entries()]
    .map(([key, value]) => {
      const [from, to] = key.split(" ");
      return { from, to, ...value };
    })
    .filter((r) => r.sessions >= minSessions && !(CORE_TOOLS.has(r.from!) && CORE_TOOLS.has(r.to!)))
    .sort((a, b) => b.max_in_session - a.max_in_session)
    .slice(0, 20);
}

const SECTION = /^#\s+([a-z0-9_-]+)/gm;
const SKILL_MENTION = /[`/]([a-z][a-z0-9_-]{2,})[`\s]/g;
const SH_MENTION = /([a-zA-Z0-9_-]+\.sh)/g;

export function mineClaudeMdDrift(db: Database, since: string | null = null): Row[] {
  let text: string;
  try {
    text = readFileSync(CLAUDE_MD_PATH, "utf8");
  } catch {
    return [];
  }
  const headers = [...text.matchAll(SECTION)];
  if (!headers.length) return [];

  const usedSkills = new Set(
    statSkills(db, { limit: 200, since })
      .filter((r) => (r.uses as number) > 0)
      .map((r) => String(r.skill).split(":").pop()),
  );
  const onDisk = skillDirectories();
  const friction = new Map<string, number>();
  for (const row of statHookFriction(db, { limit: 200, since })) {
    const hook = String(row.hook);
    friction.set(hook, (friction.get(hook) ?? 0) + (row.blocks as number));
  }

  const out: Row[] = [];
  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index]!;
    const start = header.index! + header[0].length;
    const end = index + 1 < headers.length ? headers[index + 1]!.index! : text.length;
    const body = text.slice(start, end);

    const mentionedSkills = new Set(
      [...body.matchAll(SKILL_MENTION)].map((m) => m[1]!).filter((name) => onDisk.includes(name)),
    );
    const deadSkills = [...mentionedSkills].filter((name) => !usedSkills.has(name)).sort();
    const mentionedHooks = new Set([...body.matchAll(SH_MENTION)].map((m) => m[1]!));
    const hotHooks = [...friction.entries()]
      .filter(([hook]) => [...mentionedHooks].some((mentioned) => mentioned.includes(hook)))
      .sort((a, b) => b[1] - a[1]);

    if (deadSkills.length || hotHooks.length) {
      out.push({
        section: header[1],
        dead_skill_mentions: deadSkills,
        hot_hook_mentions: hotHooks,
      });
    }
  }
  return out;
}

const FRONTMATTER_MODIFIED = /^modified:\s*(\S+)/m;

/** Ignores `since`: file age is the criterion, not the ingestion window. */
export function mineMemoryHygiene(db: Database, _since: string | null = null,
                                  staleDays = 60, indexLineCap = 150): Row[] {
  const out: Row[] = [];
  const cutoff = Date.now() - staleDays * 86_400_000;
  let projects: string[] = [];
  try {
    projects = readdirSync(PROJECTS_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(PROJECTS_ROOT, entry.name, "memory"));
  } catch {
    return out;
  }
  for (const directory of projects) {
    let entries: string[];
    try {
      entries = readdirSync(directory).filter((name) => name.endsWith(".md"));
    } catch {
      continue;
    }
    const project = basename(join(directory, ".."));
    if (entries.includes("MEMORY.md")) {
      const lines = readFileSync(join(directory, "MEMORY.md"), "utf8").split("\n").length;
      if (lines > indexLineCap) {
        out.push({
          project, issue: "index_size",
          detail: `MEMORY.md has ${lines} lines (cap ${indexLineCap})`,
        });
      }
    }
    for (const name of entries) {
      if (name === "MEMORY.md") continue;
      const path = join(directory, name);
      const text = readFileSync(path, "utf8");
      const declared = text.match(FRONTMATTER_MODIFIED)?.[1];
      const stamp = declared ? Date.parse(declared) : statSync(path).mtimeMs;
      const modified = Number.isNaN(stamp) ? statSync(path).mtimeMs : stamp;
      if (modified < cutoff) {
        const days = Math.floor((Date.now() - modified) / 86_400_000);
        out.push({ project, issue: "stale_memory", detail: `${name} — untouched for ${days} days` });
      }
    }
  }
  return out;
}

export function mineCorrectionClusters(db: Database, since: string | null = null,
                                       minCount = 2): Row[] {
  const where = since ? "WHERE c.ts >= ?" : "";
  const params: unknown[] = since ? [since] : [];
  const found = rows(
    db,
    `SELECT s.cwd cwd, c.pattern pattern, COUNT(*) n,
            GROUP_CONCAT(c.excerpt, ' ||| ') excerpts
     FROM corrections c JOIN sessions s ON s.session_id = c.session_id
     ${where}
     GROUP BY s.cwd, c.pattern HAVING n >= ? ORDER BY n DESC`,
    [...params, minCount],
  );
  for (const row of found) {
    row.excerpts = String(row.excerpts ?? "").split(" ||| ").slice(0, 3);
  }
  return found;
}

export function mineSessionFriction(db: Database, since: string | null = null,
                                    limit = 10): Row[] {
  const clause = since ? "AND s.last_ts >= ?" : "";
  const params: unknown[] = since ? [since] : [];
  return rows(
    db,
    `SELECT s.session_id, s.cwd, s.first_ts, s.last_ts,
            COUNT(DISTINCT tc.tool_use_id) tool_calls, SUM(tc.is_error) errors,
            (SELECT COUNT(*) FROM corrections c WHERE c.session_id = s.session_id) corrections
     FROM sessions s LEFT JOIN tool_calls tc ON tc.session_id = s.session_id
     WHERE 1=1 ${clause}
     GROUP BY s.session_id
     HAVING errors > 0 OR corrections > 0
     ORDER BY (COALESCE(errors,0) + corrections * 2) DESC
     LIMIT ?`,
    [...params, limit],
  );
}

/** Ignores `since`: the age of the last activity is the signal itself. */
export function mineDormantWorkspaces(db: Database, _since: string | null = null,
                                      dormantDays = 21): Row[] {
  const cutoff = Date.now() - dormantDays * 86_400_000;
  const out: Row[] = [];
  for (const row of rows(
    db,
    "SELECT cwd, MAX(last_ts) last_ts, COUNT(*) sessions FROM sessions GROUP BY cwd",
  )) {
    const cwd = row.cwd as string | null;
    if (!cwd) continue;
    try {
      statSync(cwd);
    } catch {
      continue;
    }
    const last = Date.parse(String(row.last_ts));
    if (Number.isNaN(last) || last >= cutoff) continue;
    out.push({
      cwd, last_active: row.last_ts, sessions: row.sessions,
      idle_days: Math.floor((Date.now() - last) / 86_400_000),
    });
  }
  return out;
}

export type MinerEntry = { slug: string; label: string; miner: Miner; context: string };

export const MINERS: MinerEntry[] = [
  { slug: "hook-friction", label: "hook friction", miner: mineHookFriction,
    context: "Each row is (hook, blocked tool, block count)." },
  { slug: "user-rejections", label: "tools the user rejected", miner: mineUserRejections,
    context: "Each row is (denial kind, tool, count, sessions). user-rejected means the person declined; " +
      "automode-blocked means the auto-mode policy did." },
  { slug: "hook-failures", label: "failing hooks", miner: mineHookFailures,
    context: "Each row is (hook, exit code, count, sessions, command). Exit 127 means the executable was " +
      "not found, so that hook is registered but never actually runs." },
  { slug: "unused-skills", label: "unused skills", miner: mineUnusedSkills,
    context: "Each row is (skill, uses=0, sessions=0): never used over the whole recorded period." },
  { slug: "error-rate", label: "high-error tools", miner: mineErrorRate,
    context: "Each row is (tool, calls, errors, sessions, error rate)." },
  { slug: "corrections", label: "repeated corrections", miner: mineCorrections,
    context: "Each row is (matched keyword, count, sessions). This is a keyword heuristic; say that false positives are possible." },
  { slug: "tool-sequences", label: "repeated tool sequences (automation candidates)", miner: mineToolSequences,
    context: "Each row is a tool-call pair repeated within single sessions, with (sessions, max per session, total)." },
  { slug: "claude-md-drift", label: "CLAUDE.md drift", miner: mineClaudeMdDrift,
    context: "Each row is (section, skills mentioned but never used, hooks mentioned but frequently blocking)." },
  { slug: "memory-hygiene", label: "memory hygiene", miner: mineMemoryHygiene,
    context: "Each row is (project, issue, detail)." },
  { slug: "correction-clusters", label: "correction clusters (memory candidates)", miner: mineCorrectionClusters,
    context: "Each row is (project, keyword, count, three excerpts). Propose it as a draft feedback-type memory." },
  { slug: "session-friction", label: "high-friction sessions", miner: mineSessionFriction,
    context: "Each row is (session id, project path, tool calls, errors, corrections)." },
  { slug: "dormant-workspaces", label: "dormant workspaces", miner: mineDormantWorkspaces,
    context: "Each row is (path, last activity, sessions, idle days)." },
];

export const QUALITATIVE_SLUGS = new Set(["claude-md-drift", "correction-clusters"]);

export function frictionWarning(db: Database, days = 14, minBlocks = 3): Row[] {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  return statHookFriction(db, { limit: 200, since }).filter((r) => (r.blocks as number) >= minBlocks);
}

export { statHookRuns };
