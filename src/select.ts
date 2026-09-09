/**
 * Inline list picker. No alternate screen, so the choice stays visible afterwards.
 *
 * Falls back to a numbered prompt when raw mode is unavailable.
 */
import { ANSI, columns, pad, width } from "./term.ts";
import { discardPending, isRaw, readKey, readLine, setRaw, startReading } from "./keys.ts";

export type Choice = { key: string; label: string; note?: string; hint?: string };

function render(title: string, choices: Choice[], cursor: number, redraw: boolean): void {
  const lines: string[] = [];
  if (redraw) lines.push(ANSI.up(choices.length + 2), ANSI.clearBelow);
  lines.push(`${ANSI.bold}${title}${ANSI.reset}\r\n`);
  const labelWidth = Math.max(...choices.map((choice) => width(choice.label)));
  for (const [index, choice] of choices.entries()) {
    const note = choice.note ? `  ${choice.note}` : "";
    const body = `${pad(choice.label, labelWidth)}${note}`;
    const marker = index === cursor ? "❯ " : "  ";
    const text = `${marker}${body}`;
    lines.push(
      index === cursor
        ? `${ANSI.reverse}${pad(text, Math.min(width(text) + 1, columns() - 1))}${ANSI.reset}\r\n`
        : `${text}\r\n`,
    );
  }
  const hint = choices[cursor]?.hint;
  lines.push(`${ANSI.dim}↑↓ move   Enter select   q cancel${hint ? `   ${hint}` : ""}${ANSI.reset}\r\n`);
  process.stdout.write(lines.join(""));
}

async function selectByNumber(title: string, choices: Choice[]): Promise<string | null> {
  console.log(title);
  for (const [index, choice] of choices.entries()) {
    console.log(`  ${index + 1}) ${choice.label}${choice.note ? ` — ${choice.note}` : ""}`);
  }
  const answer = await readLine(`Number or name [1-${choices.length}]: `);
  const byName = choices.find((choice) => choice.key === answer);
  if (byName) return byName.key;
  const picked = Number.parseInt(answer, 10);
  if (picked >= 1 && picked <= choices.length) return choices[picked - 1]!.key;
  console.error(`Unknown choice: ${answer || "(empty)"}`);
  return null;
}

/** Chosen key, or null on cancel. Callers must refuse non-TTY stdin before calling. */
export async function select(title: string, choices: Choice[],
                             initial = 0): Promise<string | null> {
  if (!choices.length) return null;
  startReading();
  const wasRaw = isRaw();
  if (!setRaw(true)) return await selectByNumber(title, choices);

  try {
    let cursor = Math.min(Math.max(initial, 0), choices.length - 1);
    render(title, choices, cursor, false);
    for (;;) {
      const key = await readKey();
      if (key === "q" || key === "escape" || key === "\x03") return null;
      if (key === "enter") return choices[cursor]!.key;
      if (key === "up" || key === "k") cursor = (cursor - 1 + choices.length) % choices.length;
      else if (key === "down" || key === "j") cursor = (cursor + 1) % choices.length;
      else continue;
      render(title, choices, cursor, true);
    }
  } finally {
    // Leave raw mode alone if the caller (the TUI) already had it on.
    if (!wasRaw) setRaw(false);
    discardPending();
  }
}
