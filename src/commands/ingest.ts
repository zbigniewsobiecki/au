import { Command, Flags } from "@oclif/core";
import { AgentBuilder, LLMist } from "llmist";
import { unlink } from "node:fs/promises";
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
  getPreloadBudget,
  setupIterationTracking,
  countAuBytes,
  parseIncludePatterns,
  withWorkingDirectory,
  preloadFiles,
} from "../lib/command-utils.js";
import { runAgentWithEvents } from "../lib/agent-runner.js";
import { GadgetName } from "../lib/constants.js";

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

    const { restore } = withWorkingDirectory(flags.path, out);

    // Purge existing .au files if requested
    if (flags.purge) {
      out.info("Purging existing .au files...");
      const { files: auFiles } = await findAuFiles(".", true);
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
    const { files: existingAuFiles } = await findAuFiles(".", true);
    const existingCount = existingAuFiles.length;

    let existingAu: string | null = null;
    if (existingCount > 0) {
      existingAu = await auList.execute({ path: "." }) as string;
      const existingContent = existingAu;
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
      restore();
      return;
    }

    if (!state.hasWork) {
      out.success(`All documentation complete and valid. (${state.coveragePercent}% coverage)`);
      restore();
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
    const preloaded = await preloadFiles(sourceFiles, budget);
    out.success(`Pre-loaded ${preloaded.paths.length} source files (${(preloaded.content.length / 1024).toFixed(1)} KB)`);

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

    if (existingAu) {
      builder.withSyntheticGadgetCall(
        "AUList",
        { path: "." },
        existingAu,
        "gc_init_2"
      );
    }

    // Inject pre-loaded source files if any
    if (preloaded.paths.length > 0) {
      builder.withSyntheticGadgetCall(
        "ReadFiles",
        { paths: preloaded.paths.join("\n") },
        preloaded.content,
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
      await runAgentWithEvents(agent, {
        out,
        textState,
        onGadgetResult: (gadgetName, result) => {
          // Special handling for AUUpdate
          if (gadgetName === GadgetName.AUUpdate) {
            if (result?.startsWith("Error:")) {
              out.warn(result);
            } else {
              // Extract filePath, marker, and byte diff from the result message
              // Format: "Updated src/foo.ts.au [path.to.field] [new|upd] [oldBytes→newBytes:+diff]"
              const match = result?.match(/Updated (.+?) \[.+?\] \[(new|upd)\] \[\d+→\d+:([+-]?\d+)\]/);
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
        },
      });
    } catch (error) {
      out.error(`Agent error: ${error instanceof Error ? error.message : error}`);
      restore();
      process.exit(1);
    } finally {
      restore();
    }

    out.summary();
  }
}
