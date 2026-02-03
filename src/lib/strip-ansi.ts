/**
 * Strip ANSI escape codes from a string.
 * Used to clean CLI output before passing to LLM context.
 */
export function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}
