// The Sherlock owl — the welcome-card illustration. A hand-drawn
// "detective" owl: hooded brow ledge over double-ringed eyes, beak tapering
// into the chin line, and a popped trench-coat collar around a shaded
// chest. Startup-card only; it never renders during agent execution.
//
// Every glyph is one terminal column (ASCII plus ◉ ░ ▒ ▓), so a row's code
// point count is its display width. All 14 rows are mirror-symmetric about
// the axis between columns 12 and 13.

/** The illustration, top to bottom. Whitespace is exact — never reflow. */
export const OWL_LINES = [
  '      .-~~~~~~~~~~-.',
  '     / . , .  . , . \\',
  '    ;   ___    ___   ;',
  "    |  '   '~~'   '  |",
  '    | .-~~~-..-~~~-. |',
  '   |  (( ◉ ))(( ◉ ))  |',
  "    ; '-___-''-___-' ;",
  "    \\  '-. \\  / .-'  /",
  " ,__  \\  '~~\\/~~'  /  __,",
  " \\   '-.   ░░░░   .-'   /",
  '  \\     \\ ░▒▒▒▒░ /     /',
  '   \\     ;░▒▒▒▒░;     /',
  '    \\    |▒▒▓▓▒▒|    /',
  "     '~~~|      |~~~'",
] as const;

/** Display columns of the widest row (the collar line). */
export const OWL_WIDTH = Math.max(...OWL_LINES.map((line) => [...line].length));

/**
 * Color roles within the illustration: `pupil` is the ◉ pair (the only
 * saturated element), `shade` is the ░▒▓ chest gradient, and `feather` is
 * every structural stroke. The art must stay readable with all three
 * rendered in a single color (ANSI disabled).
 */
export type OwlRole = 'feather' | 'pupil' | 'shade';

/** A run of consecutive same-role characters within one row. */
export interface OwlSegment {
  text: string;
  role: OwlRole;
}

function roleOf(char: string): OwlRole {
  if (char === '◉') return 'pupil';
  if (char === '░' || char === '▒' || char === '▓') return 'shade';
  return 'feather';
}

/** Splits a row into maximal same-role runs, preserving every character. */
export function owlLineSegments(line: string): OwlSegment[] {
  const segments: OwlSegment[] = [];
  for (const char of line) {
    const last = segments[segments.length - 1];
    if (last !== undefined && last.role === roleOf(char)) {
      last.text += char;
    } else {
      segments.push({ text: char, role: roleOf(char) });
    }
  }
  return segments;
}
