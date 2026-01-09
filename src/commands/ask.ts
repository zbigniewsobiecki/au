import { Command, Flags, Args } from "@oclif/core";
import { AgentBuilder, LLMist } from "llmist";
import type { ExecutionEvent } from "llmist";
import {
  auRead,
  auList,
  readFiles,
  readDirs,
  ripGrep,
} from "../gadgets/index.js";
import { ASK_SYSTEM_PROMPT, ASK_INITIAL_PROMPT } from "../lib/ask-system-prompt.js";
import { Output } from "../lib/output.js";

export default class Ask extends Command {
  static description = "Ask questions about the codebase using AU understanding";

  static examples = [
    '<%= config.bin %> ask "What does the ingest command do?"',
    '<%= config.bin %> ask "How are gadgets registered?" --model sonnet',
    '<%= config.bin %> ask -v "Explain the file filtering logic"',
  ];

  static args = {
    question: Args.string({
      description: "Question to ask about the codebase",
      required: true,
    }),
  };

  static flags = {
    model: Flags.string({
      char: "m",
      description: "LLM model to use",
      default: "sonnet",
    }),
    "max-iterations": Flags.integer({
      char: "i",
      description: "Maximum agent iterations",
      default: 10,
    }),
    path: Flags.string({
      char: "p",
      description: "Root path of the codebase",
      default: ".",
    }),
    verbose: Flags.boolean({
      char: "v",
      description: "Show detailed output with gadget calls",
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Ask);
    const out = new Output({ verbose: flags.verbose });

    const client = new LLMist();

    // Load existing understanding
    out.info("Loading existing understanding...");
    const existingAu = await auList.execute({ path: flags.path });

    const existingContent = existingAu as string;
    if (existingContent.includes("No existing")) {
      out.warn("No existing understanding found. Run 'au ingest' first for best results.");
    } else {
      const existingCount = existingContent.split("===").length - 1;
      out.success(`Loaded ${existingCount} understanding entries`);
    }

    // Build the agent with read-only gadgets (no auUpdate)
    const builder = new AgentBuilder(client)
      .withModel(flags.model)
      .withSystem(ASK_SYSTEM_PROMPT)
      .withMaxIterations(flags["max-iterations"])
      .withGadgets(auRead, auList, readFiles, readDirs, ripGrep);

    // Inject existing understanding as context
    builder.withSyntheticGadgetCall(
      "AUList",
      { path: flags.path },
      existingAu as string,
      "gc_init_1"
    );

    // Create and run the agent with the question
    const agent = builder.ask(ASK_INITIAL_PROMPT(args.question));

    out.info("Thinking...");

    // Track current iteration
    let currentIteration = 0;

    // Subscribe to ExecutionTree for iteration tracking
    const tree = agent.getTree();
    tree.onAll((event: ExecutionEvent) => {
      if (event.type === "llm_call_start") {
        currentIteration = event.iteration + 1;
        if (flags.verbose) {
          out.iteration(currentIteration);
        }
      } else if (event.type === "llm_call_complete") {
        if (flags.verbose && (event.usage || event.cost)) {
          out.iterationStats(
            event.usage?.inputTokens || 0,
            event.usage?.outputTokens || 0,
            event.cost || 0
          );
        }
      }
    });

    // Collect the answer text
    let answer = "";
    let inTextBlock = false;

    // Run and stream events from the agent
    for await (const event of agent.run()) {
      if (event.type === "text") {
        answer += event.content;
        if (flags.verbose) {
          // In verbose mode, show thinking as it happens
          if (!inTextBlock) {
            inTextBlock = true;
          }
          out.thinkingChunk(event.content);
        }
      } else if (event.type === "gadget_call") {
        if (flags.verbose) {
          if (inTextBlock) {
            out.thinkingEnd();
            inTextBlock = false;
          }
          const params = event.call.parameters as Record<string, unknown>;
          out.gadgetCall(event.call.gadgetName, params);
        }
      } else if (event.type === "gadget_result") {
        if (flags.verbose) {
          const result = event.result;
          if (result.error) {
            out.gadgetError(result.gadgetName, result.error);
          } else {
            let summary: string | undefined;
            if (result.gadgetName === "ReadFiles" || result.gadgetName === "ReadDirs") {
              const resultLength = result.result?.length || 0;
              summary = `${(resultLength / 1024).toFixed(1)}kb`;
            }
            out.gadgetResult(result.gadgetName, summary);
          }
        }
      }
    }

    // End any remaining text block in verbose mode
    if (flags.verbose && inTextBlock) {
      out.thinkingEnd();
    }

    // In non-verbose mode, print the final answer
    if (!flags.verbose) {
      console.log();
      console.log(answer.trim());
    }
  }
}
