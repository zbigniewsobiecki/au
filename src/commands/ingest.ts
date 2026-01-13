import { Command } from "@oclif/core";
import { AgentBuilder, LLMist } from "llmist";
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
import { ProgressTracker } from "../lib/progress-tracker.js";
import { render } from "../lib/templates.js";
import {
  agentFlags,
  configureBuilder,
  createTextBlockState,
  endTextBlock,
  formatResultSize,
  setupIterationTracking,
  countAuEntries,
  countAuLines,
} from "../lib/command-utils.js";
import { GadgetName, isFileReadingGadget } from "../lib/constants.js";

export default class Ingest extends Command {
  static description = "Create agent understanding files for TypeScript code";

  static examples = [
    "<%= config.bin %> ingest",
    "<%= config.bin %> ingest --model sonnet",
    "<%= config.bin %> ingest --max-iterations 20",
    "<%= config.bin %> ingest -v",
  ];

  static flags = agentFlags;

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
    const existingAu = await auList.execute({ path: "." });

    // Count existing .au files and lines
    const existingContent = existingAu as string;
    const existingCount = countAuEntries(existingContent);
    if (existingCount > 0) {
      const lines = countAuLines(existingContent);
      out.setInitialLines(lines);
      out.success(`Found ${existingCount} existing understanding entries (${lines} lines)`);
    }

    // Initialize progress tracker by scanning all source files
    const progressTracker = new ProgressTracker();
    await progressTracker.scanSourceFiles(".");
    await progressTracker.scanExistingAuFiles(".");
    out.setProgressTracker(progressTracker);

    const initialCounts = progressTracker.getCounts();
    out.info(`Progress: ${progressTracker.getProgressPercent()}% (${initialCounts.documented}/${initialCounts.total} files)`);

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
          pendingItems: progressTracker.getPendingItems(10),
          pendingCount: counts.pending,
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
                // Extract filePath and line diff from the result message
                const match = result.result?.match(/Updated understanding at (.+?) \[\d+→\d+:([+-]?\d+)\]/);
                if (match) {
                  const auPath = match[1];
                  const lineDiff = parseInt(match[2], 10);
                  const sourcePath = auPath.replace(/\.au$/, "").replace(/\/\.au$/, "");
                  progressTracker.markDocumented(sourcePath);
                  out.documenting(sourcePath, lineDiff);
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
