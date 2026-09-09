#!/usr/bin/env bun
import { existsSync, statSync } from "node:fs";
import { type Row } from "./db.ts";
import { connect } from "./db.ts";
import { CONFIG_PATH, DEFAULT_DB } from "./paths.ts";
import { SETTINGS, type SettingKey, saveSetting, setting, settingSource } from "./config.ts";
import { collect, ingestFile, verify } from "./ingest.ts";
import { scanMemoryChanges } from "./memory-watch.ts";
import { basename } from "node:path";
import {
  statHookFriction, statHookRuns, statIo, statIoKinds, statMcp, statMemoryChanges, statSessions,
  statSkills, statTokens, statTools,
} from "./stats.ts";
import { frictionWarning } from "./miners.ts";
import { PROVIDERS, loginState, runLogin, runLogout } from "./providers.ts";
import {
  applyContent, cmdPropose, listQueue, markProposal, reviewInterventions, rollback,
  trackIntervention,
} from "./propose.ts";
import { width } from "./term.ts";
import { wasInteractive } from "./keys.ts";

function printTable(rows: Row[]): void {
  if (!rows.length) {
    console.log("(none)");
    return;
  }
  const columns = Object.keys(rows[0]!);
  const text = (value: unknown) =>
    value === null || value === undefined ? "" : Array.isArray(value) ? value.join(",") : String(value);
  const widths = columns.map((column) =>
    Math.max(width(column), ...rows.map((row) => width(text(row[column])))),
  );
  const pad = (value: string, size: number) => value + " ".repeat(Math.max(0, size - width(value)));
  console.log(columns.map((column, index) => pad(column, widths[index]!)).join("  "));
  console.log(widths.map((size) => "-".repeat(size)).join("  "));
  for (const row of rows) {
    console.log(columns.map((column, index) => pad(text(row[column]), widths[index]!)).join("  "));
  }
}

type Args = {
  command: string | null;
  positional: string[];
  limit: number;
  since: string | null;
  json: boolean;
  unset: boolean;
  apiKey: boolean;
  db: string;
  minAgeDays: number;
  days: number;
  minBlocks: number;
  note: string;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: null, positional: [], limit: 20, since: null, json: false, unset: false,
    apiKey: false, db: DEFAULT_DB, minAgeDays: 7, days: 14, minBlocks: 3, note: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--json") args.json = true;
    else if (token === "--unset") args.unset = true;
    else if (token === "--api-key") args.apiKey = true;
    else if (token === "--limit") args.limit = Number.parseInt(argv[++index] ?? "20", 10);
    else if (token === "--since") args.since = argv[++index] ?? null;
    else if (token === "--db") args.db = argv[++index] ?? DEFAULT_DB;
    else if (token === "--min-age-days") args.minAgeDays = Number.parseInt(argv[++index] ?? "7", 10);
    else if (token === "--days") args.days = Number.parseInt(argv[++index] ?? "14", 10);
    else if (token === "--min-blocks") args.minBlocks = Number.parseInt(argv[++index] ?? "3", 10);
    else if (token === "--note") args.note = argv[++index] ?? "";
    else if (token.startsWith("-")) throw new Error(`Unknown option: ${token}`);
    else if (args.command === null) args.command = token;
    else args.positional.push(token);
  }
  return args;
}

const USAGE = `usage: reflect <command> [options]

  (none) | tui        settings and login screen
  collect             ingest transcripts incrementally
  collect-one <path>  ingest one file
  weekly              collect -> verify -> propose (the one command schedulers call)
  memory-sync         project memory (feedback/user) -> learned-rules.md (SessionStart/Stop hook)
  verify              coverage and no-row-loss check
  stats <kind>        tools|hooks|skills|sessions|tokens|io|mcp
  propose             mine -> draft -> judge -> apply
  queue               proposals awaiting review
  mark <path> <status>          approved|rejected|applied
  apply <target> <content-file> back up, then write
  rollback <backup> <target>
  track <slug> <metric-kind> <metric> [--note]
  review [--min-age-days N]
  config [key] [value] [--unset]
  providers | login [provider] [--api-key] | logout [provider]
  friction-check [--days N] [--min-blocks N]

options: --limit N  --since YYYY-MM-DD  --json  --db <path>`;

function cmdConfig(name: string | undefined, value: string | undefined, unset: boolean): number {
  if (!name) {
    printTable(
      (Object.keys(SETTINGS) as SettingKey[]).map((key) => ({
        key, value: setting(key) ?? "(none)", source: settingSource(key), description: SETTINGS[key].help,
      })),
    );
    console.log(`\nfile: ${CONFIG_PATH}${existsSync(CONFIG_PATH) ? "" : " (not created yet)"}`);
    return 0;
  }
  if (!(name in SETTINGS)) {
    console.error(`Unknown setting: ${name} (${Object.keys(SETTINGS).join(", ")})`);
    return 1;
  }
  const key = name as SettingKey;
  if (unset) {
    saveSetting(key, null);
    console.log(`${key} unset — using default ${SETTINGS[key].fallback ?? "(none)"}`);
  } else if (value === undefined) {
    console.error("Give a value or pass --unset");
    return 1;
  } else {
    saveSetting(key, value);
    console.log(`${key} = ${value}`);
  }
  if (process.env[`REFLECT_${key.toUpperCase()}`]) {
    console.error(`⚠️ REFLECT_${key.toUpperCase()} in the environment overrides this value`);
  }
  return 0;
}

async function cmdProviders(): Promise<number> {
  const rows: Row[] = [];
  for (const [name, spec] of Object.entries(PROVIDERS)) {
    rows.push({
      provider: name,
      "in use": name === (setting("provider") ?? "claude") ? "*" : "",
      binary: Bun.which(spec.binary) ?? `(missing) ${spec.binary}`,
      status: await loginState(spec),
      login: spec.login.join(" "),
    });
  }
  printTable(rows);
  console.log(`\nlog in:  reflect login <${Object.keys(PROVIDERS).join("|")}>`);
  console.log(`set:     reflect config provider <${Object.keys(PROVIDERS).join("|")}>`);
  return 0;
}

function cmdStats(db: ReturnType<typeof connect>, args: Args): number {
  const kind = args.positional[0] ?? "";
  const options = { limit: args.limit, since: args.since };
  const emit = (payload: unknown, tables: [string, Row[]][]) => {
    if (args.json) console.log(JSON.stringify(payload, null, 2));
    else {
      for (const [title, rows] of tables) {
        if (tables.length > 1) console.log(`=== ${title} ===`);
        printTable(rows);
        if (tables.length > 1) console.log();
      }
    }
  };

  if (kind === "hooks") {
    const runs = statHookRuns(db, options);
    const friction = statHookFriction(db, options);
    emit({ runs, friction }, [["hook runs / latency", runs], ["hook friction (permission-rule blocks)", friction]]);
  } else if (kind === "io") {
    const kinds = statIoKinds(db, options);
    const refs = statIo(db, options);
    const changes = statMemoryChanges(db, options);
    emit({ kinds, refs, memory_changes: changes },
         [["reference kinds", kinds], ["top references", refs], ["memory files changed (Stop-hook snapshot)", changes]]);
  } else if (kind === "mcp") {
    const [servers, tools] = statMcp(db, options);
    emit({ servers, tools }, [["MCP servers", servers], ["MCP tools", tools]]);
  } else if (kind === "tools") {
    const rows = statTools(db, options);
    emit(rows, [["", rows]]);
  } else if (kind === "skills") {
    const rows = statSkills(db, options);
    emit(rows, [["", rows]]);
  } else if (kind === "sessions") {
    const rows = statSessions(db, options);
    emit(rows, [["", rows]]);
  } else if (kind === "tokens") {
    const rows = statTokens(db, options);
    emit(rows, [["", rows]]);
  } else {
    console.error("stats <tools|hooks|skills|sessions|tokens|io|mcp>");
    return 1;
  }
  return 0;
}

async function main(argv: string[]): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }

  if (args.command === "help" || args.command === "--help") {
    console.log(USAGE);
    return 0;
  }

  // Commands that need no database run first.
  if (args.command === null || args.command === "tui") {
    const { run } = await import("./tui.ts");
    return await run();
  }
  if (args.command === "memory-sync") {
    // SessionStart/Stop hook. Must never block the session.
    try {
      const { sync } = await import("./memory-sync.ts");
      sync();
    } catch {
    }
    return 0;
  }
  if (args.command === "config") return cmdConfig(args.positional[0], args.positional[1], args.unset);
  if (args.command === "providers") return await cmdProviders();
  if (args.command === "login") return await runLogin(args.positional[0] ?? null, args.apiKey);
  if (args.command === "logout") return await runLogout(args.positional[0] ?? null);
  if (args.command === "apply") {
    const [target, contentFile] = args.positional;
    if (!target || !contentFile) {
      console.error("apply <target> <content-file>");
      return 1;
    }
    applyContent(target, await Bun.file(contentFile).text());
    if (contentFile.endsWith(".apply.md")) {
      const proposal = contentFile.replace(/\.apply\.md$/, ".md");
      const db = connect(args.db);
      try {
        db.run("UPDATE proposal_log SET status='applied' WHERE path=?", [proposal]);
      } finally {
        db.close();
      }
    }
    return 0;
  }
  if (args.command === "rollback") {
    const [backup, target] = args.positional;
    if (!backup || !target) {
      console.error("rollback <backup> <target>");
      return 1;
    }
    rollback(backup, target);
    return 0;
  }

  const db = connect(args.db);
  try {
    return await dispatch(db, args);
  } finally {
    // An open handle keeps the event loop alive and blocks exit.
    db.close();
  }
}

async function dispatch(db: ReturnType<typeof connect>, args: Args): Promise<number> {
  switch (args.command) {
    case "collect":
      console.log(`ingested ${collect(db)} lines`);
      return 0;
    case "collect-one": {
      const path = args.positional[0];
      if (!path) {
        console.error("collect-one <path>");
        return 1;
      }
      const parsed = existsSync(path) && statSync(path).isFile() ? ingestFile(db, path) : 0;
      console.log(`ingested ${parsed} lines from ${path.split("/").pop()}`);
      return 0;
    }
    case "verify":
      verify(db);
      return 0;
    case "_stop-hook": {
      // Stop hook: ingest the transcript named in the stdin JSON. Must never block the session.
      try {
        const payload = JSON.parse(await Bun.stdin.text()) as { transcript_path?: string };
        const path = payload.transcript_path;
        if (path && existsSync(path) && statSync(path).isFile()) {
          ingestFile(db, path);
          // The transcript file name is the session id.
          scanMemoryChanges(db, basename(path, ".jsonl"));
        }
      } catch {
      }
      return 0;
    }
    case "weekly": {
      // The one entry point schedulers call; no per-OS shell scripts.
      console.log(`ingested ${collect(db)} lines`);
      verify(db);
      const written = await cmdPropose(db, new Date().toISOString().slice(0, 10));
      console.log(written.length ? `${written.length} proposal file(s) written` : "no signals mined — nothing proposed");
      for (const path of written) console.log(`  ${path}`);
      return 0;
    }
    case "stats":
      return cmdStats(db, args);
    case "propose": {
      const today = new Date().toISOString().slice(0, 10);
      const written = await cmdPropose(db, today);
      if (!written.length) console.log("no signals mined — nothing proposed");
      else {
        console.log(`${written.length} proposal file(s) written:`);
        for (const path of written) console.log(`  ${path}`);
      }
      return 0;
    }
    case "queue": {
      const rows = listQueue(db);
      if (!rows.length) console.log("no proposals pending");
      else printTable(rows);
      return 0;
    }
    case "mark": {
      const [path, status] = args.positional;
      if (!path || !status) {
        console.error("mark <path> <approved|rejected|applied>");
        return 1;
      }
      markProposal(db, path, status);
      console.log(`${path} -> ${status}`);
      return 0;
    }
    case "track": {
      const [slug, kind, param] = args.positional;
      if (!slug || !kind || !param) {
        console.error("track <slug> <hook_blocks|error_rate> <metric>");
        return 1;
      }
      console.log(`baseline recorded: ${kind}:${param} = ${trackIntervention(db, slug, kind, param, args.note)}`);
      return 0;
    }
    case "review": {
      const results = reviewInterventions(db, args.minAgeDays);
      if (!results.length) console.log("nothing to review (no interventions old enough)");
      for (const row of results) {
        const delta = row.delta_pct as number | null;
        const arrow = delta === null ? "?" : delta < 0 ? "▼" : "▲";
        console.log(`[${row.proposal_slug}] ${row.metric}: ${row.baseline} → ${row.current} (${arrow}${delta}%)  ${row.note}`);
      }
      return 0;
    }
    case "friction-check": {
      for (const row of frictionWarning(db, args.days, args.minBlocks)) {
        console.log(
          `[reflect] hook '${row.hook}' blocked '${row.blocked_tool}' ${row.blocks} times in the last ` +
            `${args.days} days — see \`reflect stats hooks\`.`,
        );
      }
      const pending = listQueue(db);
      if (pending.length) {
        console.log(`[reflect] ${pending.length} proposal(s) awaiting review — see \`reflect queue\`.`);
      }
      return 0;
    }
    default:
      console.error(`Unknown command: ${args.command}\n\n${USAGE}`);
      return 1;
  }
}

const code = await main(process.argv.slice(2));
// After raw-mode input, process.exit() does not return promptly (bun 1.3.14) unless the
// stdin listener is removed. Leave stdin alone otherwise: unref on a TTY stdin blocks exit.
if (wasInteractive()) {
  process.stdin.removeAllListeners("data");
  process.stdin.unref();
}
process.exit(code);
