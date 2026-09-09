/** Behavioral checks; no model is ever called. */
import { afterEach, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "../src/db.ts";
import { ingestFile, memoryPathsIn, parseLine } from "../src/ingest.ts";
import { scanMemoryChanges } from "../src/memory-watch.ts";
import { scrub } from "../src/scrub.ts";
import { statHookFriction, statMcp, statTools } from "../src/stats.ts";
import { mineToolSequences } from "../src/miners.ts";
import { PROVIDERS, commandFor } from "../src/providers.ts";
import { applyContent, rollback, stripFence } from "../src/propose.ts";
import { pad, width } from "../src/term.ts";
import { parseMemory, render, selected, sync } from "../src/memory-sync.ts";

// Built at runtime so secret scanners do not flag the fixture as a real key.
const FAKE_KEY = `sk-ant-${"a".repeat(24)}`;

// Five synthetic lines shaped like the real transcript schema.
const LINES = [
  {
    type: "assistant", sessionId: "s1", uuid: "u1", timestamp: "2026-08-27T00:00:00.000Z",
    version: "1.0.0", cwd: "/tmp/proj", gitBranch: "main", isSidechain: false,
    attributionSkill: "jira-start",
    message: {
      role: "assistant", model: "claude-opus-5",
      usage: { input_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: 20,
               output_tokens: 40, output_tokens_details: { thinking_tokens: 12 },
               service_tier: "standard" },
      content: [{ type: "tool_use", id: "toolu_1", name: "Bash",
                  input: { command: `curl -H 'Authorization: Bearer ${FAKE_KEY}'` } }],
    },
  },
  {
    type: "user", sessionId: "s1", uuid: "u2", timestamp: "2026-08-27T00:00:01.000Z",
    cwd: "/tmp/proj",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", is_error: true,
                                         content: "boom" }] },
  },
  {
    type: "assistant", sessionId: "s1", uuid: "u3", timestamp: "2026-08-27T00:00:02.000Z",
    cwd: "/tmp/proj",
    message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_2", name: "Write",
                                              input: { file_path: "/tmp/proj/a.kt" } }] },
  },
  {
    type: "user", sessionId: "s1", uuid: "u4", timestamp: "2026-08-27T00:00:03.000Z",
    cwd: "/tmp/proj", toolDenialKind: "permission-rule",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_2", is_error: true,
                  content: "PreToolUse:Write hook error: [bash /home/example/.claude/hooks/example-guard.sh]: " +
                    "[example-guard] BLOCKED: branch 'main' has no ticket key." }],
    },
  },
  {
    type: "attachment", sessionId: "s1", uuid: "u5", timestamp: "2026-08-27T00:00:04.000Z",
    cwd: "/tmp/proj",
    attachment: { type: "hook_success", hookName: "PreToolUse:example-guard",
                  hookEvent: "PreToolUse", command: `bash example-guard.sh TOKEN=${FAKE_KEY}`,
                  exitCode: 0, durationMs: 12, toolUseID: "toolu_3", stderr: null },
  },
];

function fixture(): { db: ReturnType<typeof connect>; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "reflect-ts-test-"));
  const path = join(directory, "s1.jsonl");
  writeFileSync(path, `${LINES.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return { db: connect(":memory:"), path };
}

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const task of cleanup.splice(0)) task();
});

test("masks secrets", () => {
  expect(scrub(`Bearer ${FAKE_KEY}`)).not.toContain("sk-ant-");
  expect(scrub({ password: "hunter22222222" })).toContain("[REDACTED]");
  expect(scrub("plain text")).toBe("plain text");
  expect(scrub("x".repeat(5000))?.length).toBe(4000);
});

test("ingest fills the tables and pairs errors", () => {
  const { db, path } = fixture();
  expect(ingestFile(db, path)).toBe(LINES.length);
  const count = (table: string) =>
    (db.query(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;
  expect(count("sessions")).toBe(1);
  expect(count("tool_calls")).toBe(2);
  expect(count("model_turns")).toBe(1);
  expect(count("hook_events")).toBe(1);
  expect(count("permission_events")).toBe(1);

  const turn = db.query("SELECT * FROM model_turns").get() as Record<string, unknown>;
  expect(turn.thinking_tokens).toBe(12);
  expect(turn.model).toBe("claude-opus-5");

  const bash = statTools(db).find((row) => row.tool_name === "Bash");
  expect(bash?.errors).toBe(1);

  // Hook name is extracted from the denial message.
  expect(statHookFriction(db)).toEqual([
    { hook: "example-guard", blocked_tool: "Write", blocks: 1 },
  ]);

  // Secrets must not reach the database.
  const stored = db.query("SELECT input_json FROM tool_calls WHERE tool_name='Bash'")
    .get() as { input_json: string };
  expect(stored.input_json).not.toContain("sk-ant-");
});

test("re-ingest adds no duplicate rows", () => {
  const { db, path } = fixture();
  ingestFile(db, path);
  const before = (db.query("SELECT COUNT(*) c FROM tool_calls").get() as { c: number }).c;
  db.run("DELETE FROM ingest_cursor");
  ingestFile(db, path);
  expect((db.query("SELECT COUNT(*) c FROM tool_calls").get() as { c: number }).c).toBe(before);
});

test("io_refs view classifies file and memory references", () => {
  const { db, path } = fixture();
  ingestFile(db, path);
  const refs = db.query("SELECT kind, ref FROM io_refs").all() as { kind: string; ref: string }[];
  expect(refs).toContainEqual({ kind: "file", ref: "/tmp/proj/a.kt" });
});

test("apply and rollback", () => {
  const directory = mkdtempSync(join(tmpdir(), "reflect-ts-apply-"));
  const target = join(directory, "scratch.conf");
  writeFileSync(target, "old-line\n");
  applyContent(target, "new-line\n");
  expect(readFileSync(target, "utf8")).toBe("new-line\n");

  const backups = require("node:fs").readdirSync(require("../src/paths.ts").ROLLBACK_DIR)
    .filter((name: string) => name.startsWith("scratch.conf."));
  expect(backups.length).toBeGreaterThan(0);
  const latest = join(require("../src/paths.ts").ROLLBACK_DIR, backups.sort().pop()!);
  rollback(latest, target);
  expect(readFileSync(target, "utf8")).toBe("old-line\n");
  cleanup.push(() => require("node:fs").unlinkSync(latest));
});

test("merge judging keeps existing content and appends one section", async () => {
  const current = "# rule-one (summary)\n\nbody one\n\n# rule-two (summary)\n\nbody two\n";
  const prompts: string[] = [];
  // ESM exports are read-only, so bun:test's mock.module swaps the module instead.
  const actual = await import("../src/providers.ts");
  mock.module("../src/providers.ts", () => ({
    ...actual,
    ask: async (prompt: string) => {
      prompts.push(prompt);
      if (/^Take the /.test(prompt)) return "a change";
      if (prompt.startsWith("Judge whether")) return "KEEP\nwithin the evidence";
      return "# rule-three (new rule)\n\nbody three";
    },
  }));
  try {
    const { judgeQualitative: judge } = await import("../src/propose.ts");
    const judged = await judge("evidence", "merge", "/tmp/rules.md", current);
    expect(judged.verdict).toBe("judged");
    if (judged.verdict !== "judged") return;
    expect(judged.new_content.startsWith(current.trimEnd())).toBe(true);
    expect(judged.new_content.trimEnd().endsWith("body three")).toBe(true);

    // Only headings go into the prompt, never bodies.
    const synth = prompts.find((prompt) => prompt.startsWith("Below are the headings"))!;
    expect(synth).toContain("# rule-one (summary)");
    expect(synth).not.toContain("body one");
  } finally {
    mock.module("../src/providers.ts", () => actual);
  }
});

test("provider table has login, logout and status commands", () => {
  for (const spec of Object.values(PROVIDERS)) {
    expect(spec.login.length).toBeGreaterThan(0);
    expect(spec.logout.length).toBeGreaterThan(0);
    expect(spec.status.length).toBeGreaterThan(0);
  }
  expect(PROVIDERS.codex?.apiKeyLogin).toEqual(["codex", "login", "--with-api-key"]);
  // claude has no stdin key login; the table records that.
  expect(PROVIDERS.claude?.apiKeyLogin).toBeNull();
});

test("wide characters count as two cells", () => {
  expect(width("claude")).toBe(6);
  expect(width("로그인됨 (claude.ai)")).toBe(20); // 4 Hangul (2 cells each) + 12 ASCII
  for (const text of ["claude", "(없음)", "로그인됨 (claude.ai)", "日本語"]) {
    expect(width(pad(text, 26))).toBe(26);
  }
});

test("stripFence keeps only the fenced body", () => {
  expect(stripFence("intro\n```md\nbody\n```\nafter")).toBe("body\n");
  expect(stripFence("no fence")).toBe("no fence\n");
});

test("memory sync promotes feedback/user only and writes nothing for zero rules", () => {
  const directory = mkdtempSync(join(tmpdir(), "reflect-mem-"));
  writeFileSync(join(directory, "MEMORY.md"), "- index\n");
  writeFileSync(join(directory, "a-rule.md"), "---\nname: a-rule\ndescription: a rule\nmetadata:\n  type: feedback\n---\n\nbody A\n");
  writeFileSync(join(directory, "fact.md"), "---\nname: fact\nmetadata:\n  type: project\n---\n\na fact\n");
  writeFileSync(join(directory, "forced.md"), "---\nname: forced\nreflect: true\nmetadata:\n  type: reference\n---\n\nforced in\n");

  expect(selected(parseMemory(readFileSync(join(directory, "a-rule.md"), "utf8"))!.fields)).toBe(true);
  expect(selected(parseMemory(readFileSync(join(directory, "fact.md"), "utf8"))!.fields)).toBe(false);

  const block = render(directory)!;
  expect(block).toContain("# a-rule (a rule)");
  expect(block).toContain("# forced");
  expect(block).not.toContain("# fact");
  expect(block).toContain("2 rule(s)");

  // A directory without rules yields null so the managed block is never blanked.
  const empty = mkdtempSync(join(tmpdir(), "reflect-mem-empty-"));
  writeFileSync(join(empty, "fact.md"), "---\nmetadata:\n  type: project\n---\n\na fact\n");
  expect(render(empty)).toBeNull();
});

test("memory sync replaces only the managed block and skips unchanged writes", () => {
  const directory = mkdtempSync(join(tmpdir(), "reflect-mem-"));
  writeFileSync(join(directory, "r.md"), "---\nname: r\nmetadata:\n  type: user\n---\n\nbody\n");
  // memoryDir resolves by cwd slug; mimic it with a matching memory dir under PROJECTS_ROOT.
  const { PROJECTS_ROOT } = require("../src/paths.ts");
  const fakeCwd = mkdtempSync(join(tmpdir(), "reflect-proj-"));
  const projectMemory = join(PROJECTS_ROOT, fakeCwd.replace(/[^A-Za-z0-9]/g, "-"), "memory");
  require("node:fs").mkdirSync(projectMemory, { recursive: true });
  require("node:fs").copyFileSync(join(directory, "r.md"), join(projectMemory, "r.md"));
  cleanup.push(() => require("node:fs").rmSync(join(PROJECTS_ROOT, fakeCwd.replace(/[^A-Za-z0-9]/g, "-")), { recursive: true, force: true }));

  const rules = join(directory, "learned-rules.md");
  writeFileSync(rules, "hand-written preamble\n\n<!-- reflect:memory-sync:begin -->\nold block\n<!-- reflect:memory-sync:end -->\n\nappended rule\n");
  expect(sync(rules, fakeCwd)).toBe(true);
  const after = readFileSync(rules, "utf8");
  expect(after.startsWith("hand-written preamble")).toBe(true);
  expect(after).toContain("# r");
  expect(after).not.toContain("old block");
  expect(after.trimEnd().endsWith("appended rule")).toBe(true);
  expect(sync(rules, fakeCwd)).toBe(false);
});

// Regression: map keys were once joined with a NUL byte and split by "" — names came back one character long.
test("sequence miner and MCP stats keep whole tool names in their keys", () => {
  const db = connect(":memory:");
  const insert = db.prepare(
    `INSERT INTO tool_calls (session_id, uuid, tool_use_id, ts, tool_name, is_mcp, is_sidechain, input_json, is_error)
     VALUES (?,?,?,?,?,?,0,'{}',?)`,
  );
  for (const session of ["s1", "s2", "s3"]) {
    for (let step = 0; step < 12; step += 1) {
      const name = step % 2 ? "mcp__example-db__query" : "Bash";
      insert.run(session, `${session}-u${step}`, `${session}-t${step}`, `2026-09-01T00:00:${String(step).padStart(2, "0")}Z`,
                 name, name.startsWith("mcp__") ? 1 : 0, step % 5 === 0 ? 1 : 0);
    }
  }
  const pairs = mineToolSequences(db, null);
  expect(pairs.map((p) => `${p.from}>${p.to}`)).toContain("Bash>mcp__example-db__query");
  expect(pairs.every((p) => (p.from as string).length > 1 && (p.to as string).length > 1)).toBe(true);

  const [servers, tools] = statMcp(db);
  expect(servers[0]).toMatchObject({ server: "example-db", calls: 18 });
  expect(tools[0]).toMatchObject({ server: "example-db", tool: "query", calls: 18 });
});

test("headless calls get no tools, no MCP and no user settings", () => {
  const claude = commandFor("claude", "q", "sonnet", null);
  expect(claude.slice(0, 3)).toEqual(["claude", "-p", "q"]);
  for (const flag of ["--tools", "--strict-mcp-config", "--setting-sources"]) expect(claude).toContain(flag);
  expect(claude[claude.indexOf("--tools") + 1]).toBe("");
  expect(claude.slice(-2)).toEqual(["--model", "sonnet"]);

  const codex = commandFor("codex", "q", null, "/tmp/a.md");
  expect(codex).toContain("--sandbox");
  expect(codex[codex.indexOf("--sandbox") + 1]).toBe("read-only");
  expect(codex.at(-1)).toBe("q");
});

test("propose keeps judged content for review unless auto_apply is on", async () => {
  const root = mkdtempSync(join(tmpdir(), "reflect-propose-"));
  const rules = join(root, "learned-rules.md");
  writeFileSync(rules, "# existing (rule)\n\nbody\n");
  const actual = await import("../src/providers.ts");
  mock.module("../src/providers.ts", () => ({
    ...actual,
    ask: async (prompt: string) => {
      if (/^Take the /.test(prompt)) return "a change";
      if (prompt.startsWith("Judge whether")) return "KEEP\nfine";
      if (prompt.startsWith("Below are the headings")) return "# new-rule (from judging)\n\nnew body";
      return "proposal text";
    },
  }));
  try {
    const { cmdPropose } = await import("../src/propose.ts");
    const db = connect(":memory:");
    const options = {
      miners: [{ slug: "claude-md-drift", label: "drift", miner: () => [{ section: "x" }], context: "" }],
      proposalsDir: join(root, "proposals"), learnedRules: rules, rollbackDir: join(root, "rollback"),
    };

    const reviewed = await cmdPropose(db, "2026-09-01", { ...options, autoApply: false });
    expect(reviewed.some((p) => p.endsWith(".apply.md"))).toBe(true);
    expect(readFileSync(rules, "utf8")).toBe("# existing (rule)\n\nbody\n");
    expect((db.query("SELECT status FROM proposal_log").get() as { status: string }).status).toBe("pending");

    await cmdPropose(db, "2026-09-08", { ...options, autoApply: true });
    expect(readFileSync(rules, "utf8")).toContain("# new-rule (from judging)");
    const statuses = db.query("SELECT status FROM proposal_log ORDER BY created_at").all() as { status: string }[];
    expect(statuses.map((s) => s.status)).toEqual(["superseded", "applied"]);
  } finally {
    mock.module("../src/providers.ts", () => actual);
  }
});

test("memory paths inside Bash commands are extracted and show up in io_refs", () => {
  const command = "cat > /Users/x/.claude/projects/-Users-x-proj/memory/a-rule.md <<EOF\n...\nEOF\n"
    + "sed -n 1,3p /Users/x/.claude/projects/-Users-x-proj/memory/MEMORY.md; ls /tmp/not-memory/x.md";
  expect(memoryPathsIn(command)).toEqual([
    "/Users/x/.claude/projects/-Users-x-proj/memory/a-rule.md",
    "/Users/x/.claude/projects/-Users-x-proj/memory/MEMORY.md",
  ]);
  expect(memoryPathsIn("echo hi")).toEqual([]);

  const db = connect(":memory:");
  const line = {
    type: "assistant", sessionId: "s9", uuid: "u9", timestamp: "2026-09-01T00:00:00Z", cwd: "/tmp",
    message: { content: [{ type: "tool_use", id: "t9", name: "Bash", input: { command } }] },
  };
  const inserts = parseLine(line, "/x.jsonl");
  expect(inserts.filter((i) => i.table === "path_refs")).toHaveLength(2);
  for (const insert of inserts) {
    if (insert.table === "path_refs") db.run("INSERT INTO path_refs VALUES (?,?,?,?)", insert.values as never[]);
    if (insert.table === "tool_calls") {
      db.run(`INSERT INTO tool_calls (session_id, uuid, tool_use_id, ts, tool_name, is_mcp, is_sidechain, input_json, is_error,
              attribution_skill, attribution_plugin, attribution_mcp_server, attribution_mcp_tool) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
             insert.values as never[]);
    }
  }
  const refs = db.query("SELECT kind, tool_name, ref FROM io_refs WHERE session_id='s9' ORDER BY ref").all();
  expect(refs).toEqual([
    { kind: "memory", tool_name: "Bash", ref: "/Users/x/.claude/projects/-Users-x-proj/memory/MEMORY.md" },
    { kind: "memory", tool_name: "Bash", ref: "/Users/x/.claude/projects/-Users-x-proj/memory/a-rule.md" },
  ]);
});

test("memory snapshot records created, modified and deleted files after seeding", () => {
  const root = mkdtempSync(join(tmpdir(), "reflect-memroot-"));
  const memory = join(root, "-proj", "memory");
  require("node:fs").mkdirSync(memory, { recursive: true });
  writeFileSync(join(memory, "a.md"), "a");
  const db = connect(":memory:");

  expect(scanMemoryChanges(db, "s1", root, "2026-09-01T00:00:00Z")).toBe(0); // seeding is silent
  writeFileSync(join(memory, "a.md"), "a changed");
  require("node:fs").utimesSync(join(memory, "a.md"), new Date(), new Date(Date.now() + 5000));
  writeFileSync(join(memory, "b.md"), "b");
  expect(scanMemoryChanges(db, "s1", root, "2026-09-01T00:01:00Z")).toBe(2);
  require("node:fs").unlinkSync(join(memory, "b.md"));
  expect(scanMemoryChanges(db, "s1", root, "2026-09-01T00:02:00Z")).toBe(1);

  const changes = db.query("SELECT change, path FROM memory_changes ORDER BY ts, path").all() as { change: string; path: string }[];
  expect(changes.map((c) => `${c.change}:${c.path.split("/").pop()}`)).toEqual(["modified:a.md", "created:b.md", "deleted:b.md"]);
});
