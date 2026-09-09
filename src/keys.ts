/**
 * Key input. bun has no curses, so raw mode and buffering are handled here.
 *
 * One persistent listener: in flowing mode a data event with no listener is dropped,
 * and redraws or login-state checks are exactly when that happens.
 * A chunk may hold several keys (fast typing, paste, pty). Take one, keep the rest.
 */

export type Key = "up" | "down" | "enter" | "escape" | "other" | string;

let pending = "";
let notify: (() => void) | null = null;
let listening = false;

/** Whether any key was read — tells the exit path whether stdin needs cleanup. */
export function wasInteractive(): boolean {
  return listening;
}

export function startReading(): void {
  if (listening) return;
  listening = true;
  process.stdin.on("data", (chunk: Buffer) => {
    pending += chunk.toString("utf8");
    const waiting = notify;
    notify = null;
    waiting?.();
  });
}

function takeKey(): Key | null {
  if (!pending) return null;
  for (const [sequence, key] of [["\x1b[A", "up"], ["\x1b[B", "down"]] as const) {
    if (pending.startsWith(sequence)) {
      pending = pending.slice(sequence.length);
      return key;
    }
  }
  if (pending.startsWith("\x1b[")) {
    pending = pending.slice(3);
    return "other";
  }
  const [first, ...rest] = [...pending];
  pending = rest.join("");
  if (first === "\r" || first === "\n") return "enter";
  if (first === "\x1b") return "escape";
  return first!;
}

export async function readKey(): Promise<Key> {
  for (;;) {
    const key = takeKey();
    if (key) return key;
    await new Promise<void>((resolve) => {
      notify = resolve;
    });
  }
}

/** Read one line. Raw mode is suspended so backspace and paste behave. */
export async function readLine(prompt: string): Promise<string> {
  const wasRaw = savedTty !== null;
  if (wasRaw) setRaw(false);
  process.stdout.write(prompt);
  pending = "";
  while (!/[\r\n]/.test(pending)) {
    await new Promise<void>((resolve) => {
      notify = resolve;
    });
  }
  const answer = pending.split(/[\r\n]/)[0]!.trim();
  pending = "";
  if (wasRaw) setRaw(true);
  return answer;
}

export function discardPending(): void {
  pending = "";
}

let savedTty: string | null = null;

/**
 * Switch raw mode. Returns false on failure so callers can fall back to a numbered prompt.
 *
 * Does not use process.stdin.setRawMode(): on bun 1.3.14 it hangs under a pty
 * (a hang, not an exception, so try/catch cannot help). stty works in the same environment.
 */
export function isRaw(): boolean {
  return savedTty !== null;
}

export function setRaw(on: boolean): boolean {
  if (!process.stdin.isTTY) return false;
  // No-op when already in the requested state: a nested picker re-enabling raw mode would
  // save the raw settings and restore into raw on exit.
  if (on === isRaw()) return true;
  const stty = Bun.which("stty");
  try {
    if (!stty) {
      // No stty on Windows; setRawMode works there.
      process.stdin.setRawMode(on);
      if (on) process.stdin.resume();
      savedTty = on ? "setRawMode" : null;
      return true;
    }
    if (on) {
      const saved = Bun.spawnSync([stty, "-g"], { stdin: "inherit" });
      savedTty = new TextDecoder().decode(saved.stdout).trim() || "sane";
      Bun.spawnSync([stty, "raw", "-echo"], { stdin: "inherit" });
      process.stdin.resume();
    } else {
      Bun.spawnSync([stty, savedTty ?? "sane"], { stdin: "inherit" });
      savedTty = null;
    }
    return true;
  } catch {
    return false;
  }
}
