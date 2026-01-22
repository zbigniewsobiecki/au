import { Command, Flags } from "@oclif/core";
import { AgentBuilder, LLMist, resolveModel } from "llmist";
import { readFile, unlink } from "node:fs/promises";
import { parse } from "yaml";
import { findAuFiles } from "../lib/au-paths.js";
import {
  auUpdate,
  auList,
  readFiles,
  readDirs,
  fileViewerNextFileSet,
} from "../gadgets/index.js";
import { Output } from "../lib/output.js";
import { IngestStateCollector } from "../lib/ingest-state.js";
import { Validator } from "../lib/validator.js";
import { render } from "../lib/templates.js";
import {
  agentFlags,
  configureBuilder,
  createTextBlockState,
  endTextBlock,
  countAuBytes,
  parseIncludePatterns,
  parsePathList,
  withWorkingDirectory,
} from "../lib/command-utils.js";
import { GadgetName } from "../lib/constants.js";
import { buildDependencyGraph, DependencyGraph } from "../lib/dependency-graph.js";

/**
 * Estimate tokens from string length (rough approximation: 4 chars ≈ 1 token)
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Format token count for display
 */
function formatTokens(tokens: number): string {
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}k`;
  }
  return String(tokens);
}

interface ContextComposition {
  systemPrompt: number;
  repoMap: number;
  currentAU: number;
  fileViewer: number;
  other: number;
  total: number;
}

interface AuUpdateResult {
  filePath: string;
  result: string;
  isNew: boolean;
  byteDiff: number;
}

interface TurnResult {
  auUpdateResults: AuUpdateResult[];
  nextFiles: string[];
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cost: number;
}

interface LastTurnDocumented {
  path: string;
  layer: string;
  summary: string;
}

interface Ingest2State {
  viewedFiles: Set<string>;
  pendingFiles: Set<string>;
  pendingDirectories: Set<string>;
  documentedFiles: Set<string>;
  iteration: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;
  totalCost: number;
  totalAuBytes: number;
  lastTurnDocumented: LastTurnDocumented[];
}

/**
 * Compute frontier files: pending files that documented files depend on.
 * These are files the LLM has "seen" referenced but not yet documented.
 */
function computeFrontierFiles(
  graph: DependencyGraph,
  documented: Set<string>,
  pending: Set<string>
): string[] {
  const frontier = new Set<string>();

  for (const docFile of documented) {
    const info = graph.get(docFile);
    if (info) {
      for (const dep of info.dependsOn) {
        // Only include if it's still pending (not yet documented)
        if (pending.has(dep)) {
          frontier.add(dep);
        }
      }
    }
  }

  return Array.from(frontier).sort();
}

interface ReferencingFileContext {
  path: string;
  layer: string;
  summary: string;
  referencesInBatch: Array<{
    targetFile: string;
    symbols: string[];
    kind: string;
  }>;
}

/**
 * Compute referencing context: documented files that reference files in the current batch.
 * This tells the LLM how previously documented files use the files about to be documented.
 */
async function computeReferencingContext(
  graph: DependencyGraph,
  currentBatchFiles: string[],
  documented: Set<string>,
  basePath: string = "."
): Promise<ReferencingFileContext[]> {
  const result: ReferencingFileContext[] = [];
  const batchSet = new Set(currentBatchFiles);

  // Find documented files that reference any file in the current batch
  for (const docFile of documented) {
    const info = graph.get(docFile);
    if (!info) continue;

    // Check if this documented file depends on any file in the batch
    const referencesInBatch: ReferencingFileContext["referencesInBatch"] = [];
    for (const depPath of info.dependsOn) {
      if (batchSet.has(depPath)) {
        const symbols = info.symbolsByDep.get(depPath) || [];
        // We need to read the AU file to get the relationship kind
        // For now, we'll infer it from the AU content
        referencesInBatch.push({
          targetFile: depPath,
          symbols,
          kind: "depends_on", // Default, will be enhanced below
        });
      }
    }

    if (referencesInBatch.length === 0) continue;

    // Read the documented file's AU to get layer, summary, and relationship kinds
    const auPath = docFile.endsWith("/")
      ? `${basePath}/${docFile}.au`
      : `${basePath}/${docFile}.au`;

    try {
      const auContent = await readFile(auPath, "utf-8");
      const doc = parse(auContent);
      if (!doc) continue;

      const layer = doc.layer || "unknown";
      const summary = doc.understanding?.summary || "";

      // Try to get the actual relationship kinds from depends_on
      const dependsOn = doc.relationships?.depends_on || [];
      for (const ref of referencesInBatch) {
        const depEntry = dependsOn.find(
          (d: { ref?: string; kind?: string }) =>
            d.ref === `au:${ref.targetFile}`
        );
        if (depEntry?.kind) {
          ref.kind = depEntry.kind;
        }
      }

      result.push({
        path: docFile,
        layer,
        summary,
        referencesInBatch,
      });
    } catch {
      // Can't read AU file, skip this reference
    }
  }

  return result.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Read AU file content to extract layer and summary.
 */
async function readAuFileInfo(
  sourcePath: string,
  basePath: string = "."
): Promise<{ layer: string; summary: string } | null> {
  const auPath = `${basePath}/${sourcePath}.au`;

  try {
    const content = await readFile(auPath, "utf-8");
    const doc = parse(content);
    if (!doc) return null;

    return {
      layer: doc.layer || "unknown",
      summary: doc.understanding?.summary || "",
    };
  } catch {
    return null;
  }
}

export default class Ingest2 extends Command {
  static description = "Create agent understanding using iterative file viewer approach (non-agentic)";

  static examples = [
    "<%= config.bin %> ingest2",
    "<%= config.bin %> ingest2 --model sonnet",
    "<%= config.bin %> ingest2 --max-iterations 20",
    "<%= config.bin %> ingest2 -v",
    "<%= config.bin %> ingest2 --include '*.tsx,*.jsx'",
  ];

  static flags = {
    ...agentFlags,
    purge: Flags.boolean({
      description: "Remove all .au files before running (start fresh)",
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Ingest2);
    const out = new Output({ verbose: flags.verbose });

    const { restore } = withWorkingDirectory(flags.path, out);

    // Purge existing .au files if requested
    if (flags.purge) {
      out.info("Purging existing .au files...");
      const { files: auFiles } = await findAuFiles(".", true);
      for (const auFile of auFiles) {
        try {
          await unlink(auFile);
        } catch {
          // Ignore errors
        }
      }
      out.success(`Removed ${auFiles.length} .au files`);
    }

    const client = new LLMist();

    // Scan directory structure
    out.info("Scanning directory structure...");
    if (!flags.verbose) {
      console.log("Scanning codebase...");
    }
    const repoMap = await readDirs.execute({
      paths: ".",
      depth: 100,
      includeGitIgnored: false,
    }) as string;

    // Collect initial state
    out.info("Collecting initial state...");
    const stateCollector = new IngestStateCollector();
    const includePatterns = parseIncludePatterns(flags.include);
    const initialState = await stateCollector.collect(".", { includePatterns });

    const progressTracker = stateCollector.getProgressTracker();
    out.setProgressTracker(progressTracker);

    // Check if there's anything to do
    if (initialState.totalItems === 0) {
      out.warn("No source files found to document.");
      restore();
      return;
    }

    if (!initialState.hasWork) {
      out.success(`All documentation complete and valid. (${initialState.coveragePercent}% coverage)`);
      restore();
      return;
    }

    // Get source files and directories for pending tracking
    const sourceFiles = stateCollector.getSourceFiles();
    const directories = stateCollector.getDirectories();
    out.success(`Found ${sourceFiles.length} source files, ${directories.length} directories`);

    // Initialize tracking state
    const state: Ingest2State = {
      viewedFiles: new Set(),
      pendingFiles: new Set(sourceFiles),
      pendingDirectories: new Set(directories),
      documentedFiles: new Set(),
      iteration: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCachedTokens: 0,
      totalCost: 0,
      totalAuBytes: 0,
      lastTurnDocumented: [],
    };

    // Mark already documented files and directories
    const { files: existingAuFiles } = await findAuFiles(".", true);
    if (existingAuFiles.length > 0) {
      const existingAu = await auList.execute({ path: "." }) as string;
      const bytes = countAuBytes(existingAu);
      state.totalAuBytes = bytes;
      out.setInitialBytes(bytes);

      // Parse existing AU to mark documented files and directories
      for (const auFile of existingAuFiles) {
        const sourcePath = auFile.replace(/\/\.au$/, "").replace(/\.au$/, "");
        state.documentedFiles.add(sourcePath);
        state.pendingFiles.delete(sourcePath);
        state.pendingDirectories.delete(sourcePath);
        progressTracker.markDocumented(sourcePath);
      }
      out.success(`Found ${existingAuFiles.length} existing understanding entries`);
    }

    // Load system prompt
    const systemPrompt = render("ingest2/system", {});

    // Track current file viewer contents
    let fileViewerContents = "";
    let nextFilesToView: string[] = [];

    // Main loop
    const maxIterations = flags["max-iterations"];
    out.info("Starting iterative documentation...");

    while (state.iteration < maxIterations) {
      state.iteration++;

      // Get current AU state
      let currentAU: string | null = null;
      if (state.documentedFiles.size > 0) {
        currentAU = await auList.execute({ path: "." }) as string;
      }

      // Get pending files and directories lists
      const pendingFilesArray = Array.from(state.pendingFiles);
      const pendingDirectories = Array.from(state.pendingDirectories);

      // First turn: only file selection, no documentation
      const isFirstTurn = state.iteration === 1;

      // Build dependency graph and compute frontier files (after first turn)
      let frontierFiles: string[] = [];
      let otherPendingFiles: string[] = pendingFilesArray;
      let referencingContext: ReferencingFileContext[] = [];
      let graph: DependencyGraph | null = null;

      if (!isFirstTurn && state.documentedFiles.size > 0) {
        graph = await buildDependencyGraph(".");
        frontierFiles = computeFrontierFiles(graph, state.documentedFiles, state.pendingFiles);
        // Filter out frontier files from other pending
        const frontierSet = new Set(frontierFiles);
        otherPendingFiles = pendingFilesArray.filter(f => !frontierSet.has(f));

        // Compute referencing context for files currently in the file viewer
        // (nextFilesToView contains the files that are about to be documented)
        if (nextFilesToView.length > 0) {
          referencingContext = await computeReferencingContext(
            graph,
            nextFilesToView,
            state.documentedFiles,
            "."
          );
        }
      }

      // Build user message
      const userMessage = render("ingest2/user", {
        iteration: state.iteration,
        maxIterations,
        repoMap,
        currentAU,
        fileViewerContents,
        documentedCount: state.documentedFiles.size,
        totalCount: sourceFiles.length + directories.length,
        pendingCount: state.pendingFiles.size + state.pendingDirectories.size,
        pendingFiles: otherPendingFiles,
        pendingDirectories,
        isFirstTurn,
        frontierFiles,
        referencingContext,
        previousTurnBrief: state.lastTurnDocumented,
      });

      // Calculate context composition
      const composition: ContextComposition = {
        systemPrompt: estimateTokens(systemPrompt),
        repoMap: estimateTokens(repoMap),
        currentAU: currentAU ? estimateTokens(currentAU) : 0,
        fileViewer: fileViewerContents ? estimateTokens(fileViewerContents) : 0,
        other: estimateTokens(userMessage) - estimateTokens(repoMap) - (currentAU ? estimateTokens(currentAU) : 0) - (fileViewerContents ? estimateTokens(fileViewerContents) : 0),
        total: estimateTokens(systemPrompt) + estimateTokens(userMessage),
      };

      // Display iteration header
      if (flags.verbose) {
        console.log();
        console.log(`\x1b[34m━━━ Iteration ${state.iteration}/${maxIterations} ━━━\x1b[0m`);
        // Show context composition
        console.log(`\x1b[2m   Context: ${formatTokens(composition.total)} tokens\x1b[0m`);
        console.log(`\x1b[2m   ├─ System:     ${formatTokens(composition.systemPrompt)}\x1b[0m`);
        console.log(`\x1b[2m   ├─ Repo Map:   ${formatTokens(composition.repoMap)}\x1b[0m`);
        console.log(`\x1b[2m   ├─ Current AU: ${formatTokens(composition.currentAU)}\x1b[0m`);
        console.log(`\x1b[2m   ├─ FileViewer: ${formatTokens(composition.fileViewer)}\x1b[0m`);
        console.log(`\x1b[2m   └─ Other:      ${formatTokens(composition.other)}\x1b[0m`);
      } else {
        console.log(`[Iteration ${state.iteration}/${maxIterations}] Context: ${formatTokens(composition.total)} tokens`);
      }

      // Run single-turn completion
      const turnResult = await this.runSingleTurn(
        client,
        systemPrompt,
        userMessage,
        flags.model,
        flags.rpm,
        flags.tpm,
        out,
        flags.verbose,
        progressTracker,
        isFirstTurn
      );

      // Update state
      state.totalInputTokens += turnResult.inputTokens;
      state.totalOutputTokens += turnResult.outputTokens;
      state.totalCachedTokens += turnResult.cachedInputTokens;
      state.totalCost += turnResult.cost;

      // Process AU updates
      for (const auResult of turnResult.auUpdateResults) {
        state.documentedFiles.add(auResult.filePath);
        state.pendingFiles.delete(auResult.filePath);
        state.pendingDirectories.delete(auResult.filePath);
        state.totalAuBytes += auResult.byteDiff;
      }

      // Build previous turn brief from this turn's AU updates
      state.lastTurnDocumented = [];
      for (const auResult of turnResult.auUpdateResults) {
        const auInfo = await readAuFileInfo(auResult.filePath, ".");
        if (auInfo) {
          state.lastTurnDocumented.push({
            path: auResult.filePath,
            layer: auInfo.layer,
            summary: auInfo.summary,
          });
        }
      }

      // Display iteration stats
      if (flags.verbose) {
        const totalTokens = turnResult.inputTokens + turnResult.outputTokens;
        const tokensStr = totalTokens >= 1000
          ? `${(totalTokens / 1000).toFixed(1)}k`
          : String(totalTokens);
        const cachedStr = turnResult.cachedInputTokens > 0
          ? ` (${(turnResult.cachedInputTokens / 1000).toFixed(1)}k cached)`
          : "";
        const costStr = turnResult.cost >= 0.01
          ? `$${turnResult.cost.toFixed(3)}`
          : `$${turnResult.cost.toFixed(4)}`;
        console.log(`\x1b[2m   ⤷ ${tokensStr} tokens${cachedStr} · ${costStr}\x1b[0m`);
      }

      // Show pending status
      if (state.pendingFiles.size > 0) {
        const preview = Array.from(state.pendingFiles).slice(0, 3).join(", ");
        const more = state.pendingFiles.size > 3 ? ` +${state.pendingFiles.size - 3} more` : "";
        if (flags.verbose) {
          console.log(`\x1b[2m   Pending: ${state.pendingFiles.size} files (${preview}${more})\x1b[0m`);
        }
      }

      nextFilesToView = turnResult.nextFiles;

      // Check termination conditions
      if (nextFilesToView.length === 0) {
        if (flags.verbose) {
          console.log("\x1b[32m✓ LLM signaled completion\x1b[0m");
        }
        break;
      }

      if (state.pendingFiles.size === 0 && state.pendingDirectories.size === 0) {
        if (flags.verbose) {
          console.log("\x1b[32m✓ All files and directories documented\x1b[0m");
        }
        break;
      }

      // Load next file contents for file viewer
      state.viewedFiles = new Set([...state.viewedFiles, ...nextFilesToView]);

      // Sort alphabetically as per spec
      const sortedPaths = [...nextFilesToView].sort();
      const pathsInput = sortedPaths.join("\n");
      fileViewerContents = await readFiles.execute({ paths: pathsInput }) as string;

      // Show next files to view
      if (flags.verbose) {
        const nextStr = sortedPaths.slice(0, 3).join(", ");
        const nextMore = sortedPaths.length > 3 ? ` +${sortedPaths.length - 3}` : "";
        console.log(`\x1b[33m→ Next: ${nextStr}${nextMore}\x1b[0m`);
      }
    }

    // Check if hit max iterations
    const totalPending = state.pendingFiles.size + state.pendingDirectories.size;
    if (state.iteration >= maxIterations && totalPending > 0) {
      out.warn(`Reached max iterations (${maxIterations}). ${totalPending} items remain.`);
    }

    // Run validation pass to fix any remaining issues
    const validator = new Validator();
    const validationResult = await validator.validate(".", { includePatterns });
    const issueCount = Validator.getIssueCount(validationResult);

    if (issueCount > 0) {
      out.info(`Found ${issueCount} validation issues, running fix pass...`);

      // Separate uncovered items into files and directories
      const uncoveredFiles = validationResult.uncovered.filter(p => !p.endsWith("/"));
      const uncoveredDirs = validationResult.uncovered.filter(p => p.endsWith("/")).map(p => p.slice(0, -1));

      const fixMessage = render("ingest2/validation-fix", {
        uncoveredFiles,
        uncoveredDirs,
        staleRefs: validationResult.staleReferences,
        incompleteFiles: validationResult.incompleteFiles,
      });

      // Get current AU state for the fix pass
      let currentAU: string | null = null;
      if (state.documentedFiles.size > 0) {
        currentAU = await auList.execute({ path: "." }) as string;
      }

      const fixUserMessage = render("ingest2/user", {
        iteration: state.iteration + 1,
        maxIterations: state.iteration + 1,
        repoMap,
        currentAU,
        fileViewerContents: "",
        documentedCount: state.documentedFiles.size,
        totalCount: sourceFiles.length + directories.length,
        pendingCount: 0,
        pendingFiles: [],
        pendingDirectories: [],
        isFirstTurn: false,
        validationFixMessage: fixMessage,
        frontierFiles: [],
        referencingContext: [],
        previousTurnBrief: [],
      });

      if (flags.verbose) {
        console.log();
        console.log(`\x1b[34m━━━ Validation Fix Pass ━━━\x1b[0m`);
      } else {
        console.log("[Validation Fix Pass]");
      }

      const fixResult = await this.runSingleTurn(
        client,
        systemPrompt,
        fixUserMessage,
        flags.model,
        flags.rpm,
        flags.tpm,
        out,
        flags.verbose,
        progressTracker,
        false
      );

      // Update state with fix results
      state.totalInputTokens += fixResult.inputTokens;
      state.totalOutputTokens += fixResult.outputTokens;
      state.totalCachedTokens += fixResult.cachedInputTokens;
      state.totalCost += fixResult.cost;

      for (const auResult of fixResult.auUpdateResults) {
        state.documentedFiles.add(auResult.filePath);
        state.pendingFiles.delete(auResult.filePath);
        state.pendingDirectories.delete(auResult.filePath);
        state.totalAuBytes += auResult.byteDiff;
      }

      state.iteration++;
    }

    // Print summary
    this.printSummary(state, sourceFiles.length + directories.length, flags.verbose);

    restore();
  }

  private async runSingleTurn(
    client: LLMist,
    systemPrompt: string,
    userMessage: string,
    model: string,
    rpm: number,
    tpm: number,
    out: Output,
    verbose: boolean,
    progressTracker: ReturnType<IngestStateCollector["getProgressTracker"]>,
    isFirstTurn: boolean
  ): Promise<TurnResult> {
    const auUpdateResults: AuUpdateResult[] = [];
    let nextFiles: string[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedInputTokens = 0;
    let cost = 0;

    const textState = createTextBlockState();

    // Create fresh agent for this turn only
    // First turn: only file selection, no auUpdate
    let builder = new AgentBuilder(client)
      .withModel(model)
      .withSystem(systemPrompt)
      .withMaxIterations(1)  // Single LLM turn
      .withGadgets(...(isFirstTurn ? [fileViewerNextFileSet] : [auUpdate, fileViewerNextFileSet]))
      .withTextOnlyHandler("acknowledge");

    builder = configureBuilder(builder, out, rpm, tpm);

    const agent = builder.ask(userMessage);

    // Subscribe to tree events for usage/cost tracking
    const tree = agent.getTree();
    tree.onAll((event) => {
      if (event.type === "llm_call_complete") {
        if (event.usage) {
          inputTokens = event.usage.inputTokens || 0;
          outputTokens = event.usage.outputTokens || 0;
          cachedInputTokens = event.usage.cachedInputTokens || 0;
        }
        if (event.cost) {
          cost = event.cost;
        }
      }
    });

    // Stream events
    for await (const event of agent.run()) {
      if (event.type === "text") {
        if (verbose) {
          textState.inTextBlock = true;
          out.thinkingChunk(event.content);
        }
      } else if (event.type === "gadget_call") {
        if (verbose) {
          endTextBlock(textState, out);
          const params = event.call.parameters as Record<string, unknown>;
          out.gadgetCall(event.call.gadgetName, params);
        }
      } else if (event.type === "gadget_result") {
        const result = event.result;

        if (verbose) {
          endTextBlock(textState, out);
        }

        if (result.gadgetName === GadgetName.AUUpdate) {
          if (result.error) {
            out.gadgetError(result.gadgetName, result.error);
          } else if (result.result) {
            // Parse: "Updated src/foo.ts.au [path] [new|upd] [oldB→newB:±diff]"
            const match = result.result.match(/Updated (.+?) \[.+?\] \[(new|upd)\] \[\d+→\d+:([+-]?\d+)\]/);
            if (match) {
              const auPath = match[1];
              const isNew = match[2] === "new";
              const byteDiff = parseInt(match[3], 10);
              const sourcePath = auPath.replace(/\/\.au$/, "").replace(/\.au$/, "");

              auUpdateResults.push({
                filePath: sourcePath,
                result: result.result,
                isNew,
                byteDiff,
              });

              progressTracker.markDocumented(sourcePath);
              out.documenting(sourcePath, byteDiff, isNew);
            } else if (verbose) {
              out.gadgetResult(result.gadgetName);
            }
          }
        } else if (result.gadgetName === "FileViewerNextFileSet") {
          const params = result.parameters as { paths: string } | undefined;
          if (params?.paths) {
            nextFiles = parsePathList(params.paths);
          }
          if (verbose) {
            const filesStr = nextFiles.length === 0 ? "[] (done)" : `${nextFiles.length} files`;
            out.gadgetResult(result.gadgetName, filesStr);
          }
        }
      }
    }

    if (verbose) {
      endTextBlock(textState, out);
    }

    return {
      auUpdateResults,
      nextFiles,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      cost,
    };
  }

  private printSummary(state: Ingest2State, totalFiles: number, verbose: boolean): void {
    console.log();

    if (verbose) {
      console.log("\x1b[34m━━━ Summary ━━━\x1b[0m");
      console.log(`Files documented: ${state.documentedFiles.size}`);
      const coveragePercent = Math.round((state.documentedFiles.size / totalFiles) * 100);
      console.log(`Coverage: ${coveragePercent}% (${state.documentedFiles.size}/${totalFiles})`);

      const bytesStr = state.totalAuBytes >= 1024
        ? `${(state.totalAuBytes / 1024).toFixed(1)}KB`
        : `${state.totalAuBytes}B`;
      console.log(`Understanding: ${bytesStr}`);
      console.log(`Iterations: ${state.iteration}`);

      const totalTokens = state.totalInputTokens + state.totalOutputTokens;
      const tokensStr = totalTokens >= 1000
        ? `${(totalTokens / 1000).toFixed(1)}k`
        : String(totalTokens);
      const cachedStr = state.totalCachedTokens > 0
        ? ` (${(state.totalCachedTokens / 1000).toFixed(1)}k cached)`
        : "";
      console.log(`Tokens: ${tokensStr}${cachedStr}`);

      if (state.totalCost > 0) {
        const costStr = state.totalCost >= 1
          ? `$${state.totalCost.toFixed(2)}`
          : state.totalCost >= 0.01
            ? `$${state.totalCost.toFixed(3)}`
            : `$${state.totalCost.toFixed(4)}`;
        console.log(`Cost: ${costStr}`);
      }
    } else {
      const coveragePercent = Math.round((state.documentedFiles.size / totalFiles) * 100);
      const costStr = state.totalCost >= 0.01
        ? `$${state.totalCost.toFixed(2)}`
        : `$${state.totalCost.toFixed(4)}`;
      console.log(`Done. Documented ${state.documentedFiles.size} files (${coveragePercent}% coverage). Cost: ${costStr}`);
    }
  }
}
