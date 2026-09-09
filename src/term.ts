/** Terminal output helpers shared by tui and select: ANSI codes and display width. */

const CSI = "\x1b[";
export const ANSI = {
  altScreenOn: `${CSI}?1049h`,
  altScreenOff: `${CSI}?1049l`,
  hideCursor: `${CSI}?25l`,
  showCursor: `${CSI}?25h`,
  clear: `${CSI}2J${CSI}H`,
  clearBelow: `${CSI}J`,
  reverse: `${CSI}7m`,
  dim: `${CSI}2m`,
  bold: `${CSI}1m`,
  reset: `${CSI}0m`,
  up: (lines: number) => `${CSI}${lines}A`,
};

/** Display width in cells. East Asian characters take two, so length() misaligns tables. */
export function width(text: string): number {
  let total = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0x1f300 && code <= 0x1f9ff);
    total += wide ? 2 : 1;
  }
  return total;
}

export function pad(text: string, columns: number): string {
  return text + " ".repeat(Math.max(0, columns - width(text)));
}

export function columns(): number {
  return process.stdout.columns ?? 80;
}
