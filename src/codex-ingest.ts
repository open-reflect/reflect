import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { HOME } from "./paths.ts";
import { scrub } from "./scrub.ts";
import { CORRECTION, type Insert, memoryPathsIn } from "./ingest.ts";

// Codex rollout files. CODEX_HOME moves them away from ~/.codex; Orca workers use a per-account home.
export function codexSessionRoots(): string[] {
  const roots = [join(HOME, ".codex", "sessions")];
  const custom = process.env.CODEX_HOME ? join(process.env.CODEX_HOME, "sessions") : null;
  if (custom && !roots.includes(custom)) roots.push(custom);
  const accounts = join(HOME, "Library", "Application Support", "orca", "codex-accounts");
  try {
    for (const id of readdirSync(accounts)) roots.push(join(accounts, id, "home", "sessions"));
  } catch {
  }
  return roots;
}

export function isCodexRollout(path: string): boolean {
  return basename(path).startsWith("rollout-") && path.includes("/sessions/");
}

// Not coding sessions: the Codex desktop chat folder, and temp dirs (reflect's judge runs, omp's home fallback).
const NON_WORK_ROOTS = [join(HOME, "Documents", "Codex"), tmpdir(), "/tmp", "/private/tmp", "/var/folders"];
export function isWorkDir(cwd: string | null): cwd is string {
  return !!cwd && !NON_WORK_ROOTS.some((root) => cwd === root || cwd.startsWith(`${root}/`));
}

// Claude handing a task to Codex (codex plugin): the "user" turns are Claude's prompts, not corrections.
const SKIPPED_ORIGINATORS = new Set(["Claude Code"]);

const SESSION_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const FAILED = /"exit_code":\s*[1-9]|Script (?:failed|error)/;
// Guard hooks that block print "[<name>-guard] BLOCKED" on stderr; Codex hands that text back as the tool output.
export const GUARD_BLOCK = /\[([\w-]+-guard)\] BLOCKED/;
const INNER_TOOL = /tools\.(\w+)\(/;

type CodexState = {
  session: string;
  cwd: string | null;
  branch: string | null;
  version: string;
  model: string | null;
  skipped: boolean;
};

/** Rollout lines carry no session id; a parser keeps the file's state across lines. */
export function codexParser(filePath: string): (line: Record<string, any>) => Insert[] {
  const state: CodexState = {
    session: basename(filePath).match(SESSION_ID)?.[0] ?? basename(filePath, ".jsonl"),
    cwd: null, branch: null, version: "codex", model: null, skipped: false,
  };
  return (line) => parseCodexLine(line, state, filePath);
}

function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return "";
  const texts: string[] = [];
  for (const part of output) if (typeof part?.text === "string") texts.push(part.text);
  return texts.join("\n");
}

function userText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const part of content) if (part?.type === "input_text" && typeof part.text === "string") texts.push(part.text);
  return texts.join("\n");
}

/** AGENTS.md, environment context and file mentions arrive as user messages too. */
export function looksTyped(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 2000) return false;
  return !trimmed.startsWith("<") && !trimmed.startsWith("#");
}

// Code mode wraps every tool in one `exec` cell; the first tools.<name>( call says what the cell did.
function toolName(name: string, input: string): string {
  if (name !== "exec") return name;
  return input.match(INNER_TOOL)?.[1] ?? "exec";
}

export function parseCodexLine(line: Record<string, any>, state: CodexState, filePath: string): Insert[] {
  const payload = line.payload ?? {};
  const ts = line.timestamp ?? null;
  if (line.type === "session_meta") {
    state.session = payload.id ?? state.session;
    state.cwd = payload.cwd ?? state.cwd;
    state.branch = payload.git?.branch ?? null;
    state.version = payload.cli_version ? `codex-${payload.cli_version}` : "codex";
    state.skipped = SKIPPED_ORIGINATORS.has(payload.originator);
  } else if (line.type === "turn_context") {
    state.cwd = payload.cwd ?? state.cwd;
    state.model = payload.model ?? state.model;
  }
  if (state.skipped) return [];
  const cwd = state.cwd;
  if (!isWorkDir(cwd)) return [];

  const session = state.session;
  const sessionRow: Insert = {
    table: "sessions",
    values: [session, cwd, state.branch, state.version, ts, ts, 0, filePath],
  };
  const out: Insert[] = [];

  if (line.type === "event_msg" && payload.type === "token_count") {
    const usage = payload.info?.last_token_usage;
    if (!usage) return [];
    // Codex counts cached tokens inside input_tokens; Claude rows keep them apart.
    const cached = usage.cached_input_tokens ?? 0;
    out.push(sessionRow, {
      table: "model_turns",
      values: [
        session, `${session}:${ts}`, ts, state.model,
        (usage.input_tokens ?? 0) - cached, cached, usage.cache_write_input_tokens ?? null,
        usage.output_tokens ?? null, usage.reasoning_output_tokens ?? null, null, 0,
      ],
    });
    return out;
  }
  if (line.type !== "response_item") return out;

  if (payload.type === "custom_tool_call" || payload.type === "function_call") {
    const input: string = payload.input ?? payload.arguments ?? "";
    const name = toolName(payload.name ?? "", input);
    out.push(sessionRow);
    for (const path of memoryPathsIn(input)) {
      out.push({ table: "path_refs", values: [session, payload.call_id, ts, path] });
    }
    out.push({
      table: "tool_calls",
      values: [
        session, payload.id ?? payload.call_id, payload.call_id, ts, `codex:${name}`,
        name.startsWith("mcp__") ? 1 : 0, 0, scrub(input), null, null, null, null, null,
      ],
    });
  } else if (payload.type === "custom_tool_call_output" || payload.type === "function_call_output") {
    const text = outputText(payload.output);
    const guard = text.match(GUARD_BLOCK);
    if (guard) {
      // statHookFriction reads the hook name from Claude's "[bash .../<name>.sh]" prefix.
      const detail = `[bash ~/.claude/hooks/${guard[1]}.sh]: ${text}`;
      out.push(sessionRow, {
        table: "permission_events",
        values: [session, payload.id ?? `${payload.call_id}:out`, ts, "permission-rule", payload.call_id, scrub(detail)],
      });
    }
    out.push({ table: "_tool_result", values: [payload.call_id, FAILED.test(text) ? 1 : 0] });
  } else if (payload.type === "message" && payload.role === "user") {
    const text = userText(payload.content);
    const hit = looksTyped(text) ? text.match(CORRECTION) : null;
    if (hit) {
      out.push(sessionRow, {
        table: "corrections",
        values: [session, payload.id ?? `${session}:${ts}`, ts, hit[0], scrub(text, 300)],
      });
    }
  }
  return out;
}
