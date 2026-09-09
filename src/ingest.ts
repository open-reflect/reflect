import type { Database } from "bun:sqlite";
import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { HOOK_COMMAND_CAP, scrub } from "./scrub.ts";
import { PROJECTS_ROOT } from "./paths.ts";

const HOOK_ATTACHMENT_TYPES = new Set([
  "hook_success",
  "hook_error",
  "hook_non_blocking_error",
  "hook_cancelled",
  "hook_additional_context",
]);

// Keywords that mark a correction. Heuristic; proposals must say false positives are possible.
// Korean and English correction markers. Add your language here.
const CORRECTION = /아니야|아니라|틀렸|다시 해|왜 그랬|하지 말|그게 아니|잘못|되돌려|revert|undo|that's wrong|not what i|don't do that|redo|why did you/i;

type Insert = { table: string; values: unknown[] };

// The only path shape pulled out of shell text: <home>/.claude/projects/<slug>/memory/<file>.md.
// The prefix is kept so the ref matches the absolute paths Read/Write/Edit report; a leading ~ is expanded.
const MEMORY_PATH = /[^\s"'`;|&<>=]*\/\.claude\/projects\/[^\/\s"'`]+\/memory\/[A-Za-z0-9._-]+\.md/g;

export function memoryPathsIn(command: unknown): string[] {
  if (typeof command !== "string") return [];
  const found = (command.match(MEMORY_PATH) ?? []).map((path) =>
    path.replace(/^(~|\$HOME|\$\{HOME\})(?=\/)/, homedir()),
  );
  return [...new Set(found)];
}

function sessionRow(line: Record<string, any>, filePath: string): unknown[] {
  const ts = line.timestamp ?? null;
  return [
    line.sessionId, line.cwd ?? null, line.gitBranch ?? null, line.version ?? null,
    ts, ts, line.isSidechain ? 1 : 0, filePath,
  ];
}

/** Real user text only — command output and system notices are not corrections. */
function looksLikeUserText(line: Record<string, any>, content: string): boolean {
  if (line.isMeta || line.isVisibleInTranscriptOnly) return false;
  if (!content || content.length > 2000) return false;
  return !content.startsWith("<") && !content.startsWith("Caveat:");
}

export function parseLine(line: Record<string, any>, filePath: string): Insert[] {
  const session = line.sessionId;
  if (!session) return [];
  const out: Insert[] = [];
  const ts = line.timestamp ?? null;

  if (line.type === "assistant") {
    out.push({ table: "sessions", values: sessionRow(line, filePath) });
    const message = line.message ?? {};
    const usage = message.usage;
    if (usage) {
      const details = usage.output_tokens_details ?? {};
      out.push({
        table: "model_turns",
        values: [
          session, line.uuid, ts, message.model ?? null,
          usage.input_tokens ?? null, usage.cache_read_input_tokens ?? null,
          usage.cache_creation_input_tokens ?? null, usage.output_tokens ?? null,
          details.thinking_tokens ?? null, usage.service_tier ?? null,
          line.isSidechain ? 1 : 0,
        ],
      });
    }
    for (const block of message.content ?? []) {
      if (block?.type !== "tool_use") continue;
      const name: string = block.name ?? "";
      if (name === "Bash") {
        for (const path of memoryPathsIn(block.input?.command)) {
          out.push({ table: "path_refs", values: [session, block.id, ts, path] });
        }
      }
      out.push({
        table: "tool_calls",
        values: [
          session, line.uuid, block.id, ts, name,
          name.startsWith("mcp__") ? 1 : 0, line.isSidechain ? 1 : 0,
          scrub(block.input), null,
          line.attributionSkill ?? null, line.attributionPlugin ?? null,
          line.attributionMcpServer ?? null, line.attributionMcpTool ?? null,
        ],
      });
    }
  } else if (line.type === "user") {
    out.push({ table: "sessions", values: sessionRow(line, filePath) });
    const content = (line.message ?? {}).content;
    const denial = line.toolDenialKind;
    if (denial && Array.isArray(content) && content.length) {
      const first = content[0];
      out.push({
        table: "permission_events",
        values: [session, line.uuid, ts, denial, first.tool_use_id ?? null, scrub(first.content)],
      });
    } else if (Array.isArray(content) && content.length) {
      const first = content[0];
      if (first?.type === "tool_result") {
        out.push({ table: "_tool_result", values: [first.tool_use_id, first.is_error ? 1 : 0] });
      }
    } else if (typeof content === "string" && looksLikeUserText(line, content)) {
      const hit = content.match(CORRECTION);
      if (hit) {
        out.push({
          table: "corrections",
          values: [session, line.uuid, ts, hit[0], scrub(content, 300)],
        });
      }
    }
  } else if (line.type === "attachment") {
    const attachment = line.attachment ?? {};
    if (HOOK_ATTACHMENT_TYPES.has(attachment.type)) {
      out.push({ table: "sessions", values: sessionRow(line, filePath) });
      out.push({
        table: "hook_events",
        values: [
          session, line.uuid, ts, attachment.hookName ?? null, attachment.hookEvent ?? null,
          attachment.type,
          // hook_name carries the identity; the full command would be one wrapper string filling half the DB.
          scrub(attachment.command, HOOK_COMMAND_CAP),
          attachment.exitCode ?? null, attachment.durationMs ?? null,
          attachment.toolUseID ?? null, scrub(attachment.stderr),
        ],
      });
    }
  }
  return out;
}

const INSERT_SQL: Record<string, string> = {
  tool_calls: `INSERT OR IGNORE INTO tool_calls
    (session_id, uuid, tool_use_id, ts, tool_name, is_mcp, is_sidechain, input_json, is_error,
     attribution_skill, attribution_plugin, attribution_mcp_server, attribution_mcp_tool)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  model_turns: `INSERT OR IGNORE INTO model_turns
    (session_id, uuid, ts, model, input_tokens, cache_read, cache_create, output_tokens,
     thinking_tokens, service_tier, is_sidechain) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  hook_events: `INSERT OR IGNORE INTO hook_events
    (session_id, uuid, ts, hook_name, hook_event, subtype, command, exit_code, duration_ms,
     tool_use_id, stderr) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  permission_events: `INSERT OR IGNORE INTO permission_events
    (session_id, uuid, ts, denial_kind, tool_use_id, detail) VALUES (?,?,?,?,?,?)`,
  corrections: `INSERT OR IGNORE INTO corrections
    (session_id, uuid, ts, pattern, excerpt) VALUES (?,?,?,?,?)`,
  path_refs: `INSERT OR IGNORE INTO path_refs (session_id, tool_use_id, ts, path) VALUES (?,?,?,?)`,
};

const SESSION_UPSERT = `INSERT INTO sessions
  (session_id,cwd,git_branch,version,first_ts,last_ts,is_sidechain,file_path)
  VALUES(?,?,?,?,?,?,?,?)
  ON CONFLICT(session_id) DO UPDATE SET
    cwd=excluded.cwd, git_branch=excluded.git_branch, version=excluded.version,
    first_ts=MIN(sessions.first_ts, excluded.first_ts),
    last_ts =MAX(sessions.last_ts,  excluded.last_ts),
    is_sidechain=MAX(sessions.is_sidechain, excluded.is_sidechain),
    file_path=excluded.file_path`;

/**
 * Ingest one file incrementally. Returns lines parsed, not rows added — the natural keys dedupe.
 * The cursor is for speed; correctness comes from INSERT OR IGNORE. A rotated file is reread.
 */
export function ingestFile(db: Database, path: string): number {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return 0;
  }
  const cursor = db.query("SELECT byte_offset, inode, size FROM ingest_cursor WHERE file_path=?")
    .get(path) as { byte_offset: number; inode: number; size: number } | null;

  // Inode changed or file shrank: the watermark cannot be trusted, read from the start.
  let offset = 0;
  if (cursor && cursor.inode === stat.ino && stat.size >= cursor.size) offset = cursor.byte_offset;
  if (offset >= stat.size) return 0;

  const handle = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(stat.size - offset);
    const read = readSync(handle, buffer, 0, buffer.length, offset);
    return ingestBuffer(db, path, offset, stat.size, stat.ino, buffer.subarray(0, read));
  } finally {
    closeSync(handle);
  }
}

function ingestBuffer(db: Database, path: string, offset: number, size: number,
                      inode: number, bytes: Buffer): number {
  const text = bytes.toString("utf8");
  const lines = text.split("\n");
  // A trailing fragment without newline is still being written; leave it for the next run.
  const complete = text.endsWith("\n") ? lines.length : lines.length - 1;
  let consumed = 0;
  let parsed = 0;
  const errors: [string, number][] = [];

  const insertSession = db.prepare(SESSION_UPSERT);
  const prepared: Record<string, ReturnType<Database["prepare"]>> = {};
  for (const [table, sql] of Object.entries(INSERT_SQL)) prepared[table] = db.prepare(sql);

  const run = db.transaction(() => {
    for (let index = 0; index < complete; index += 1) {
      const raw = lines[index] ?? "";
      consumed += Buffer.byteLength(raw, "utf8") + 1;
      if (!raw.trim()) continue;
      let line: Record<string, any>;
      try {
        line = JSON.parse(raw);
      } catch {
        continue;
      }
      parsed += 1;
      for (const insert of parseLine(line, path)) {
        if (insert.table === "sessions") insertSession.run(...(insert.values as never[]));
        else if (insert.table === "_tool_result") {
          errors.push([insert.values[0] as string, insert.values[1] as number]);
        } else prepared[insert.table]?.run(...(insert.values as never[]));
      }
    }
    for (const [toolUseId, isError] of errors) {
      db.run("UPDATE tool_calls SET is_error=? WHERE tool_use_id=?", [isError, toolUseId]);
    }
    db.run(
      `INSERT INTO ingest_cursor(file_path, byte_offset, inode, size, mtime, updated_at)
       VALUES(?,?,?,?,?,?)
       ON CONFLICT(file_path) DO UPDATE SET byte_offset=excluded.byte_offset,
         inode=excluded.inode, size=excluded.size, mtime=excluded.mtime,
         updated_at=excluded.updated_at`,
      [path, offset + consumed, inode, size, Date.now() / 1000, new Date().toISOString()],
    );
  });
  run();
  return parsed;
}

function* walk(root: string): Generator<string> {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.name.endsWith(".jsonl")) yield path;
  }
}

export function collect(db: Database, root: string = PROJECTS_ROOT): number {
  let total = 0;
  for (const path of walk(root)) total += ingestFile(db, path);
  return total;
}

export function verify(db: Database, root: string = PROJECTS_ROOT): void {
  const files = [...walk(root)];
  const cursors = (db.query("SELECT COUNT(*) c FROM ingest_cursor").get() as { c: number }).c;
  // >= not ==: cleaned-up worktrees remove ingested jsonl files, leaving cursors behind. That is fine.
  if (cursors < files.length) {
    throw new Error(`coverage failed (files not ingested): cursor=${cursors} files=${files.length}`);
  }
  const tables = ["sessions", "tool_calls", "hook_events", "permission_events", "model_turns"];
  const before = Object.fromEntries(
    tables.map((t) => [t, (db.query(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c]),
  );
  collect(db, root);
  const delta: Record<string, number> = {};
  for (const table of tables) {
    const after = (db.query(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;
    if (after < (before[table] ?? 0)) {
      throw new Error(`${table} lost rows: ${before[table]} -> ${after}`);
    }
    if (after !== before[table]) delta[table] = after - (before[table] ?? 0);
  }
  const sessions = (db.query("SELECT COUNT(DISTINCT session_id) c FROM sessions").get() as { c: number }).c;
  const note = Object.keys(delta).length
    ? `, new rows during re-collect +${JSON.stringify(delta)} (this session's own activity)`
    : "";
  console.log(
    `OK  files=${files.length} sessions=${sessions}${note} ` +
      "(resumed sessions span several files, so sessions<=files is normal)",
  );
}
