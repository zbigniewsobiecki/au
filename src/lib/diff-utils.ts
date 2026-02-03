/**
 * Diff utilities for displaying colored diffs in CLI output.
 */

import chalk from "chalk";
import { stripAnsi } from "./strip-ansi.js";

/**
 * Extract the diff portion from a SysMLWrite result string.
 * The result format is:
 * ```
 * path=.sysml/foo.sysml status=success mode=upsert delta=+50 bytes
 * Element replaced at scope: PackageName
 * Added: 1, Replaced: 0
 *
 * - old line
 * + new line
 * ```
 *
 * Note: Diff output may contain ANSI color codes (e.g., \x1b[31m for red),
 * so we strip them before testing the pattern.
 *
 * @param result - The SysMLWrite result string
 * @returns The diff portion (lines starting with +/-/space) or null if no diff found
 */
export function extractDiffFromResult(result: string): string | null {
  // Diff starts after a double newline
  const parts = result.split("\n\n");
  if (parts.length >= 2) {
    const diffPart = parts.slice(1).join("\n\n");
    // Check if it looks like a diff (has lines starting with +, -, or dimmed context spaces)
    // Strip ANSI codes before testing since generateColoredDiff() produces colored output
    if (/^[+-\s]/.test(stripAnsi(diffPart)) && diffPart.trim().length > 0) {
      return diffPart;
    }
  }
  return null;
}

/**
 * Generate a simple colored diff between two strings.
 * Uses a line-by-line comparison with unified diff format.
 *
 * @param before - Original content
 * @param after - New content
 * @param maxLines - Maximum lines to show (default 20)
 * @returns Colored diff string for CLI display
 */
export function generateColoredDiff(
  before: string,
  after: string,
  maxLines = 20
): string {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");

  // Simple LCS-based diff
  const diff = computeLineDiff(beforeLines, afterLines);

  // Format with colors
  const lines: string[] = [];
  let shown = 0;

  for (const entry of diff) {
    if (shown >= maxLines) {
      lines.push(chalk.dim(`... ${diff.length - shown} more lines`));
      break;
    }

    if (entry.type === "remove") {
      lines.push(chalk.red(`- ${entry.line}`));
      shown++;
    } else if (entry.type === "add") {
      lines.push(chalk.green(`+ ${entry.line}`));
      shown++;
    } else if (entry.type === "context") {
      // Show context lines (unchanged) only near changes
      lines.push(chalk.dim(`  ${entry.line}`));
      shown++;
    }
  }

  return lines.join("\n");
}

/**
 * Generate a plain-text diff between two strings (no ANSI colors).
 * Uses the same logic as generateColoredDiff but with plain prefixes.
 * Suitable for inclusion in LLM context where ANSI codes are unwanted.
 *
 * @param before - Original content
 * @param after - New content
 * @param maxLines - Maximum lines to show (default 20)
 * @returns Plain diff string with - / + / space prefixes
 */
export function generatePlainDiff(
  before: string,
  after: string,
  maxLines = 20
): string {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");

  const diff = computeLineDiff(beforeLines, afterLines);

  const lines: string[] = [];
  let shown = 0;

  for (const entry of diff) {
    if (shown >= maxLines) {
      lines.push(`... ${diff.length - shown} more lines`);
      break;
    }

    if (entry.type === "remove") {
      lines.push(`- ${entry.line}`);
      shown++;
    } else if (entry.type === "add") {
      lines.push(`+ ${entry.line}`);
      shown++;
    } else if (entry.type === "context") {
      lines.push(`  ${entry.line}`);
      shown++;
    }
  }

  return lines.join("\n");
}

interface DiffEntry {
  type: "add" | "remove" | "context";
  line: string;
}

/**
 * Compute a line-by-line diff using a simple algorithm.
 * Returns entries with context around changes.
 */
function computeLineDiff(before: string[], after: string[]): DiffEntry[] {
  const result: DiffEntry[] = [];

  // Use a simple approach: find the longest common subsequence
  // For CLI display, we don't need a perfect diff - just show what changed
  const lcs = longestCommonSubsequence(before, after);
  const lcsSet = new Set(lcs.map((_, i) => `${lcs[i].beforeIdx}:${lcs[i].afterIdx}`));

  let beforeIdx = 0;
  let afterIdx = 0;
  let lcsIdx = 0;

  while (beforeIdx < before.length || afterIdx < after.length) {
    if (lcsIdx < lcs.length) {
      const match = lcs[lcsIdx];

      // Add removed lines (before the match in 'before')
      while (beforeIdx < match.beforeIdx) {
        result.push({ type: "remove", line: before[beforeIdx] });
        beforeIdx++;
      }

      // Add added lines (before the match in 'after')
      while (afterIdx < match.afterIdx) {
        result.push({ type: "add", line: after[afterIdx] });
        afterIdx++;
      }

      // Add context line (the match)
      result.push({ type: "context", line: before[beforeIdx] });
      beforeIdx++;
      afterIdx++;
      lcsIdx++;
    } else {
      // No more matches - remaining lines are changes
      while (beforeIdx < before.length) {
        result.push({ type: "remove", line: before[beforeIdx] });
        beforeIdx++;
      }
      while (afterIdx < after.length) {
        result.push({ type: "add", line: after[afterIdx] });
        afterIdx++;
      }
    }
  }

  // Trim excessive context - only show context near actual changes
  return trimContext(result, 2);
}

interface LCSMatch {
  beforeIdx: number;
  afterIdx: number;
}

/**
 * Find the longest common subsequence of lines.
 * Uses a simple DP approach - good enough for typical file sizes.
 */
function longestCommonSubsequence(before: string[], after: string[]): LCSMatch[] {
  const m = before.length;
  const n = after.length;

  // For very large files, use a simplified approach
  if (m * n > 1000000) {
    return simpleLCS(before, after);
  }

  // Standard LCS DP
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (before[i - 1] === after[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find the LCS
  const result: LCSMatch[] = [];
  let i = m;
  let j = n;

  while (i > 0 && j > 0) {
    if (before[i - 1] === after[j - 1]) {
      result.unshift({ beforeIdx: i - 1, afterIdx: j - 1 });
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return result;
}

/**
 * Simplified LCS for large files - just match identical consecutive blocks.
 */
function simpleLCS(before: string[], after: string[]): LCSMatch[] {
  const result: LCSMatch[] = [];
  const afterMap = new Map<string, number[]>();

  // Index 'after' lines
  for (let j = 0; j < after.length; j++) {
    const line = after[j];
    if (!afterMap.has(line)) {
      afterMap.set(line, []);
    }
    afterMap.get(line)!.push(j);
  }

  // Find matches greedily
  let lastAfterIdx = -1;
  for (let i = 0; i < before.length; i++) {
    const candidates = afterMap.get(before[i]) || [];
    for (const j of candidates) {
      if (j > lastAfterIdx) {
        result.push({ beforeIdx: i, afterIdx: j });
        lastAfterIdx = j;
        break;
      }
    }
  }

  return result;
}

/**
 * Trim context lines, keeping only N lines around actual changes.
 */
function trimContext(diff: DiffEntry[], contextLines: number): DiffEntry[] {
  // Mark which context lines to keep (within N of a change)
  const keep = new Array(diff.length).fill(false);

  for (let i = 0; i < diff.length; i++) {
    if (diff[i].type !== "context") {
      // Mark surrounding context
      for (let j = Math.max(0, i - contextLines); j <= Math.min(diff.length - 1, i + contextLines); j++) {
        keep[j] = true;
      }
    }
  }

  // Build result, collapsing hidden context into ellipsis
  const result: DiffEntry[] = [];
  let skipping = false;

  for (let i = 0; i < diff.length; i++) {
    if (keep[i]) {
      skipping = false;
      result.push(diff[i]);
    } else if (!skipping) {
      skipping = true;
      // Don't add ellipsis for now - just skip
    }
  }

  return result;
}
