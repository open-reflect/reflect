/**
 * Settings and login screen. Every row opens a picker on Enter, so there are no shortcuts to learn.
 * bun has no curses; keys.ts handles input, select.ts the pickers.
 *
 */
import { PROVIDER_NAME, SETTINGS, type SettingKey, saveSetting, setting, settingSource } from "./config.ts";
import { PROVIDERS, loginState, runLogin, runLogout } from "./providers.ts";
import { type Choice, select } from "./select.ts";
import { ANSI, columns, pad } from "./term.ts";
import { discardPending, readKey, readLine, setRaw, startReading } from "./keys.ts";

type Line =
  | { kind: "heading"; label: string }
  | { kind: "setting"; key: SettingKey; value: string; note: string; help: string }
  | { kind: "provider"; key: string; value: string; note: string; help: string };

// Suggested values shown first; anything else goes through "Custom…".
const MODEL_SUGGESTIONS: Record<string, string[]> = {
  claude: ["sonnet", "opus", "haiku"],
  codex: ["gpt-5.6-sol"],
};
const WINDOW_SUGGESTIONS = ["7", "14", "30", "60", "90"];
const CUSTOM = "__custom__";
const RESET_TO_DEFAULT = "__default__";

async function buildLines(): Promise<Line[]> {
  const lines: Line[] = [{ kind: "heading", label: "settings" }];
  for (const key of Object.keys(SETTINGS) as SettingKey[]) {
    lines.push({
      kind: "setting", key,
      value: setting(key) ?? "(none)",
      note: settingSource(key),
      help: SETTINGS[key].help,
    });
  }
  lines.push({ kind: "heading", label: "provider" });
  for (const [name, spec] of Object.entries(PROVIDERS)) {
    lines.push({
      kind: "provider", key: name,
      value: await loginState(spec),
      note: name === PROVIDER_NAME() ? "in use" : "",
      help: `login: ${spec.login.join(" ")}`,
    });
  }
  return lines;
}

function firstSelectable(lines: Line[]): number {
  return lines.findIndex((line) => line.kind !== "heading");
}

/** Skip headings — Enter must always land on an actionable row. */
function move(lines: Line[], cursor: number, step: number): number {
  let next = cursor;
  for (let attempt = 0; attempt < lines.length; attempt += 1) {
    next = (next + step + lines.length) % lines.length;
    if (lines[next]!.kind !== "heading") return next;
  }
  return cursor;
}

function draw(lines: Line[], cursor: number, message: string): void {
  const width = columns();
  const out: string[] = [ANSI.clear, `${ANSI.bold}reflect — settings${ANSI.reset}\r\n\r\n`];
  for (const [index, line] of lines.entries()) {
    if (line.kind === "heading") {
      out.push(`${ANSI.dim}${line.label}${ANSI.reset}\r\n`);
      continue;
    }
    const marker = index === cursor ? "❯ " : "  ";
    const text = `${marker}${pad(line.key, 14)}${pad(line.value, 26)}${line.note}`;
    out.push(index === cursor
      ? `${ANSI.reverse}${pad(text, width - 1)}${ANSI.reset}\r\n`
      : `${text}\r\n`);
  }
  const current = lines[cursor];
  const help = current && current.kind !== "heading" ? current.help : "";
  out.push(`\r\n${ANSI.dim}${help}${ANSI.reset}\r\n`);
  out.push(`${ANSI.dim}↑↓ move   Enter open   Esc quit${ANSI.reset}\r\n`);
  if (message) out.push(`\r\n${message}\r\n`);
  process.stdout.write(out.join(""));
}

/** Picker screen: breadcrumb, then select(). The caller redraws the main screen afterwards. */
async function pick(breadcrumb: string, choices: Choice[], initial = 0): Promise<string | null> {
  process.stdout.write(`${ANSI.clear}${ANSI.bold}reflect › ${breadcrumb}${ANSI.reset}\r\n\r\n`);
  return await select(breadcrumb, choices, initial);
}

async function pickValue(key: SettingKey, suggestions: string[], unit = ""): Promise<string> {
  const current = setting(key);
  const choices: Choice[] = suggestions.map((value) => ({
    key: value,
    label: value + unit,
    note: value === current ? "current" : "",
  }));
  choices.push({ key: CUSTOM, label: "Custom…", note: "" });
  choices.push({ key: RESET_TO_DEFAULT, label: "Reset to default", note: SETTINGS[key].fallback ?? "(empty)" });
  const initial = Math.max(0, suggestions.indexOf(current ?? ""));
  const picked = await pick(key, choices, initial);
  if (picked === null) return "cancelled";
  if (picked === RESET_TO_DEFAULT) {
    saveSetting(key, null);
    return `${key} reset to default`;
  }
  let value = picked;
  if (picked === CUSTOM) {
    value = await readLine(`\r\n${key}: `);
    if (!value) return "cancelled";
    if (key === "window_days" && !/^\d+$/.test(value)) return "window_days must be a number";
  }
  saveSetting(key, value);
  return `${key} = ${value}`;
}

async function pickProvider(): Promise<string> {
  const current = PROVIDER_NAME();
  const choices: Choice[] = [];
  for (const [name, spec] of Object.entries(PROVIDERS)) {
    choices.push({
      key: name, label: name, note: await loginState(spec),
      hint: `login: ${spec.login.join(" ")}`,
    });
  }
  const initial = Math.max(0, Object.keys(PROVIDERS).indexOf(current));
  const picked = await pick("provider", choices, initial);
  if (picked === null) return "cancelled";
  saveSetting("provider", picked);
  return `provider = ${picked}`;
}

/** Commands that need browser approval get the real terminal: leave the alt screen and raw mode. */
async function shellOut(run: () => Promise<number>): Promise<number> {
  setRaw(false);
  process.stdout.write(`${ANSI.altScreenOff}${ANSI.showCursor}`);
  const code = await run();
  await readLine("\nPress Enter to continue... ");
  process.stdout.write(`${ANSI.altScreenOn}${ANSI.hideCursor}`);
  setRaw(true);
  return code;
}

async function providerActions(name: string): Promise<string> {
  const spec = PROVIDERS[name]!;
  const state = await loginState(spec);
  const choices: Choice[] = [
    { key: "login", label: "Log in", note: state, hint: `runs: ${spec.login.join(" ")}` },
    { key: "logout", label: "Log out", note: "", hint: `runs: ${spec.logout.join(" ")}` },
  ];
  if (name !== PROVIDER_NAME()) {
    choices.push({ key: "use", label: "Use as default provider", note: "", hint: "judging and synthesis will run here" });
  }
  const picked = await pick(name, choices);
  if (picked === null) return "cancelled";
  if (picked === "use") {
    saveSetting("provider", name);
    return `provider = ${name}`;
  }
  const code = await shellOut(() => (picked === "login" ? runLogin(name, false) : runLogout(name)));
  return `${name} ${picked === "login" ? "login" : "logout"} exit code ${code}`;
}

async function open(line: Line): Promise<string> {
  if (line.kind === "heading") return "";
  if (line.kind === "provider") return await providerActions(line.key);
  if (line.key === "provider") return await pickProvider();
  if (line.key === "judge_model") {
    return await pickValue("judge_model", MODEL_SUGGESTIONS[PROVIDER_NAME()] ?? []);
  }
  return await pickValue("window_days", WINDOW_SUGGESTIONS, " days");
}

export async function run(): Promise<number> {
  if (!process.stdin.isTTY) {
    console.error("The settings screen needs a terminal — use `reflect config` instead");
    return 1;
  }
  process.stdout.write(`${ANSI.altScreenOn}${ANSI.hideCursor}`);
  startReading();
  setRaw(true);
  try {
    let lines = await buildLines();
    let cursor = firstSelectable(lines);
    let message = "";
    for (;;) {
      draw(lines, cursor, message);
      const key = await readKey();
      if (key === "q" || key === "escape" || key === "\x03") return 0;
      if (key === "up" || key === "k") cursor = move(lines, cursor, -1);
      else if (key === "down" || key === "j") cursor = move(lines, cursor, 1);
      else if (key === "enter") {
        message = await open(lines[cursor]!);
        lines = await buildLines();
        cursor = Math.min(cursor, lines.length - 1);
      } else if (key === "r") {
        lines = await buildLines();
        message = "refreshed";
      } else {
        message = "";
      }
    }
  } finally {
    // No process.stdin.pause() here — it makes exit hang after raw-mode input.
    setRaw(false);
    discardPending();
    process.stdout.write(`${ANSI.showCursor}${ANSI.altScreenOff}`);
  }
}
