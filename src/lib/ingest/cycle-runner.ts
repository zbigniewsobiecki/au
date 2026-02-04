/**
 * Cycle runner - unified agent turn execution for ingest cycles.
 * Consolidates duplicated event handling from runSingleCycleTurn, runRetryTurn, and runCycle0.
 */

import { AgentBuilder, LLMist } from "llmist";
import { join } from "node:path";

import type { CycleState, CycleIterationState, CycleTurnOptions, CycleTurnResult } from "./types.js";
import { extractEntitiesFromSysml } from "./entity-parser.js";
import { formatTurnSummary } from "./token-tracking.js";
import { parsePathList } from "../command-utils.js";
import { Output } from "../output.js";
import { render } from "../templates.js";
import { parseSysMLWriteResult, displaySysMLWriteVerbose, displaySysMLWriteCompact } from "../sysml-write-display.js";
import {
  configureBuilder,
  createTextBlockState,
  endTextBlock,
} from "../command-utils.js";
import {
  sysmlCreate,
  sysmlWrite,
  sysmlQuery,
  sysmlRead,
  sysmlList,
  projectMetaRead,
  readFiles,
  readDirs,
  ripGrep,
  manifestWrite,
  manifestRead,
  enumerateDirectories,
  fileViewerNextFileSet,
  invalidateCoverageCache,
  setStallState,
  setSysmlWriteStallState,
} from "../../gadgets/index.js";
import { checkCycleCoverage, validateSourceFilePaths, type CoverageResult, type SourceFileError } from "../sysml/index.js";
import { validateModelFull, type ValidationResult } from "../sysml/sysml2-cli.js";

/**
 * Gadget sets for different cycle types.
 */
const CYCLE_GADGETS = [
  sysmlCreate,
  sysmlWrite,
  sysmlRead,
  sysmlList,
  projectMetaRead,
  readFiles,
  readDirs,
  ripGrep,
  fileViewerNextFileSet,
];

const CYCLE0_GADGETS = [
  manifestWrite,
  manifestRead,
  enumerateDirectories,
  projectMetaRead,
  readFiles,
  readDirs,
  ripGrep,
];

const RETRY_GADGETS = [
  sysmlCreate,
  sysmlWrite,
  sysmlRead,
  sysmlList,
  readFiles,
  readDirs,
  fileViewerNextFileSet,
];

/**
 * Context for trailing messages in cycle turns.
 */
export interface TrailingMessageContext {
  iteration: number;
  maxIterations: number;
  readCount: number;
  expectedCount: number;
  docCoveragePercent?: number;
  docMissingFiles?: string[];
  validationExitCode?: number;
  validationOutput?: string;
  sourceFileErrors?: SourceFileError[];
  writesWithoutCoverageIncrease?: number;
}

/**
 * Context for trailing messages in retry turns.
 */
export interface RetryTrailingContext {
  iteration: number;
  maxIterations: number;
  cycleOutputDir: string;
  readCount: number;
  remainingFiles: number;
  totalMissing: number;
  stillMissing: number;
  unreadFiles: string[];
  validationExitCode?: number;
  validationOutput?: string;
  sourceFileErrors?: SourceFileError[];
}

/**
 * Options for configuring an agent turn.
 */
export interface AgentTurnConfig {
  client: LLMist;
  systemPrompt: string;
  userMessage: string;
  options: CycleTurnOptions;
  out: Output;
  gadgets: "cycle" | "cycle0" | "retry";
  maxIterations: number;
  terminateOnTextOnly?: boolean;
  trailingMessage?: () => string;
  onFileWrite?: (path: string, mode: string, delta: string | null, diff: string | null) => void | Promise<void>;
  onNextFiles?: (files: string[]) => void;
  trackEntities?: CycleIterationState;
  getCoveragePercent?: () => number | undefined;
  abortSignal?: AbortSignal;
}

/**
 * Run an agent turn with unified event handling.
 * This is the core function that handles all agent interactions.
 */
export async function runAgentTurn(config: AgentTurnConfig): Promise<CycleTurnResult> {
  const {
    client,
    systemPrompt,
    userMessage,
    options,
    out,
    gadgets,
    maxIterations,
    terminateOnTextOnly = false,
    trailingMessage,
    onFileWrite,
    onNextFiles,
    trackEntities,
  } = config;

  const textState = createTextBlockState();
  const summary: string[] = [];
  let nextFiles: string[] = [];

  // Select gadget set
  const gadgetSet = gadgets === "cycle0" ? CYCLE0_GADGETS
    : gadgets === "retry" ? RETRY_GADGETS
    : CYCLE_GADGETS;

  let builder = new AgentBuilder(client)
    .withModel(options.model)
    .withSystem(systemPrompt)
    .withMaxIterations(maxIterations)
    .withGadgetExecutionMode("sequential")
    .withGadgets(...gadgetSet);

  if (terminateOnTextOnly) {
    builder = builder.withTextOnlyHandler("terminate");
  }

  builder = configureBuilder(builder, out, options.rpm, options.tpm);

  if (trailingMessage) {
    builder = builder.withTrailingMessage(trailingMessage);
  }

  const agent = builder.ask(userMessage);

  // Track usage
  let turnCount = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCachedTokens = 0;
  let totalCost = 0;
  let filesWritten = 0;

  let iterationInputTokens = 0;
  let iterationOutputTokens = 0;
  let iterationCachedTokens = 0;
  let iterationCost = 0;
  let iterationGadgetCount = 0;

  // Track pending turn summary (print after gadgets complete)
  let pendingTurnSummary: {
    turnNumber: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    cost: number;
  } | null = null;

  // Function to print pending turn summary with gadget count
  const printPendingTurnSummary = () => {
    if (pendingTurnSummary && options.verbose) {
      const coveragePercent = config.getCoveragePercent?.();
      console.log(formatTurnSummary(
        pendingTurnSummary.turnNumber,
        pendingTurnSummary.inputTokens,
        pendingTurnSummary.outputTokens,
        pendingTurnSummary.cachedTokens,
        pendingTurnSummary.cost,
        iterationGadgetCount,
        undefined,
        coveragePercent
      ));
      pendingTurnSummary = null;
    }
  };

  const tree = agent.getTree();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tree.onAll((event: any) => {
    if (event.type === "llm_call_complete") {
      // Print previous turn's summary before starting new turn
      printPendingTurnSummary();

      turnCount++;
      iterationGadgetCount = 0; // Reset gadget count for new turn

      if (event.usage) {
        iterationInputTokens = event.usage.inputTokens || 0;
        iterationOutputTokens = event.usage.outputTokens || 0;
        iterationCachedTokens = event.usage.cachedInputTokens || 0;
        totalInputTokens += iterationInputTokens;
        totalOutputTokens += iterationOutputTokens;
        totalCachedTokens += iterationCachedTokens;
      }
      if (event.cost) {
        iterationCost = event.cost;
        totalCost += iterationCost;
      }

      // Queue turn summary to be printed after gadgets complete
      pendingTurnSummary = {
        turnNumber: turnCount,
        inputTokens: iterationInputTokens,
        outputTokens: iterationOutputTokens,
        cachedTokens: iterationCachedTokens,
        cost: iterationCost,
      };
    } else if (event.type === "gadget_call") {
      // Track gadget count in onAll to ensure correct timing with turn summary
      iterationGadgetCount++;
    }
  });

  // Stream events
  for await (const event of agent.run()) {
    // Check for abort signal (set by stall detection in cycle-runner)
    if (config.abortSignal?.aborted) break;

    if (event.type === "text") {
      if (options.verbose) {
        textState.inTextBlock = true;
        out.thinkingChunk(event.content);
      }
    } else if (event.type === "gadget_call") {
      if (options.verbose) {
        endTextBlock(textState, out);
        const params = event.call.parameters as Record<string, unknown>;
        out.gadgetCall(event.call.gadgetName, params);
      }
    } else if (event.type === "gadget_result") {
      const result = event.result;

      if (options.verbose) {
        endTextBlock(textState, out);
      }

      if (result.gadgetName === "SysMLWrite" || result.gadgetName === "SysMLCreate") {
        if (result.error) {
          out.gadgetError(result.gadgetName, result.error);
        } else if (result.result) {
          const parsed = parseSysMLWriteResult(result.result, result.gadgetName);

          if (parsed.isError) {
            if (options.verbose) {
              displaySysMLWriteVerbose(parsed);
            } else {
              displaySysMLWriteCompact(parsed);
            }
            summary.push(`Error writing ${parsed.path}`);
          } else {
            filesWritten++;

            // Extract entities from element content for cross-turn tracking
            const params = result.parameters as { path?: string; element?: string };
            if (params?.element && params?.path && trackEntities) {
              const newEntities = await extractEntitiesFromSysml(params.element, params.path);
              trackEntities.createdEntities.push(...newEntities);
            }

            summary.push(`Wrote ${parsed.path}`);

            if (onFileWrite) {
              await onFileWrite(parsed.path, parsed.mode, parsed.delta, parsed.diff);
            }

            if (options.verbose) {
              displaySysMLWriteVerbose(parsed);
            } else {
              displaySysMLWriteCompact(parsed);
            }
          }
        }
      } else if (result.gadgetName === "ManifestWrite") {
        if (result.error) {
          out.gadgetError(result.gadgetName, result.error);
        } else if (result.result) {
          filesWritten++;
          if (options.verbose) {
            console.log(`\x1b[32m   ✓ Manifest written\x1b[0m`);
          } else {
            console.log(`  Wrote: .sysml/_manifest.json`);
          }
        }
      } else if (result.gadgetName === "FileViewerNextFileSet") {
        // Parse next files from the gadget call parameters
        const params = result.parameters as { paths?: string };
        nextFiles = parsePathList(params?.paths ?? "");

        if (options.verbose) {
          if (nextFiles.length > 0) {
            console.log(`\x1b[2m   → Next batch: ${nextFiles.length} files\x1b[0m`);
          } else {
            console.log(`\x1b[2m   → Batch complete\x1b[0m`);
          }
        }

        if (onNextFiles) {
          onNextFiles(nextFiles);
        }

        // If LLM signals completion (empty paths), check gadget result before breaking
        if (nextFiles.length === 0) {
          const gadgetResult = result.result ?? "";
          if (gadgetResult.startsWith("ERROR:")) {
            // Gadget rejected completion - let LLM see the error and continue
            if (options.verbose) {
              console.log(`\x1b[33m   ⚠ Completion rejected: coverage too low\x1b[0m`);
            }
          } else {
            break;
          }
        }
      } else if (options.verbose) {
        out.gadgetResultContent(result.gadgetName, result.result);
      }
    }
  }

  // Print final turn summary
  printPendingTurnSummary();

  if (options.verbose) {
    endTextBlock(textState, out);
  }

  return {
    nextFiles,
    summary,
    turns: turnCount,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    cachedTokens: totalCachedTokens,
    cost: totalCost,
    filesWritten,
    aborted: config.abortSignal?.aborted,
  };
}

/**
 * Run a single turn within an iterative cycle.
 */
export async function runCycleTurn(
  client: LLMist,
  systemPrompt: string,
  userMessage: string,
  iterState: CycleIterationState,
  cycleState: CycleState,
  options: CycleTurnOptions,
  out: Output,
  trailingContext: {
    expectedCount: number;
    cycle: number;
    language?: string;
    docCoveragePercent: number;
    docMissingFiles: string[];
  }
): Promise<{ nextFiles: string[]; summary: string[]; turns: number; validationResult: ValidationResult | null; aborted?: boolean }> {
  const { expectedCount, cycle, docMissingFiles } = trailingContext;
  let { docCoveragePercent } = trailingContext;
  let latestDocMissingFiles = docMissingFiles;

  // Stall tracking: use exact covered count instead of rounded % to avoid false stalls
  let writesWithoutCoverageIncrease = 0;
  let previousCoveredCount = 0;

  // Shared stall state for file-viewer-next injection + AbortController for extreme stall
  const abortController = new AbortController();
  const sharedStallState = {
    writesWithoutIncrease: 0,
    missingFiles: [...docMissingFiles],
    coveragePercent: docCoveragePercent,
  };
  setStallState(sharedStallState);
  setSysmlWriteStallState(sharedStallState);

  // Run full model validation before turn
  let validationResult: ValidationResult | null = null;
  try {
    validationResult = await validateModelFull(".sysml");
  } catch {
    // sysml2 not available - skip validation
  }

  // Validate @SourceFile paths
  let sourceFileErrors: SourceFileError[] = [];
  try {
    const sfValidation = await validateSourceFilePaths(".sysml", ".");
    sourceFileErrors = sfValidation.errors;
  } catch {
    // Ignore errors
  }

  let result: CycleTurnResult;
  try {
    result = await runAgentTurn({
    client,
    systemPrompt,
    userMessage,
    options,
    out,
    gadgets: "cycle",
    maxIterations: Math.min(options.maxIterations, 30),
    terminateOnTextOnly: true,
    trackEntities: iterState,
    abortSignal: abortController.signal,
    getCoveragePercent: () => docCoveragePercent > 0 ? docCoveragePercent : undefined,
    trailingMessage: () => {
      // readCount = all files the agent has seen (FVNFS batches + ReadFiles)
      const liveReadCount = iterState.readFiles.size;
      return render("sysml/trailing", {
        iteration: iterState.turnCount,
        maxIterations: options.maxIterations,
        readCount: liveReadCount,
        expectedCount,
        docCoveragePercent,
        docMissingFiles: latestDocMissingFiles.slice(0, 20),
        validationExitCode: validationResult?.exitCode ?? 0,
        validationOutput: validationResult?.output ?? "",
        sourceFileErrors,
        writesWithoutCoverageIncrease,
      });
    },
    onNextFiles: (files) => {
      // Track FVNFS reads so readCount stays accurate
      for (const f of files) iterState.readFiles.add(f);
    },
    onFileWrite: async (path, mode, delta, diff) => {
      cycleState.filesWritten++;

      // Re-run validation after SysML writes so trailing message shows current state
      try {
        validationResult = await validateModelFull(".sysml");
      } catch {
        // sysml2 not available - skip validation
      }

      // Re-run @SourceFile validation
      try {
        const sfValidation = await validateSourceFilePaths(".sysml", ".");
        sourceFileErrors = sfValidation.errors;
      } catch {
        // Ignore errors
      }

      // Refresh coverage metrics for trailing message and CLI display (unified: read ∩ documented)
      if (expectedCount > 0) {
        try {
          const coverage = await checkCycleCoverage(cycle, ".", iterState.readFiles);
          invalidateCoverageCache(); // keep SysMLWrite's cache in sync
          if (coverage.expectedFiles.length > 0) {
            // Update live coverage for trailing message
            docCoveragePercent = Math.round(coverage.coveragePercent);
            latestDocMissingFiles = coverage.missingFiles;

            // Stall detection: use exact covered count (avoids rounding false-stalls)
            const currentCoveredCount = coverage.expectedFiles.length - coverage.missingFiles.length;
            if (currentCoveredCount > previousCoveredCount) {
              writesWithoutCoverageIncrease = 0;
              previousCoveredCount = currentCoveredCount;
            } else {
              writesWithoutCoverageIncrease++;
            }

            // Sync shared stall state for file-viewer-next injection + sysml-write rejection
            sharedStallState.writesWithoutIncrease = writesWithoutCoverageIncrease;
            sharedStallState.missingFiles = [...latestDocMissingFiles];
            sharedStallState.coveragePercent = docCoveragePercent;

            // Abort on extreme stall
            if (writesWithoutCoverageIncrease >= 8) {
              if (options.verbose) {
                console.log(`\x1b[31m   ✖ Extreme stall (${writesWithoutCoverageIncrease} writes without coverage increase) — aborting turn\x1b[0m`);
              }
              abortController.abort();
            }

            if (options.verbose) {
              const covered = coverage.expectedFiles.length - coverage.missingFiles.length;
              console.log(`\x1b[2m      📄 Coverage: ${covered}/${coverage.expectedFiles.length} (${docCoveragePercent}%)${writesWithoutCoverageIncrease > 0 ? ` [stalled x${writesWithoutCoverageIncrease}]` : ''}\x1b[0m`);

              if (coverage.missingFiles.length > 0) {
                const sample = coverage.missingFiles.slice(0, 3).map(f => `"${f}"`).join(', ');
                const moreCount = coverage.missingFiles.length - 3;
                const moreStr = moreCount > 0 ? ` (+${moreCount} more)` : '';
                console.log(`\x1b[2m      Still need: ${sample}${moreStr}\x1b[0m`);
              }
            }
          }
        } catch {
          // Coverage check failed - continue with existing values
        }
      }
    },
  });
  } finally {
    setStallState(null);
    setSysmlWriteStallState(null);
  }

  // Update cycle state with token tracking
  cycleState.inputTokens += result.inputTokens;
  cycleState.outputTokens += result.outputTokens;
  cycleState.cachedTokens += result.cachedTokens;
  cycleState.cost += result.cost;

  return {
    nextFiles: result.nextFiles,
    summary: result.summary,
    turns: result.turns,
    validationResult,
    aborted: result.aborted,
  };
}

/**
 * Run a single turn within the retry phase.
 */
export async function runRetryTurn(
  client: LLMist,
  systemPrompt: string,
  userMessage: string,
  iterState: { readFiles: Set<string>; currentBatch: string[]; turnCount: number; maxTurns: number },
  retryState: CycleState,
  options: CycleTurnOptions,
  out: Output,
  initialValidationExitCode: number,
  initialValidationOutput: string,
  totalMissing: number,
  cycleOutputDir: string
): Promise<{ nextFiles: string[]; turns: number }> {
  // Mutable validation state - updated after SysML writes
  let validationExitCode = initialValidationExitCode;
  let validationOutput = initialValidationOutput;

  // Validate @SourceFile paths
  let sourceFileErrors: SourceFileError[] = [];
  try {
    const sfValidation = await validateSourceFilePaths(".sysml", ".");
    sourceFileErrors = sfValidation.errors;
  } catch {
    // Ignore errors
  }

  // Get current coverage for trailing message
  let stillMissingCount = totalMissing - iterState.readFiles.size;
  const unreadFiles: string[] = [];
  try {
    const coverage = await checkCycleCoverage(retryState.cycle, ".");
    stillMissingCount = coverage.missingFiles.length;
    unreadFiles.push(...coverage.missingFiles.filter(f => !iterState.readFiles.has(f)));
  } catch {
    // Ignore coverage check errors
  }

  const result = await runAgentTurn({
    client,
    systemPrompt,
    userMessage,
    options,
    out,
    gadgets: "retry",
    maxIterations: Math.min(options.maxIterations, 30),
    terminateOnTextOnly: false,
    getCoveragePercent: () => {
      if (totalMissing <= 0) return undefined;
      const pct = Math.round(((totalMissing - stillMissingCount) / totalMissing) * 100);
      return pct > 0 ? pct : undefined;
    },
    trailingMessage: () => {
      return render("sysml/retry-trailing", {
        iteration: iterState.turnCount,
        maxIterations: iterState.maxTurns,
        cycleOutputDir,
        readCount: iterState.readFiles.size,
        remainingFiles: iterState.currentBatch.length,
        totalMissing,
        stillMissing: stillMissingCount,
        unreadFiles: unreadFiles.slice(0, 20),
        validationExitCode,
        validationOutput,
        sourceFileErrors,
      });
    },
    onFileWrite: async () => {
      retryState.filesWritten++;

      // Re-run validation after SysML writes so trailing message shows current state
      try {
        const result = await validateModelFull(".sysml");
        validationExitCode = result.exitCode;
        validationOutput = result.output;
      } catch {
        // sysml2 not available - skip validation
      }

      // Re-run @SourceFile validation
      try {
        const sfValidation = await validateSourceFilePaths(".sysml", ".");
        sourceFileErrors = sfValidation.errors;
      } catch {
        // Ignore errors
      }
    },
  });

  // Update retry state with token tracking
  retryState.inputTokens += result.inputTokens;
  retryState.outputTokens += result.outputTokens;
  retryState.cachedTokens += result.cachedTokens;
  retryState.cost += result.cost;

  return {
    nextFiles: result.nextFiles,
    turns: result.turns,
  };
}

/**
 * Run Cycle 0: Repository Discovery.
 */
export async function runCycle0Turn(
  client: LLMist,
  systemPrompt: string,
  userMessage: string,
  options: CycleTurnOptions,
  out: Output
): Promise<CycleTurnResult> {
  return runAgentTurn({
    client,
    systemPrompt,
    userMessage,
    options,
    out,
    gadgets: "cycle0",
    maxIterations: Math.min(options.maxIterations, 25),
    terminateOnTextOnly: true,
  });
}
