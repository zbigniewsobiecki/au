/**
 * Cycle runner - unified agent turn execution for ingest cycles.
 * Consolidates duplicated event handling from runSingleCycleTurn, runRetryTurn, and runCycle0.
 */

import { AgentBuilder, LLMist } from "llmist";
import chalk from "chalk";

import type { CycleState, CycleIterationState, CycleTurnOptions, CycleTurnResult } from "./types.js";
import { extractEntitiesFromSysml } from "./entity-parser.js";
import { formatTurnSummary } from "./token-tracking.js";
import { parsePathList } from "../command-utils.js";
import { extractDiffFromResult } from "../diff-utils.js";
import { Output } from "../output.js";
import { render } from "../templates.js";
import {
  configureBuilder,
  createTextBlockState,
  endTextBlock,
} from "../command-utils.js";
import {
  sysmlCreate,
  sysmlWrite,
  sysmlRead,
  sysmlList,
  projectMetaRead,
  fileDiscoverCustom,
  readFiles,
  readDirs,
  ripGrep,
  manifestWrite,
  manifestRead,
  enumerateDirectories,
  fileViewerNextFileSet,
} from "../../gadgets/index.js";
import { checkCycleCoverage, type CoverageResult } from "../sysml/index.js";
import { validateModelFull, type Sysml2MultiDiagnostic } from "../sysml/sysml2-cli.js";

/**
 * Gadget sets for different cycle types.
 */
const CYCLE_GADGETS = [
  sysmlCreate,
  sysmlWrite,
  sysmlRead,
  sysmlList,
  projectMetaRead,
  fileDiscoverCustom,
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
  fileDiscoverCustom,
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
  validationErrors?: Sysml2MultiDiagnostic[];
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
  validationErrors?: Sysml2MultiDiagnostic[];
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
  onFileWrite?: (path: string, mode: string, delta: string | null, diff: string | null) => void;
  onNextFiles?: (files: string[]) => void;
  trackEntities?: CycleIterationState;
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

  const tree = agent.getTree();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tree.onAll((event: any) => {
    if (event.type === "llm_call_complete") {
      turnCount++;
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

      // Show turn stats in verbose mode
      if (options.verbose) {
        console.log(formatTurnSummary(
          turnCount,
          iterationInputTokens,
          iterationOutputTokens,
          iterationCachedTokens,
          iterationCost
        ));
      }
    }
  });

  // Stream events
  for await (const event of agent.run()) {
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
          filesWritten++;

          // Parse path from result (format: "path=... status=... mode=... delta=...")
          const pathMatch = result.result.match(/^path=(\S+)/);
          const modeMatch = result.result.match(/mode=(\w+)/);
          const deltaMatch = result.result.match(/delta=([+-]?\d+ bytes)/);
          const writtenPath = pathMatch ? pathMatch[1] : result.result.split("\n")[0];
          let mode = modeMatch ? modeMatch[1] : "";
          if (!mode && result.gadgetName === "SysMLCreate") {
            mode = result.result?.includes("Reset package") ? "reset" : "create";
          }
          const delta = deltaMatch ? deltaMatch[1] : null;
          const diff = extractDiffFromResult(result.result);

          // Extract entities from element content for cross-turn tracking
          const params = result.parameters as { path?: string; element?: string };
          if (params?.element && params?.path && trackEntities) {
            const newEntities = extractEntitiesFromSysml(params.element, params.path);
            trackEntities.createdEntities.push(...newEntities);
          }

          summary.push(`Wrote ${writtenPath}`);

          if (onFileWrite) {
            onFileWrite(writtenPath, mode, delta, diff);
          }

          if (options.verbose) {
            const modeStr = mode === "create" ? chalk.yellow("[new]")
              : mode === "reset" ? chalk.magenta("[reset]")
              : mode === "upsert" ? chalk.blue("[set]")
              : mode === "delete" ? chalk.red("[del]")
              : "";
            const deltaStr = delta
              ? (delta.startsWith("-") ? chalk.red(` (${delta})`) : chalk.dim(` (${delta})`))
              : "";
            console.log(`${chalk.green("   ✓")} ${writtenPath} ${modeStr}${deltaStr}`);

            // Display colored diff if available
            if (diff) {
              const indentedDiff = diff.split("\n").map((line) => `      ${line}`).join("\n");
              console.log(indentedDiff);
            }
          } else {
            console.log(`  Wrote: ${writtenPath}`);
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

        // If LLM signals completion (empty paths), break out of event loop
        if (nextFiles.length === 0) {
          break;
        }
      } else if (options.verbose) {
        out.gadgetResult(result.gadgetName);
      }
    }
  }

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
): Promise<{ nextFiles: string[]; summary: string[]; turns: number }> {
  const { expectedCount, cycle, docCoveragePercent, docMissingFiles } = trailingContext;

  // Run full model validation before turn
  let validationErrors: Sysml2MultiDiagnostic[] = [];
  try {
    const validation = await validateModelFull(".sysml");
    validationErrors = validation.semanticErrors;
  } catch {
    // sysml2 not available - skip validation
  }

  const result = await runAgentTurn({
    client,
    systemPrompt,
    userMessage,
    options,
    out,
    gadgets: "cycle",
    maxIterations: Math.min(options.maxIterations, 30),
    terminateOnTextOnly: true,
    trackEntities: iterState,
    trailingMessage: () => {
      return render("sysml/trailing", {
        iteration: iterState.turnCount,
        maxIterations: options.maxIterations,
        readCount: iterState.readFiles.size,
        expectedCount,
        docCoveragePercent,
        docMissingFiles: docMissingFiles.slice(0, 20),
        validationErrors,
      });
    },
    onFileWrite: async (path, mode, delta, diff) => {
      cycleState.filesWritten++;

      // Show real-time coverage
      if (options.verbose && expectedCount > 0) {
        const coverage = await checkCycleCoverage(cycle, ".");
        if (coverage.expectedFiles.length > 0) {
          const coveragePercent = Math.round(coverage.coveragePercent);
          console.log(`\x1b[2m      📄 Coverage: ${coverage.coveredFiles.length}/${coverage.expectedFiles.length} (${coveragePercent}%)\x1b[0m`);

          if (coverage.missingFiles.length > 0) {
            const sample = coverage.missingFiles.slice(0, 3).map(f => `"${f}"`).join(', ');
            const moreCount = coverage.missingFiles.length - 3;
            const moreStr = moreCount > 0 ? ` (+${moreCount} more)` : '';
            console.log(`\x1b[2m      Still need: ${sample}${moreStr}\x1b[0m`);
          }
        }
      }
    },
  });

  // Update cycle state with token tracking
  cycleState.inputTokens += result.inputTokens;
  cycleState.outputTokens += result.outputTokens;
  cycleState.cachedTokens += result.cachedTokens;
  cycleState.cost += result.cost;

  return {
    nextFiles: result.nextFiles,
    summary: result.summary,
    turns: result.turns,
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
  validationErrors: Sysml2MultiDiagnostic[],
  totalMissing: number,
  cycleOutputDir: string
): Promise<{ nextFiles: string[]; turns: number }> {
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
        validationErrors,
      });
    },
    onFileWrite: () => {
      retryState.filesWritten++;
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
