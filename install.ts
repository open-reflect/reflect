#!/usr/bin/env bun
/**
 * Installer — one command on any OS: `bun install.ts`.
 * Copies the code to ~/.claude/tools/reflect, registers the hooks, creates the `reflect` entry point.
 * Data (~/.claude-reflect) is never touched, so re-running is safe.
 *
 *   bun install.ts            install / update
 *   bun install.ts --check    show hook registration state
 *   bun install.ts --remove   unregister hooks (also sweeps entries left by older installs)
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SRC = import.meta.dir;
const HOME = homedir();
const TOOLS = join(HOME, ".claude", "tools", "reflect");
const SKILLS = join(HOME, ".claude", "skills", "reflect");
const BIN = join(HOME, ".local", "bin");
const SETTINGS = join(HOME, ".claude", "settings.json");
const CLI = join(TOOLS, "src", "cli.ts");
const TIMEOUT_SECONDS = 15;

// Hook commands call cli.ts through bun directly — no bash, no jq — so they work on Windows too.
// memory-sync runs on Stop as well: a SessionStart write may land after that session already
// imported learned-rules.md.
const HOOKS: [string, string][] = [
  ["_stop-hook", "Stop"],
  ["memory-sync", "SessionStart"],
  ["memory-sync", "Stop"],
  ["friction-check", "SessionStart"],
];

// Entries written by earlier versions (Python scripts, bash wrappers, the reflect-ts name).
const LEGACY_MARKERS = [
  "tools/reflect/reflect.py",
  "tools/reflect/sync-memory-rules.py",
  "tools/reflect-ts/src/cli.ts",
  "reflect-collect-stop.sh",
  "reflect-memory-sync.sh",
  "reflect-friction-warning.sh",
];

type HookEntry = { type: string; command: string; timeout?: number };
type Settings = { hooks?: Record<string, { hooks?: HookEntry[] }[]> };

function quote(token: string): string {
  return token.includes(" ") ? `"${token}"` : token;
}

function loadSettings(): Settings | null {
  if (!existsSync(SETTINGS)) {
    console.error(`settings.json not found: ${SETTINGS}`);
    return null;
  }
  return JSON.parse(readFileSync(SETTINGS, "utf8"));
}

/** Backup, write to a temp file, verify it parses, then replace atomically. */
function saveSettings(settings: Settings): void {
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
  copyFileSync(SETTINGS, `${SETTINGS}.bak-${stamp}`);
  const text = `${JSON.stringify(settings, null, 2)}\n`;
  JSON.parse(text);
  writeFileSync(`${SETTINGS}.tmp`, text);
  renameSync(`${SETTINGS}.tmp`, SETTINGS);
}

function commandsOf(settings: Settings, event: string): string[] {
  return (settings.hooks?.[event] ?? []).flatMap((group) => group.hooks ?? []).map((h) => h.command);
}

function registered(settings: Settings): [string, string][] {
  return HOOKS.filter(([arg, event]) =>
    commandsOf(settings, event).some((command) => command.includes(`${CLI} ${arg}`)),
  );
}

/** Installed copy edited by hand, then overwritten by an older source — compare content, not mtime. */
function guard(): boolean {
  const installed = join(TOOLS, "src");
  if (!existsSync(installed)) return true;
  for (const name of ["cli.ts", "tui.ts", "propose.ts", "ingest.ts", "memory-sync.ts"]) {
    const a = join(installed, name);
    const b = join(SRC, "src", name);
    if (!existsSync(a) || !existsSync(b)) continue;
    if (readFileSync(a, "utf8") !== readFileSync(b, "utf8") && statSync(a).mtimeMs > statSync(b).mtimeMs) {
      console.error(`Installed ${name} differs from the source and is newer — installing would discard it.\n  installed: ${a}\n  source:    ${b}`);
      return false;
    }
  }
  return true;
}

function launcher(bun: string): string {
  mkdirSync(BIN, { recursive: true });
  if (process.platform === "win32") {
    const target = join(BIN, "reflect.cmd");
    writeFileSync(target, `@echo off\r\n"${bun}" "${CLI}" %*\r\n`);
    return target;
  }
  const target = join(BIN, "reflect");
  // `bun <file>`, not `bun run <file>`: run adds a wrapper process that never exits after raw-mode input.
  writeFileSync(target, `#!/bin/sh\nexec "${bun}" "${CLI}" "$@"\n`, { mode: 0o755 });
  return target;
}

function registerHooks(bun: string): void {
  const settings = loadSettings();
  if (!settings) return;
  settings.hooks ??= {};
  const already = registered(settings);
  const added: string[] = [];
  for (const [arg, event] of HOOKS) {
    if (already.some(([a, e]) => a === arg && e === event)) continue;
    const command = [bun, CLI, arg].map(quote).join(" ");
    settings.hooks[event] ??= [];
    settings.hooks[event]!.unshift({ hooks: [{ type: "command", command, timeout: TIMEOUT_SECONDS }] });
    added.push(`${arg}:${event}`);
  }
  if (!added.length) {
    console.log("hooks: already registered");
    return;
  }
  saveSettings(settings);
  console.log(`hooks registered: ${added.join(", ")}`);

  const legacy = Object.keys(settings.hooks).filter((event) =>
    commandsOf(settings, event).some((c) => LEGACY_MARKERS.some((m) => c.includes(m))),
  );
  if (legacy.length) {
    console.log(`warning: hooks from an older install are still present (${legacy.join(", ")}) — run \`bun install.ts --remove\` then install again`);
  }
}

function removeHooks(): number {
  const settings = loadSettings();
  if (!settings) return 1;
  const markers = [CLI, ...LEGACY_MARKERS];
  let removed = 0;
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    const kept = groups.filter((group) =>
      !(group.hooks ?? []).some((h) => markers.some((m) => h.command.includes(m))),
    );
    removed += groups.length - kept.length;
    settings.hooks![event] = kept;
  }
  if (!removed) {
    console.log("nothing to remove");
    return 0;
  }
  saveSettings(settings);
  console.log(`hooks removed: ${removed}`);
  return 0;
}

function checkHooks(): number {
  const settings = loadSettings();
  if (!settings) return 1;
  const found = registered(settings);
  const missing = HOOKS.filter(([a, e]) => !found.some(([fa, fe]) => fa === a && fe === e));
  console.log(`registered: ${found.map(([a, e]) => `${a}:${e}`).join(", ") || "none"}`);
  console.log(`missing:    ${missing.map(([a, e]) => `${a}:${e}`).join(", ") || "none"}`);
  return missing.length ? 1 : 0;
}

function main(): number {
  if (process.argv.includes("--remove")) return removeHooks();
  if (process.argv.includes("--check")) return checkHooks();
  const bun = Bun.which("bun");
  if (!bun) {
    console.error("bun is not on PATH — https://bun.sh");
    return 1;
  }
  if (!guard()) return 1;

  mkdirSync(TOOLS, { recursive: true });
  for (const entry of ["src", "test"]) cpSync(join(SRC, entry), join(TOOLS, entry), { recursive: true });
  for (const entry of ["package.json", "tsconfig.json", "LICENSE", "reflect_weekly.sh"]) {
    copyFileSync(join(SRC, entry), join(TOOLS, entry));
  }
  if (process.platform !== "win32") Bun.spawnSync(["chmod", "755", join(TOOLS, "reflect_weekly.sh")]);
  mkdirSync(SKILLS, { recursive: true });
  copyFileSync(join(SRC, "skills", "reflect", "SKILL.md"), join(SKILLS, "SKILL.md"));

  const entry = launcher(bun);
  console.log(`installed: ${TOOLS}`);
  console.log(`cli:       ${entry}`);
  const separator = process.platform === "win32" ? ";" : ":";
  if (!(process.env.PATH ?? "").split(separator).includes(BIN)) {
    console.log(`           (${BIN} is not on PATH — add it to your shell profile)`);
  }
  registerHooks(bun);

  console.log("\nOne step left — schedule the weekly run. The command is the same on every OS:");
  console.log(`  ${quote(bun)} ${quote(CLI)} weekly`);
  console.log(process.platform === "win32"
    ? "  Windows: add it to Task Scheduler, weekly."
    : `  macOS/Linux (cron): 0 9 * * 1 ${join(TOOLS, "reflect_weekly.sh")} >> ${join(TOOLS, "weekly.log")} 2>&1`);
  console.log("\nTry it: reflect collect && reflect stats tokens");
  return 0;
}

process.exit(main());
