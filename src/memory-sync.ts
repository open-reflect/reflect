/**
 * Sync behavior rules from project memory into learned-rules.md.
 *
 * Only the MEMORY.md index is loaded each session; bodies must be opened. Rules of the kind
 * "copying nearby code is wrong here" fail before anyone opens them, so they go into
 * learned-rules.md, which is imported whole.
 *
 * Only `type: feedback` and `type: user` are promoted; `project` and `reference` are facts
 * looked up on demand. Only the block between the markers is managed.
 *
 * Per-file override in frontmatter:
 *     reflect: false   exclude even if feedback
 *     reflect: true    include even if project/reference
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LEARNED_RULES_PATH, PROJECTS_ROOT } from "./paths.ts";

const BEGIN = "<!-- reflect:memory-sync:begin -->";
const END = "<!-- reflect:memory-sync:end -->";
const PROMOTED_TYPES = new Set(["feedback", "user"]);
// Warn inside the block above this size; never block — a missing rule is worse than a big file.
const SIZE_WARN_BYTES = 60_000;

/** Same folding Claude Code applies to project paths: every non-alphanumeric becomes `-`. */
export function slugify(path: string): string {
  return path.replace(/[^A-Za-z0-9]/g, "-");
}

/** Memory attaches to the main checkout, not a worktree — resolve via the git common dir. */
export function memoryDir(cwd = process.env.CLAUDE_PROJECT_DIR ?? process.cwd()): string | null {
  const candidates: string[] = [];
  const git = Bun.which("git");
  if (git) {
    const common = Bun.spawnSync([git, "rev-parse", "--path-format=absolute", "--git-common-dir"],
                                 { cwd, stdin: "ignore" });
    const out = new TextDecoder().decode(common.stdout).trim();
    if (common.exitCode === 0 && out) candidates.push(dirname(out));
  }
  candidates.push(cwd);
  for (const root of candidates) {
    const found = join(PROJECTS_ROOT, slugify(root), "memory");
    if (existsSync(found) && statSync(found).isDirectory()) return found;
  }
  return null;
}

type Parsed = { fields: Record<string, string>; body: string };

export function parseMemory(text: string): Parsed | null {
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return null;
  const front = text.slice(3, end);
  const body = text.slice(end + 4).trim();
  const fields: Record<string, string> = {};
  for (const line of front.split("\n")) {
    const match = line.match(/^\s*([A-Za-z_]+):\s*(.*)$/);
    if (match) fields[match[1]!] = match[2]!.trim().replace(/^["']|["']$/g, "");
  }
  return { fields, body };
}

export function selected(fields: Record<string, string>): boolean {
  const flag = (fields.reflect ?? "").toLowerCase();
  if (flag === "false" || flag === "no") return false;
  if (flag === "true" || flag === "yes") return true;
  return PROMOTED_TYPES.has(fields.type ?? "");
}

/**
 * Managed block body, or null when there are no rules — in which case nothing is written.
 * Overwriting the block with an empty memory dir wipes every rule (this happened when a
 * headless session ran the hook from another cwd).
 */
export function render(directory: string): string | null {
  const entries: string[] = [];
  for (const name of readdirSync(directory).filter((n) => n.endsWith(".md") && n !== "MEMORY.md").sort()) {
    const parsed = parseMemory(readFileSync(join(directory, name), "utf8"));
    if (!parsed || !selected(parsed.fields)) continue;
    const title = parsed.fields.name || name.replace(/\.md$/, "");
    const summary = parsed.fields.description ? ` (${parsed.fields.description})` : "";
    entries.push(`# ${title}${summary}\n\n${parsed.body}`);
  }
  if (!entries.length) return null;

  const lines = [
    BEGIN, "",
    `<!-- Generated — do not edit by hand. Source: the *.md files in ${directory};`,
    "     edit those instead. Nothing outside the markers is touched. -->", "",
    `${entries.length} rule(s) pulled from this project's memory` +
      " (`type: feedback` and `type: user`). Facts and references stay in the MEMORY.md index.", "",
  ];
  const body = entries.join("\n\n");
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > SIZE_WARN_BYTES) {
    lines.push(`> ⚠️ This block is ${Math.floor(bytes / 1024)}KB and is loaded into every session.` +
      " Consider marking fact-like entries `reflect: false`.\n");
  }
  lines.push(body, "", END);
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

/** Replace only the managed block. Skip the write when unchanged so mtime stays meaningful. */
export function sync(rulesPath: string = LEARNED_RULES_PATH, cwd?: string): boolean {
  const directory = memoryDir(cwd);
  if (!directory) return false;
  const block = render(directory);
  if (block === null) return false;

  const current = existsSync(rulesPath) ? readFileSync(rulesPath, "utf8") : "";
  let updated: string;
  if (current.includes(BEGIN) && current.includes(END)) {
    const start = current.indexOf(BEGIN);
    const stop = current.indexOf(END) + END.length;
    updated = current.slice(0, start) + block.replace(/\n+$/, "") + current.slice(stop);
  } else {
    updated = `${current.replace(/\n+$/, "")}\n\n${block}`;
  }
  if (updated === current) return false;
  mkdirSync(dirname(rulesPath), { recursive: true });
  writeFileSync(rulesPath, updated);
  return true;
}
