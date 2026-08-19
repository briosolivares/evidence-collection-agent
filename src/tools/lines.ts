/** Split text into lines on \n or \r\n; a trailing newline does not produce
 * a phantom empty final line (cat -n counts "a\nb\n" as two lines). */
export function splitLines(content: string): string[] {
  const lines = content.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}
