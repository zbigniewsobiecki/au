/**
 * Token tracking and cost formatting utilities.
 */

import { formatTokens } from "../formatting.js";

/**
 * Format a cost value for display.
 */
export function formatCost(cost: number): string {
  if (cost >= 1) {
    return `$${cost.toFixed(2)}`;
  } else if (cost >= 0.01) {
    return `$${cost.toFixed(3)}`;
  } else {
    return `$${cost.toFixed(4)}`;
  }
}

/**
 * Format token usage with optional cached count.
 */
export function formatTokenUsage(
  inputTokens: number,
  outputTokens: number,
  cachedTokens?: number
): string {
  const inputStr = formatTokens(inputTokens);
  const outputStr = formatTokens(outputTokens);
  const cachedStr = cachedTokens && cachedTokens > 0
    ? ` (${formatTokens(cachedTokens)} cached)`
    : "";
  return `${inputStr} in · ${outputStr} out${cachedStr}`;
}

/**
 * Format a turn summary line.
 */
export function formatTurnSummary(
  turnNumber: number,
  inputTokens: number,
  outputTokens: number,
  cachedTokens: number,
  cost: number,
  prefix: string = "Turn"
): string {
  const usageStr = formatTokenUsage(inputTokens, outputTokens, cachedTokens);
  const costStr = formatCost(cost);
  return `\x1b[2m   ⤷ ${prefix} ${turnNumber}: ${usageStr} · ${costStr}\x1b[0m`;
}

/**
 * Format a cycle summary line.
 */
export function formatCycleSummary(
  cycle: number,
  turns: number,
  totalTokens: number,
  cachedTokens: number,
  cost: number,
  filesWritten: number,
  coverageStr?: string
): string {
  const tokensStr = formatTokens(totalTokens);
  const cachedStr = cachedTokens > 0
    ? ` (${formatTokens(cachedTokens)} cached)`
    : "";
  const costStr = formatCost(cost);
  const turnsStr = turns === 1 ? "1 turn" : `${turns} turns`;
  const coveragePart = coverageStr ? ` · ${coverageStr}` : "";

  return `\x1b[32m✓ Cycle ${cycle} complete: ${turnsStr} · ${tokensStr} tokens${cachedStr} · ${costStr} · ${filesWritten} files${coveragePart}\x1b[0m`;
}
