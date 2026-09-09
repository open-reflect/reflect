import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CONFIG_PATH } from "./paths.ts";

export type SettingKey = "provider" | "judge_model" | "window_days" | "language" | "auto_apply";

/** Setting keys and defaults; `config` prints this table as-is. */
export const SETTINGS: Record<SettingKey, { fallback: string | null; help: string }> = {
  provider: { fallback: "claude", help: "Which headless CLI runs judging and synthesis" },
  judge_model: {
    fallback: null,
    help: "Model for drafts and votes. Empty = sonnet on claude, provider default otherwise",
  },
  window_days: { fallback: "30", help: "How many days of history proposals look at" },
  language: { fallback: "en", help: "Language the model writes proposals and rules in" },
  auto_apply: { fallback: "false", help: "Write judged proposals to learned-rules/memory without review (true/false)" },
};

function stored(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

/** env var > config.json > default. Env wins so a single cron line can override. */
export function setting(name: SettingKey): string | null {
  const fromEnv = process.env[`REFLECT_${name.toUpperCase()}`];
  if (fromEnv) return fromEnv;
  const fromFile = stored()[name];
  if (fromFile !== undefined && fromFile !== "") return fromFile;
  return SETTINGS[name].fallback;
}

export function settingSource(name: SettingKey): string {
  if (process.env[`REFLECT_${name.toUpperCase()}`]) return "env";
  const fromFile = stored()[name];
  if (fromFile !== undefined && fromFile !== "") return "config.json";
  return "default";
}

export function saveSetting(name: SettingKey, value: string | null): void {
  const next = stored();
  if (value === null) delete next[name];
  else next[name] = value;
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`);
}

export const PROVIDER_NAME = () => setting("provider") ?? "claude";
export const JUDGE_MODEL = () =>
  setting("judge_model") ?? (PROVIDER_NAME() === "claude" ? "sonnet" : null);
export const WINDOW_DAYS = () => Number.parseInt(setting("window_days") ?? "30", 10);
