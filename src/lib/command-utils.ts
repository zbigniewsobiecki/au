import { Flags } from "@oclif/core";
import { AgentBuilder, LLMist, resolveModel } from "llmist";
import type { ExecutionEvent, AbstractGadget } from "llmist";
import { stat, readFile } from "node:fs/promises";
import { Output } from "./output.js";
import { AU_SEPARATOR } from "./constants.js";
import {
  auRead,
  auList,
  readFiles,
  readDirs,
  ripGrep,
} from "../gadgets/index.js";

/**
 * Changes to a working directory if specified and returns a restore function.
 * Handles error cases by logging and exiting.
 */
export function withWorkingDirectory(
  path: string | undefined,
  out: Output
): { originalCwd: string; restore: () => void } {
  const originalCwd = process.cwd();
  if (path && path !== ".") {
    try {
      process.chdir(path);
      out.info(`Working in: ${path}`);
    } catch {
      out.error(`Cannot access directory: ${path}`);
      process.exit(1);
    }
  }
  return { originalCwd, restore: () => process.chdir(originalCwd) };
}

/**
 * Selects the appropriate read gadgets based on the mode.
 * - auOnly: Only AU reading gadgets
 * - codeOnly: Only source code reading gadgets
 * - default: Both AU and source code gadgets
 */
export function selectReadGadgets(mode: { auOnly?: boolean; codeOnly?: boolean }): AbstractGadget[] {
  if (mode.auOnly) return [auRead, auList];
  if (mode.codeOnly) return [readFiles, readDirs, ripGrep];
  return [auRead, auList, readFiles, readDirs, ripGrep];
}

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
  include: Flags.string({
    description: "Comma-separated glob patterns to include (e.g., *.tsx,*.jsx)",
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
 * Counts lines in AU content (excluding separator lines).
 * @deprecated Use countAuBytes instead
 */
export function countAuLines(content: string): number {
  return content.split("\n").filter(line => !line.startsWith(AU_SEPARATOR)).length;
}

/**
 * Counts bytes in AU content (excluding separator lines).
 */
export function countAuBytes(content: string): number {
  const lines = content.split("\n").filter(line => !line.startsWith(AU_SEPARATOR));
  return Buffer.byteLength(lines.join("\n"), "utf-8");
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

/**
 * Parses comma-separated include patterns into an array.
 * Returns undefined if no patterns provided.
 */
export function parseIncludePatterns(include: string | undefined): string[] | undefined {
  if (!include) return undefined;
  const patterns = include.split(",").map(p => p.trim()).filter(p => p.length > 0);
  return patterns.length > 0 ? patterns : undefined;
}

/**
 * Budget for pre-loading file content into context.
 */
export interface PreloadBudget {
  /** Maximum total bytes to pre-load */
  maxTotalBytes: number;
  /** Maximum bytes per individual file */
  maxPerFileBytes: number;
}

/**
 * Calculates pre-load budget based on model's context window size.
 * Uses ~25% of context for pre-loaded content, with per-file limits.
 */
export function getPreloadBudget(client: LLMist, modelName: string): PreloadBudget {
  const modelId = resolveModel(modelName);
  const limits = client.modelRegistry.getModelLimits(modelId);

  // Default to 200k tokens if model not found
  const contextWindow = limits?.contextWindow ?? 200_000;

  // Reserve ~25% of context for pre-loaded content
  // (rest goes to system prompt, agent responses, tool results)
  const tokenBudget = Math.floor(contextWindow * 0.25);

  // Rough estimate: 1 token ≈ 4 characters
  const charBudget = tokenBudget * 4;

  // Cap per-file at 10KB but reduce if total budget is small
  const maxPerFile = Math.min(10 * 1024, Math.floor(charBudget / 4));

  return {
    maxTotalBytes: charBudget,
    maxPerFileBytes: maxPerFile,
  };
}

/**
 * Result of preloading files into context.
 */
export interface PreloadResult {
  /** Combined content of all preloaded files */
  content: string;
  /** Paths of files that were successfully preloaded */
  paths: string[];
  /** Total bytes of preloaded content */
  totalBytes: number;
}

/**
 * Preloads files into context within the given budget.
 * Formats each file as `=== ${path} ===\n${content}` and joins with double newlines.
 */
export async function preloadFiles(
  files: string[],
  budget: PreloadBudget
): Promise<PreloadResult> {
  const preloadedFiles: string[] = [];
  const preloadedPaths: string[] = [];
  let totalBytes = 0;

  for (const filePath of files) {
    try {
      const fileStat = await stat(filePath);
      // Check per-file limit and total budget before reading
      if (
        fileStat.size > 0 &&
        fileStat.size <= budget.maxPerFileBytes &&
        totalBytes + fileStat.size <= budget.maxTotalBytes
      ) {
        const content = await readFile(filePath, "utf-8");
        preloadedFiles.push(`=== ${filePath} ===\n${content}`);
        preloadedPaths.push(filePath);
        totalBytes += content.length;
      }
    } catch {
      // Skip files that can't be read
    }
  }

  return {
    content: preloadedFiles.join("\n\n"),
    paths: preloadedPaths,
    totalBytes,
  };
}
