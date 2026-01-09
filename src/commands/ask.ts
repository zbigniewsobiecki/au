import { Command, Flags, Args } from "@oclif/core";
import { AgentBuilder, LLMist } from "llmist";
import {
  auRead,
  auList,
  readFiles,
  readDirs,
  ripGrep,
} from "../gadgets/index.js";
import { ASK_SYSTEM_PROMPT, ASK_INITIAL_PROMPT } from "../lib/ask-system-prompt.js";
import { Output } from "../lib/output.js";
import {
  commonFlags,
  configureBuilder,
  createTextBlockState,
  endTextBlock,
  formatResultSize,
  setupIterationTracking,
  countAuEntries,
} from "../lib/command-utils.js";
import { isFileReadingGadget } from "../lib/constants.js";

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
    ...commonFlags,
    "max-iterations": Flags.integer({
      char: "i",
      description: "Maximum agent iterations",
      default: 10,
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
    const existingCount = countAuEntries(existingContent);
    if (existingCount === 0) {
      out.warn("No existing understanding found. Run 'au ingest' first for best results.");
    } else {
      out.success(`Loaded ${existingCount} understanding entries`);
    }

    // Build the agent with read-only gadgets (no auUpdate)
    let builder = new AgentBuilder(client)
      .withModel(flags.model)
      .withSystem(ASK_SYSTEM_PROMPT)
      .withMaxIterations(flags["max-iterations"])
      .withGadgets(auRead, auList, readFiles, readDirs, ripGrep);

    builder = configureBuilder(builder, out, flags.rpm, flags.tpm);

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

    // Track text block state and iteration (only show in verbose mode)
    const textState = createTextBlockState();
    const tree = agent.getTree();

    if (flags.verbose) {
      setupIterationTracking(tree, { out });
    }

    // Collect the answer text
    let answer = "";

    // Run and stream events from the agent
    try {
      for await (const event of agent.run()) {
        if (event.type === "text") {
          answer += event.content;
          if (flags.verbose) {
            textState.inTextBlock = true;
            out.thinkingChunk(event.content);
          }
        } else if (event.type === "gadget_call") {
          if (flags.verbose) {
            endTextBlock(textState, out);
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
              if (isFileReadingGadget(result.gadgetName)) {
                summary = formatResultSize(result.result);
              }
              out.gadgetResult(result.gadgetName, summary);
            }
          }
        }
      }

      if (flags.verbose) {
        endTextBlock(textState, out);
      }

      // In non-verbose mode, print the final answer
      if (!flags.verbose) {
        console.log();
        console.log(answer.trim());
      }
    } catch (error) {
      if (flags.verbose) {
        endTextBlock(textState, out);
      }
      out.error(`Agent error: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  }
}
