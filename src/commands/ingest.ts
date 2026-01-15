import { Command, Flags } from "@oclif/core";
import { AgentBuilder, LLMist } from "llmist";
import { unlink, stat, readFile } from "node:fs/promises";
import { findAuFiles } from "../lib/au-paths.js";
import {
  auUpdate,
  auRead,
  auList,
  readFiles,
  readDirs,
  ripGrep,
  finish,
} from "../gadgets/index.js";
import { SYSTEM_PROMPT, INITIAL_PROMPT } from "../lib/system-prompt.js";
import { Output } from "../lib/output.js";
import { IngestStateCollector, IngestState } from "../lib/ingest-state.js";
import { render } from "../lib/templates.js";
import {
  agentFlags,
  configureBuilder,
  createTextBlockState,
  endTextBlock,
  formatResultSize,
  getPreloadBudget,
  setupIterationTracking,
  countAuBytes,
  parseIncludePatterns,
} from "../lib/command-utils.js";
import { GadgetName, isFileReadingGadget } from "../lib/constants.js";

export default class Ingest extends Command {
  static description = "Create and update agent understanding files for TypeScript code";

  static examples = [
    "<%= config.bin %> ingest",
    "<%= config.bin %> ingest --model sonnet",
    "<%= config.bin %> ingest --max-iterations 20",
    "<%= config.bin %> ingest -v",
    "<%= config.bin %> ingest --include '*.tsx,*.jsx'",
  ];

  static flags = {
    ...agentFlags,
    purge: Flags.boolean({
      description: "Remove all .au files before running (start fresh)",
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Ingest);
    const out = new Output({ verbose: flags.verbose });

    // Change to target directory if --path specified
    const originalCwd = process.cwd();
    if (flags.path && flags.path !== ".") {
      try {
        process.chdir(flags.path);
        out.info(`Working in: ${flags.path}`);
      } catch {
        out.error(`Cannot access directory: ${flags.path}`);
        process.exit(1);
      }
    }

    // Purge existing .au files if requested
    if (flags.purge) {
      out.info("Purging existing .au files...");
      const auFiles = await findAuFiles(".", true);
      for (const auFile of auFiles) {
        try {
          await unlink(auFile);
        } catch {
          // Ignore errors (file may not exist)
        }
      }
      out.success(`Removed ${auFiles.length} .au files`);
    }

    const client = new LLMist();

    // Generate initial context by executing gadgets directly (use "." since we already chdir'd)
    out.info("Scanning directory structure...");
    if (!flags.verbose) {
      console.log("Scanning codebase...");
    }
    const dirStructure = await readDirs.execute({
      paths: ".",
      depth: 10,
    });

    out.info("Checking existing understanding...");
    const existingAuFiles = await findAuFiles(".", true);
    const existingCount = existingAuFiles.length;

    if (existingCount > 0) {
      const existingAu = await auList.execute({ path: "." });
      const existingContent = existingAu as string;
      const bytes = countAuBytes(existingContent);
      out.setInitialBytes(bytes);
      const bytesStr = bytes >= 1024 ? `${(bytes / 1024).toFixed(1)}KB` : `${bytes}B`;
      out.success(`Found ${existingCount} existing understanding entries (${bytesStr})`);
    }

    // Collect unified state (coverage + validation)
    out.info("Running validation checks...");
    const stateCollector = new IngestStateCollector();
    const includePatterns = parseIncludePatterns(flags.include);
    let state = await stateCollector.collect(".", { includePatterns });

    const progressTracker = stateCollector.getProgressTracker();
    out.setProgressTracker(progressTracker);

    // Check if there's anything to do
    if (state.totalItems === 0) {
      out.warn("No source files found to document.");
      process.chdir(originalCwd);
      return;
    }

    if (!state.hasWork) {
      out.success(`All documentation complete and valid. (${state.coveragePercent}% coverage)`);
      process.chdir(originalCwd);
      return;
    }

    // Report initial status
    out.info(`Coverage: ${state.coveragePercent}% (${state.documentedItems}/${state.totalItems} items)`);

    if (state.issueCount > 0) {
      out.warn(`Found ${state.issueCount} validation issues:`);
      if (state.staleFiles.length > 0) {
        out.info(`  - ${state.staleFiles.length} stale (source changed)`);
      }
      if (state.incompleteFiles.length > 0) {
        out.info(`  - ${state.incompleteFiles.length} incomplete (missing fields)`);
      }
      if (state.staleReferences.length > 0) {
        out.info(`  - ${state.staleReferences.length} broken references`);
      }
      if (state.contentsIssues.length > 0) {
        out.info(`  - ${state.contentsIssues.length} contents mismatches`);
      }
      if (state.orphanedAuFiles.length > 0) {
        out.info(`  - ${state.orphanedAuFiles.length} orphaned .au files`);
      }
    }

    const pendingCount = state.pendingItems.length;
    if (pendingCount > 0) {
      out.info(`${pendingCount} items pending documentation`);
    }

    // Get pre-load budget based on model context window
    const budget = getPreloadBudget(client, flags.model);

    // Pre-load source files to reduce read iterations
    out.info("Pre-loading source files...");
    const sourceFiles = stateCollector.getSourceFiles();
    const preloadedFiles: string[] = [];
    const preloadedPaths: string[] = [];
    let totalBytes = 0;

    for (const filePath of sourceFiles) {
      try {
        const fileStat = await stat(filePath);
        // Check per-file limit and total budget
        if (fileStat.size > 0 &&
            fileStat.size <= budget.maxPerFileBytes &&
            totalBytes + fileStat.size <= budget.maxTotalBytes) {
          const content = await readFile(filePath, "utf-8");
          preloadedFiles.push(`=== ${filePath} ===\n${content}`);
          preloadedPaths.push(filePath);
          totalBytes += content.length;
        }
      } catch {
        // Skip files that can't be read
      }
    }

    const preloadedContent = preloadedFiles.join("\n\n");
    out.success(`Pre-loaded ${preloadedPaths.length} source files (${(preloadedContent.length / 1024).toFixed(1)} KB)`);

    // Build the agent
    let builder = new AgentBuilder(client)
      .withModel(flags.model)
      .withSystem(SYSTEM_PROMPT)
      .withMaxIterations(flags["max-iterations"])
      .withGadgets(auUpdate, auRead, auList, readFiles, readDirs, ripGrep, finish)
      .withTextOnlyHandler("acknowledge");

    builder = configureBuilder(builder, out, flags.rpm, flags.tpm)
      .withTrailingMessage((ctx) => {
        const counts = progressTracker.getCounts();
        return render("ingest/trailing", {
          iteration: ctx.iteration + 1,
          maxIterations: ctx.maxIterations,
          progress: progressTracker.getProgressPercent(),
          documented: counts.documented,
          total: counts.total,
          // Issues
          staleFiles: state.staleFiles,
          incompleteFiles: state.incompleteFiles,
          staleReferences: state.staleReferences,
          contentsIssues: state.contentsIssues,
          orphanedAuFiles: state.orphanedAuFiles,
          // Pending
          pendingItems: progressTracker.getPendingItems(10),
        });
      });

    // Inject initial context as synthetic gadget calls
    builder.withSyntheticGadgetCall(
      "ReadDirs",
      { paths: ".", depth: 10 },
      dirStructure as string,
      "gc_init_1"
    );

    builder.withSyntheticGadgetCall(
      "AUList",
      { path: "." },
      existingAu as string,
      "gc_init_2"
    );

    // Inject pre-loaded source files if any
    if (preloadedPaths.length > 0) {
      builder.withSyntheticGadgetCall(
        "ReadFiles",
        { paths: preloadedPaths.join("\n") },
        preloadedContent,
        "gc_init_3"
      );
    }

    // Create and run the agent
    const agent = builder.ask(INITIAL_PROMPT);

    out.info("Starting codebase analysis...");

    // Track text block state
    const textState = createTextBlockState();

    // Subscribe to ExecutionTree for iteration and cost tracking
    const tree = agent.getTree();
    setupIterationTracking(tree, {
      out,
      showCumulativeCostEvery: 10,
      onIterationChange: () => endTextBlock(textState, out),
    });

    // Run and stream events from the agent
    try {
      for await (const event of agent.run()) {
        if (event.type === "text") {
          textState.inTextBlock = true;
          out.thinkingChunk(event.content);
        } else if (event.type === "gadget_call") {
          endTextBlock(textState, out);
          const params = event.call.parameters as Record<string, unknown>;
          out.gadgetCall(event.call.gadgetName, params);
        } else if (event.type === "gadget_result") {
          const result = event.result;

          if (result.error) {
            out.gadgetError(result.gadgetName, result.error);
          } else {
            // Create summary based on gadget type
            let summary: string | undefined;
            if (isFileReadingGadget(result.gadgetName)) {
              summary = formatResultSize(result.result);
            }

            out.gadgetResult(result.gadgetName, summary);

            // Special handling for AUUpdate
            if (result.gadgetName === GadgetName.AUUpdate) {
              if (result.result?.startsWith("Error:")) {
                out.warn(result.result);
              } else {
                // Extract filePath, marker, and byte diff from the result message
                // Format: "Updated src/foo.ts.au [path.to.field] [new|upd] [oldBytes→newBytes:+diff]"
                const match = result.result?.match(/Updated (.+?) \[.+?\] \[(new|upd)\] \[\d+→\d+:([+-]?\d+)\]/);
                if (match) {
                  const auPath = match[1];
                  const isNew = match[2] === "new";
                  const byteDiff = parseInt(match[3], 10);
                  // Order matters: check for directory .au first (/.au), then file .au (.au)
                  const sourcePath = auPath.replace(/\/\.au$/, "").replace(/\.au$/, "");
                  progressTracker.markDocumented(sourcePath);

                  // Also remove from stale/incomplete lists if present
                  state.staleFiles = state.staleFiles.filter(f => !f.includes(sourcePath));
                  state.incompleteFiles = state.incompleteFiles.filter(f => f.path !== sourcePath);

                  out.documenting(sourcePath, byteDiff, isNew);
                }
              }
            }
          }
        }
      }

      endTextBlock(textState, out);
    } catch (error) {
      endTextBlock(textState, out);
      out.error(`Agent error: ${error instanceof Error ? error.message : error}`);
      process.chdir(originalCwd);
      process.exit(1);
    } finally {
      // Restore original working directory
      process.chdir(originalCwd);
    }

    out.summary();
  }
}
