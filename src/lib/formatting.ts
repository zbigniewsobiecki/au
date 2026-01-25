/**
 * Shared formatting utilities
 */

/**
 * Estimate token count from text length.
 * Uses ~4 characters per token approximation.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Format token count as "1.2k" or "45".
 */
export function formatTokens(tokens: number): string {
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}k`;
  }
  return String(tokens);
}

/**
 * Format a label (e.g., directory name) by capitalizing words.
 * "context-boundaries" -> "Context Boundaries"
 */
export function formatLabel(text: string): string {
  return text
    .replace(/\/$/, "")
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
