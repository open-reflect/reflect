import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JUDGE_MODEL, PROVIDER_NAME } from "./config.ts";
import { select } from "./select.ts";

export type ProviderSpec = {
  binary: string;
  login: string[];
  logout: string[];
  status: string[];
  apiKeyEnv: string;
  apiKeyLogin: string[] | null;
};

/**
 * Supported headless CLIs. Credentials stay in each CLI's own store (the keychain);
 * reflect only runs their commands and never keeps a second credential store.
 * apiKeyLogin null means that CLI has no stdin-based key login.
 */
export const PROVIDERS: Record<string, ProviderSpec> = {
  claude: {
    binary: "claude",
    login: ["claude", "auth", "login"],
    logout: ["claude", "auth", "logout"],
    status: ["claude", "auth", "status"],
    apiKeyEnv: "ANTHROPIC_API_KEY",
    apiKeyLogin: null,
  },
  codex: {
    binary: "codex",
    login: ["codex", "login"],
    logout: ["codex", "logout"],
    status: ["codex", "login", "status"],
    apiKeyEnv: "OPENAI_API_KEY",
    apiKeyLogin: ["codex", "login", "--with-api-key"],
  },
};

export function which(binary: string): string | null {
  return Bun.which(binary);
}

/** Resolve argv[0] via PATH — Windows shims like claude.cmd are not found by name alone. */
function resolve(command: string[]): string[] {
  const found = Bun.which(command[0]!);
  return found ? [found, ...command.slice(1)] : command;
}

/** One-line login state. claude answers in JSON, codex in prose. */
export async function loginState(spec: ProviderSpec): Promise<string> {
  if (!which(spec.binary)) return "not installed";
  try {
    const child = Bun.spawn(resolve(spec.status), { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    await child.exited;
    const text = (out || err).trim();
    if (!text) return "(no output)";
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") {
        if (parsed.loggedIn) return `logged in (${parsed.authMethod ?? "unknown method"})`;
        return "not logged in";
      }
    } catch {
      // Not JSON: treat as prose.
    }
    return text.split("\n")[0]!.slice(0, 48);
  } catch (error) {
    return `check failed: ${(error as Error).name}`;
  }
}

/**
 * One headless call; returns the answer text or "" on failure.
 * stdin must be closed: codex exec reads stdin even with a prompt argument and waits for EOF
 * forever; claude -p wastes 3 seconds on the same wait.
 */
export async function ask(
  prompt: string,
  { timeoutMs = 300_000, model = null, provider = null }:
    { timeoutMs?: number; model?: string | null; provider?: string | null } = {},
): Promise<string> {
  const name = provider ?? PROVIDER_NAME();
  const spec = PROVIDERS[name];
  if (!spec) {
    console.error(`[reflect] Unsupported provider: ${name} (${Object.keys(PROVIDERS).join("|")})`);
    return "";
  }

  let answerFile: string | null = null;
  if (name === "codex") answerFile = join(mkdtempSync(join(tmpdir(), "reflect-")), "answer.md");
  const command = commandFor(name, prompt, model, answerFile);

  if (!which(command[0]!)) {
    console.error(`[reflect] ${command[0]} is not on PATH (cron does not see ~/.local/bin)`);
    return "";
  }

  try {
    const child = Bun.spawn(resolve(command), { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    const [out, err] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const code = await child.exited;
    clearTimeout(timer);
    if (code !== 0) {
      console.error(`[reflect] ${command[0]} exit code ${code}: ${err.trim().slice(0, 300)}`);
    }
    if (answerFile) {
      try {
        return readFileSync(answerFile, "utf8").trim();
      } catch {
        return "";
      }
    }
    return out.trim();
  } catch (error) {
    console.error(`[reflect] ${command[0]} failed: ${(error as Error).name}: ${(error as Error).message}`);
    return "";
  }
}

/**
 * argv for one headless call. Judging is a text task, so the session gets nothing to act with:
 * claude runs with no tools, no MCP and no user settings/hooks (the prompt carries transcript-derived
 * text, and an injected instruction must find no tool). This also drops the resident system prompt —
 * measured 86k -> 3k context tokens per call. codex streams events on stdout, so its answer is read
 * from -o, and it runs in a read-only sandbox because it can execute model-written shell commands.
 */
export function commandFor(provider: string, prompt: string, model: string | null,
                           answerFile: string | null): string[] {
  if (provider === "claude") {
    const command = ["claude", "-p", prompt, "--tools", "", "--strict-mcp-config", "--setting-sources", ""];
    if (model) command.push("--model", model);
    return command;
  }
  const command = ["codex", "exec", "--skip-git-repo-check", "--sandbox", "read-only", "-o", answerFile ?? "answer.md"];
  if (model) command.push("-m", model);
  command.push(prompt);
  return command;
}

export function judgeModel(): string | null {
  return JUDGE_MODEL();
}

/** Pick a provider interactively. Non-TTY callers must pass the name explicitly. */
export async function pickProvider(prompt = "Log in to which provider?"): Promise<string | null> {
  const names = Object.keys(PROVIDERS);
  if (!process.stdin.isTTY) {
    console.error(`Pass the provider name (${names.join("|")}) — the picker needs a terminal`);
    return null;
  }
  const choices = [];
  for (const name of names) {
    const spec = PROVIDERS[name]!;
    choices.push({
      key: name,
      label: name + (name === PROVIDER_NAME() ? " (current)" : ""),
      note: await loginState(spec),
      hint: `runs: ${spec.login.join(" ")}`,
    });
  }
  return await select(prompt, choices);
}

/** Browser approval is required — hand over the real terminal. */
export async function runLogin(provider: string | null, useApiKey: boolean): Promise<number> {
  const name = provider ?? (await pickProvider("Log in to which provider?"));
  if (!name) return 1;
  const spec = PROVIDERS[name];
  if (!spec) {
    console.error(`Unsupported provider: ${name} (${Object.keys(PROVIDERS).join("|")})`);
    return 1;
  }
  if (!which(spec.binary)) {
    console.error(`${spec.binary} is not on PATH — install that CLI first`);
    return 1;
  }

  if (useApiKey) {
    if (!spec.apiKeyLogin) {
      console.error(
        `${name} has no API-key login. Set ${spec.apiKeyEnv} in the environment, or run ` +
          `\`${spec.binary} setup-token\` for a long-lived token`,
      );
      return 1;
    }
    const key = process.env[spec.apiKeyEnv] ?? "";
    if (!key) {
      console.error(`${spec.apiKeyEnv} is empty`);
      return 1;
    }
    // Never pass the key as an argument (visible in ps); stdin only.
    console.log(`$ ${spec.apiKeyLogin.join(" ")}  (${spec.apiKeyEnv} via stdin)`);
    const child = Bun.spawn(resolve(spec.apiKeyLogin), { stdin: new TextEncoder().encode(key) });
    return await child.exited;
  }

  console.log(`\nLogging in to ${name} — this opens a browser. Approve with the account you want.`);
  if (spec.apiKeyLogin) {
    console.log(`Without a browser: set ${spec.apiKeyEnv} and run \`reflect login ${name} --api-key\``);
  }
  console.log(`$ ${spec.login.join(" ")}\n`);
  return await Bun.spawn(resolve(spec.login), { stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exited;
}

export async function runLogout(provider: string | null): Promise<number> {
  const name = provider ?? (await pickProvider("Log out of which provider?"));
  if (!name) return 1;
  const spec = PROVIDERS[name];
  if (!spec) {
    console.error(`Unsupported provider: ${name} (${Object.keys(PROVIDERS).join("|")})`);
    return 1;
  }
  console.log(`$ ${spec.logout.join(" ")}`);
  return await Bun.spawn(resolve(spec.logout), { stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exited;
}
