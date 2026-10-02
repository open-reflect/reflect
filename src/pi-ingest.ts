import { closeSync, openSync, readSync } from "node:fs";
import { basename, join } from "node:path";
import { HOME } from "./paths.ts";
import { scrub } from "./scrub.ts";
import { CORRECTION, type Insert, memoryPathsIn } from "./ingest.ts";
import { GUARD_BLOCK, isWorkDir, looksTyped } from "./codex-ingest.ts";

// pi (pi-mono coding agent) and omp (oh-my-pi) share one session format and the same env overrides.
export function piSessionRoots(): string[] {
  const roots = [join(HOME, ".pi", "agent", "sessions"), join(HOME, ".omp", "agent", "sessions")];
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  const sessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
  for (const extra of [agentDir ? join(agentDir, "sessions") : null, sessionDir ?? null]) {
    if (extra && !roots.includes(extra)) roots.push(extra);
  }
  return roots;
}

export function isPiSession(path: string): boolean {
  return piSessionRoots().some((root) => path.startsWith(`${root}/`));
}

type PiState = { session: string; cwd: string | null; version: string; agent: string };

const SESSION_ID = /_([0-9a-f-]{36})\.jsonl$/;

// Only the header line carries cwd, and an incremental read starts past it — so read the header up front.
function readHeader(filePath: string): Record<string, any> | null {
  const buffer = Buffer.alloc(16384);
  let handle: number | null = null;
  try {
    handle = openSync(filePath, "r");
    const read = readSync(handle, buffer, 0, buffer.length, 0);
    for (const raw of buffer.subarray(0, read).toString("utf8").split("\n")) {
      try {
        const line = JSON.parse(raw);
        if (line?.type === "session") return line;
      } catch {
      }
    }
  } catch {
  } finally {
    if (handle !== null) closeSync(handle);
  }
  return null;
}

export function piParser(filePath: string): (line: Record<string, any>) => Insert[] {
  const agent = filePath.includes("/.omp/") ? "omp" : "pi";
  const state: PiState = {
    session: filePath.match(SESSION_ID)?.[1] ?? basename(filePath, ".jsonl"),
    cwd: null, version: agent, agent,
  };
  const header = readHeader(filePath);
  if (header) parsePiLine(header, state, filePath);
  return (line) => parsePiLine(line, state, filePath);
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const part of content) if (part?.type === "text" && typeof part.text === "string") texts.push(part.text);
  return texts.join("\n");
}

export function parsePiLine(line: Record<string, any>, state: PiState, filePath: string): Insert[] {
  const ts = line.timestamp ?? null;
  if (line.type === "session") {
    state.session = line.id ?? state.session;
    state.cwd = line.cwd ?? state.cwd;
    state.version = line.version != null ? `${state.agent}-${line.version}` : state.agent;
    return [];
  }
  if (line.type !== "message" || !isWorkDir(state.cwd)) return [];

  const session = state.session;
  const message = line.message ?? {};
  const sessionRow: Insert = {
    table: "sessions",
    values: [session, state.cwd, null, state.version, ts, ts, 0, filePath],
  };
  const out: Insert[] = [];

  if (message.role === "assistant") {
    out.push(sessionRow);
    const usage = message.usage;
    if (usage) {
      // input already excludes cacheRead, as in Claude rows.
      out.push({
        table: "model_turns",
        values: [
          session, `${session}:${line.id}`, ts, message.model ?? null,
          usage.input ?? null, usage.cacheRead ?? null, usage.cacheWrite ?? null, usage.output ?? null,
          null, null, 0,
        ],
      });
    }
    for (const block of message.content ?? []) {
      if (block?.type !== "toolCall") continue;
      const name: string = block.name ?? "";
      const input = block.arguments ?? {};
      for (const path of memoryPathsIn(JSON.stringify(input))) {
        out.push({ table: "path_refs", values: [session, block.id, ts, path] });
      }
      out.push({
        table: "tool_calls",
        values: [
          session, `${session}:${line.id}:${block.id}`, block.id, ts, `${state.agent}:${name}`,
          name.startsWith("mcp_") ? 1 : 0, 0, scrub(input), null, null, null, null, null,
        ],
      });
    }
  } else if (message.role === "toolResult") {
    const text = contentText(message.content);
    const guard = text.match(GUARD_BLOCK);
    if (guard) {
      // statHookFriction reads the hook name from Claude's "[bash .../<name>.sh]" prefix.
      out.push(sessionRow, {
        table: "permission_events",
        values: [session, `${session}:${line.id}`, ts, "permission-rule", message.toolCallId ?? null,
                 scrub(`[bash ~/.claude/hooks/${guard[1]}.sh]: ${text}`)],
      });
    }
    out.push({ table: "_tool_result", values: [message.toolCallId, message.isError ? 1 : 0] });
  } else if (message.role === "user") {
    const text = contentText(message.content);
    const hit = looksTyped(text) ? text.match(CORRECTION) : null;
    if (hit) {
      out.push(sessionRow, {
        table: "corrections",
        values: [session, `${session}:${line.id}`, ts, hit[0], scrub(text, 300)],
      });
    }
  }
  return out;
}
