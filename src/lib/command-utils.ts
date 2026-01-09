import { Flags } from "@oclif/core";
import { AgentBuilder } from "llmist";
import type { ExecutionEvent } from "llmist";
import { Output } from "./output.js";
import { AU_SEPARATOR, hasNoExisting } from "./constants.js";

/**
 * Common flags shared by all AU commands.
 */
export const commonFlags = {
  model: Flags.string({
    char: "m",
    description: "LLM model to use",
    default: "sonnet",
  }),
  path: Flags.string({
    char: "p",
    description: "Root path to process",
    default: ".",
  }),
  verbose: Flags.boolean({
    char: "v",
    description: "Show detailed output with colors",
    default: false,
  }),
  rpm: Flags.integer({
    description: "Rate limit: requests per minute",
    default: 50,
  }),
  tpm: Flags.integer({
    description: "Rate limit: tokens per minute (in thousands)",
    default: 100,
  }),
};

/**
 * Flags common to agent commands (ingest, review).
 */
export const agentFlags = {
  ...commonFlags,
  "max-iterations": Flags.integer({
    char: "i",
    description: "Maximum agent iterations",
    default: 50,
  }),
};

/**
 * Retry configuration for LLM calls.
 */
export interface RetryConfig {
  retries: number;
  minTimeout: number;
  maxTimeout: number;
  onRetry: (error: Error, attempt: number) => void;
  onRetriesExhausted: (error: Error, attempts: number) => void;
}

/**
 * Creates standard retry configuration.
 */
export function createRetryConfig(out: Output): RetryConfig {
  return {
    retries: 5,
    minTimeout: 2000,
    maxTimeout: 60000,
    onRetry: (error, attempt) => {
      out.warn(`Retry ${attempt}/5: ${error.message}`);
    },
    onRetriesExhausted: (error, attempts) => {
      out.error(`Failed after ${attempts} attempts: ${error.message}`);
    },
  };
}

/**
 * Rate limit configuration.
 */
export interface RateLimitConfig {
  requestsPerMinute: number;
  tokensPerMinute: number;
  safetyMargin: number;
}

/**
 * Creates standard rate limit configuration.
 */
export function createRateLimitConfig(rpm: number, tpm: number): RateLimitConfig {
  return {
    requestsPerMinute: rpm,
    tokensPerMinute: tpm * 1000,
    safetyMargin: 0.8,
  };
}

/**
 * Configures an agent builder with standard retry and rate limit settings.
 */
export function configureBuilder(
  builder: AgentBuilder,
  out: Output,
  rpm: number,
  tpm: number
): AgentBuilder {
  return builder
    .withRetry(createRetryConfig(out))
    .withRateLimits(createRateLimitConfig(rpm, tpm));
}

/**
 * State for tracking text block output during event streaming.
 */
export interface TextBlockState {
  inTextBlock: boolean;
}

/**
 * Creates a text block state tracker.
 */
export function createTextBlockState(): TextBlockState {
  return { inTextBlock: false };
}

/**
 * Ends a text block if one is active.
 */
export function endTextBlock(state: TextBlockState, out: Output): void {
  if (state.inTextBlock) {
    out.thinkingEnd();
    state.inTextBlock = false;
  }
}

/**
 * Formats a result size as a human-readable string.
 */
export function formatResultSize(result: string | undefined): string {
  const length = result?.length || 0;
  return `${(length / 1024).toFixed(1)}kb`;
}

/**
 * Options for setting up iteration tracking.
 */
export interface IterationTrackingOptions {
  out: Output;
  onlyInVerbose?: boolean;
  onIterationChange?: (iteration: number) => void;
  showCumulativeCostEvery?: number;
}

/**
 * Sets up iteration tracking on an agent's execution tree.
 * Returns a function to get the current iteration.
 */
export function setupIterationTracking(
  tree: { onAll: (handler: (event: ExecutionEvent) => void) => void },
  options: IterationTrackingOptions
): () => number {
  const { out, onlyInVerbose = false, onIterationChange, showCumulativeCostEvery } = options;
  let currentIteration = 0;

  tree.onAll((event: ExecutionEvent) => {
    if (event.type === "llm_call_start") {
      currentIteration = event.iteration + 1;
      onIterationChange?.(currentIteration);

      if (!onlyInVerbose) {
        out.iteration(currentIteration);
      }
    } else if (event.type === "llm_call_complete") {
      if (event.usage || event.cost) {
        if (!onlyInVerbose) {
          out.iterationStats(
            event.usage?.inputTokens || 0,
            event.usage?.outputTokens || 0,
            event.cost || 0
          );
        }
      }

      if (showCumulativeCostEvery && currentIteration > 0 && currentIteration % showCumulativeCostEvery === 0) {
        out.cumulativeCost();
      }
    }
  });

  return () => currentIteration;
}

/**
 * Counts AU file entries from an AU list result.
 */
export function countAuEntries(content: string): number {
  if (hasNoExisting(content)) {
    return 0;
  }
  return content.split(AU_SEPARATOR).length - 1;
}

/**
 * Counts lines in AU content (excluding separator lines).
 */
export function countAuLines(content: string): number {
  return content.split("\n").filter(line => !line.startsWith(AU_SEPARATOR)).length;
}

/**
 * Parses a newline-separated list of paths into an array.
 * Trims whitespace and filters empty lines.
 */
export function parsePathList(pathsString: string): string[] {
  return pathsString
    .split("\n")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}
