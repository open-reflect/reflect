// A pattern list is enough for a personal tool; add a line when a new key shape shows up.
const SECRET = new RegExp(
  [
    "sk-ant-[A-Za-z0-9_-]{20,}",
    "sk-[A-Za-z0-9]{20,}",
    "AKIA[0-9A-Z]{16}",
    "ghp_[A-Za-z0-9]{36}",
    "gh[ousr]_[A-Za-z0-9]{36}",
    "xox[baprs]-[A-Za-z0-9-]{10,}",
    "eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}",
    "(?:bearer)\\s+[A-Za-z0-9._-]{20,}",
    "(?:api[_-]?key|token|secret|password)[\"'\\s:=]+[^\\s\"']{8,}",
  ].join("|"),
  "gi",
);

export const HOOK_COMMAND_CAP = 200;

/** Mask secrets in free text. Objects are serialized to JSON first. */
export function scrub(value: unknown, cap = 4000): string | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) return null;
  return text.replace(SECRET, "[REDACTED]").slice(0, cap);
}
