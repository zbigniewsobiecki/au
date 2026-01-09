import { Command, Flags } from "@oclif/core";
import { AgentBuilder, LLMist, ExecutionTree } from "llmist";
import type { ExecutionEvent } from "llmist";
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

export default class Ingest extends Command {
  static description = "Create agent understanding files for TypeScript code";

  static examples = [
    "<%= config.bin %> ingest",
    "<%= config.bin %> ingest --model sonnet",
    "<%= config.bin %> ingest --max-iterations 20",
    "<%= config.bin %> ingest -v",
  ];

  static flags = {
    model: Flags.string({
      char: "m",
      description: "LLM model to use",
      default: "sonnet",
    }),
    "max-iterations": Flags.integer({
      char: "i",
      description: "Maximum agent iterations",
      default: 50,
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

  async run(): Promise<void> {
    const { flags } = await this.parse(Ingest);
    const out = new Output({ verbose: flags.verbose });

    const client = new LLMist();

    // Generate initial context by executing gadgets directly
    out.info("Scanning directory structure...");
    if (!flags.verbose) {
      console.log("Scanning codebase...");
    }
    const dirStructure = await readDirs.execute({
      paths: flags.path,
      depth: 10,
    });

    out.info("Checking existing understanding...");
    const existingAu = await auList.execute({ path: flags.path });

    // Count existing .au files and lines
    const existingContent = existingAu as string;
    if (!existingContent.includes("No existing")) {
      const existingCount = existingContent.split("===").length - 1;
      // Count lines (excluding === header lines)
      const lines = existingContent.split("\n").filter(line => !line.startsWith("===")).length;
      out.setInitialLines(lines);
      out.success(`Found ${existingCount} existing understanding entries (${lines} lines)`);
    }

    // Initialize progress tracker by scanning all source files
    const progressTracker = new ProgressTracker();
    await progressTracker.scanSourceFiles(flags.path);
    await progressTracker.scanExistingAuFiles(flags.path);
    out.setProgressTracker(progressTracker);

    const initialCounts = progressTracker.getCounts();
    out.info(`Progress: ${progressTracker.getProgressPercent()}% (${initialCounts.documented}/${initialCounts.total} files)`);

    // Build the agent
    const builder = new AgentBuilder(client)
      .withModel(flags.model)
      .withSystem(SYSTEM_PROMPT)
      .withMaxIterations(flags["max-iterations"])
      .withGadgets(auUpdate, auRead, auList, readFiles, readDirs, ripGrep, finish)
      .withTextOnlyHandler("acknowledge")
      .withRetry({
        retries: 5,
        minTimeout: 2000,
        maxTimeout: 60000,
        onRetry: (error, attempt) => {
          out.warn(`Retry ${attempt}/5: ${error.message}`);
        },
        onRetriesExhausted: (error, attempts) => {
          out.error(`Failed after ${attempts} attempts: ${error.message}`);
        },
      })
      .withRateLimits({
        requestsPerMinute: flags.rpm,
        tokensPerMinute: flags.tpm * 1000,
        safetyMargin: 0.8,
      })
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
      { paths: flags.path, depth: 10 },
      dirStructure as string,
      "gc_init_1"
    );

    builder.withSyntheticGadgetCall(
      "AUList",
      { path: flags.path },
      existingAu as string,
      "gc_init_2"
    );

    // Create and run the agent
    const agent = builder.ask(INITIAL_PROMPT);

    out.info("Starting codebase analysis...");

    // Track if we're in the middle of text output
    let inTextBlock = false;

    // Track current iteration for cumulative cost display
    let currentIteration = 0;

    // Subscribe to ExecutionTree for proper iteration and cost tracking
    const tree = agent.getTree();
    tree.onAll((event: ExecutionEvent) => {
      if (event.type === "llm_call_start") {
        // New LLM call = new iteration
        // iteration is 0-indexed in events, display as 1-indexed
        currentIteration = event.iteration + 1;
        if (inTextBlock) {
          out.thinkingEnd();
          inTextBlock = false;
        }
        out.iteration(currentIteration);
      } else if (event.type === "llm_call_complete") {
        // Track tokens and cost from LLM call
        if (event.usage || event.cost) {
          out.iterationStats(
            event.usage?.inputTokens || 0,
            event.usage?.outputTokens || 0,
            event.cost || 0
          );
        }

        // Show cumulative cost every 10 iterations
        if (currentIteration > 0 && currentIteration % 10 === 0) {
          out.cumulativeCost();
        }
      }
    });

    // Run and stream events from the agent
    try {
      for await (const event of agent.run()) {
        if (event.type === "text") {
          inTextBlock = true;
          out.thinkingChunk(event.content);
        } else if (event.type === "gadget_call") {
          if (inTextBlock) {
            out.thinkingEnd();
            inTextBlock = false;
          }
          const params = event.call.parameters as Record<string, unknown>;
          out.gadgetCall(event.call.gadgetName, params);
        } else if (event.type === "gadget_result") {
          const result = event.result;

          if (result.error) {
            out.gadgetError(result.gadgetName, result.error);
          } else {
            // Create summary based on gadget type
            let summary: string | undefined;

            if (result.gadgetName === "ReadFiles" || result.gadgetName === "ReadDirs") {
              const resultLength = result.result?.length || 0;
              summary = `${(resultLength / 1024).toFixed(1)}kb`;
            }

            out.gadgetResult(result.gadgetName, summary);

            // Special handling for AUUpdate
            if (result.gadgetName === "AUUpdate") {
              // Check if this is an error response (e.g., non-existent source file)
              if (result.result?.startsWith("Error:")) {
                out.warn(result.result);
              } else {
                // Extract filePath and line diff from the result message
                // Format: "Updated understanding at path.au [old→new:diff]"
                const match = result.result?.match(/Updated understanding at (.+?) \[\d+→\d+:([+-]?\d+)\]/);
                if (match) {
                  const auPath = match[1];
                  const lineDiff = parseInt(match[2], 10);
                  // Convert .au path back to source path for display
                  const sourcePath = auPath.replace(/\.au$/, "").replace(/\/\.au$/, "");

                  // Update progress tracker
                  progressTracker.markDocumented(sourcePath);

                  out.documenting(sourcePath, lineDiff);
                }
              }
            }
          }
        }
      }

      // End any remaining text block
      if (inTextBlock) {
        out.thinkingEnd();
      }
    } catch (error) {
      if (inTextBlock) {
        out.thinkingEnd();
      }
      out.error(`Agent error: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }

    out.summary();
  }
}
