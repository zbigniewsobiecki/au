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
} from "../gadgets/index.js";
import { SYSTEM_PROMPT, INITIAL_PROMPT } from "../lib/system-prompt.js";
import { Output } from "../lib/output.js";

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
      paths: [flags.path],
      depth: 2,
    });

    out.info("Checking existing understanding...");
    const existingAu = await auList.execute({ path: flags.path });

    // Count existing .au files
    const existingCount = (existingAu as string).includes("No existing")
      ? 0
      : (existingAu as string).split("===").length - 1;
    if (existingCount > 0) {
      out.success(`Found ${existingCount} existing understanding entries`);
    }

    // Build the agent
    const builder = new AgentBuilder(client)
      .withModel(flags.model)
      .withSystem(SYSTEM_PROMPT)
      .withMaxIterations(flags["max-iterations"])
      .withGadgets(auUpdate, auRead, auList, readFiles, readDirs, ripGrep)
      .withTextOnlyHandler("acknowledge");

    // Inject initial context as synthetic gadget calls
    builder.withSyntheticGadgetCall(
      "ReadDirs",
      { paths: [flags.path], depth: 2 },
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
            // Extract filePath from the result message
            const match = result.result?.match(/Updated understanding at (.+)/);
            if (match) {
              const auPath = match[1];
              // Convert .au path back to source path for display
              const sourcePath = auPath.replace(/\.au$/, "").replace(/\/\.au$/, "");
              out.documenting(sourcePath);
            }
          }
        }
      }
    }

    // End any remaining text block
    if (inTextBlock) {
      out.thinkingEnd();
    }

    out.summary();
  }
}
