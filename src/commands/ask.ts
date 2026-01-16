import { Command, Flags, Args } from "@oclif/core";
import { AgentBuilder, LLMist } from "llmist";
import { auList } from "../gadgets/index.js";
import { ASK_SYSTEM_PROMPT, ASK_INITIAL_PROMPT, REFINE_SYSTEM_PROMPT, REFINE_INITIAL_PROMPT } from "../lib/ask-system-prompt.js";
import { Output } from "../lib/output.js";
import {
  commonFlags,
  configureBuilder,
  createTextBlockState,
  setupIterationTracking,
  withWorkingDirectory,
  selectReadGadgets,
} from "../lib/command-utils.js";
import { runAgentWithEvents } from "../lib/agent-runner.js";
import { findAuFiles } from "../lib/au-paths.js";

export default class Ask extends Command {
  static description = "Ask questions about the codebase using both AU understanding and source code";

  static examples = [
    '<%= config.bin %> ask "What does the ingest command do?"',
    '<%= config.bin %> ask "How are gadgets registered?" --model sonnet',
    '<%= config.bin %> ask -v "Explain the file filtering logic"',
    '<%= config.bin %> ask "What is the architecture?" --au-only',
    '<%= config.bin %> ask "Show me the main entry point" --code-only',
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
    "au-only": Flags.boolean({
      description: "Use only AU files, no source code reading",
      default: false,
      exclusive: ["code-only"],
    }),
    "code-only": Flags.boolean({
      description: "Use only source code, no AU files",
      default: false,
      exclusive: ["au-only"],
    }),
    "no-refine": Flags.boolean({
      description: "Skip the refinement pass (faster but may miss patterns)",
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Ask);
    const out = new Output({ verbose: flags.verbose });

    const { restore } = withWorkingDirectory(flags.path, out);

    const client = new LLMist();

    const auOnly = flags["au-only"];
    const codeOnly = flags["code-only"];

    // Load existing understanding (unless code-only mode)
    let existingAu: string | null = null;
    if (!codeOnly) {
      out.info("Loading existing understanding...");
      const { files: auFiles } = await findAuFiles(".", true);

      if (auFiles.length === 0) {
        out.warn("No existing understanding found. Run 'au ingest' first for best results.");
      } else {
        existingAu = await auList.execute({ path: "." }) as string;
        out.success(`Loaded ${auFiles.length} understanding entries`);
      }
    }

    // Build the agent with appropriate gadgets
    const gadgets = selectReadGadgets({ auOnly, codeOnly });

    // Helper to run an agent and collect its output
    const runAgent = async (
      systemPrompt: string,
      initialPrompt: string,
      label: string
    ): Promise<string> => {
      let agentBuilder = new AgentBuilder(client)
        .withModel(flags.model)
        .withSystem(systemPrompt)
        .withMaxIterations(flags["max-iterations"])
        .withGadgets(...gadgets);

      agentBuilder = configureBuilder(agentBuilder, out, flags.rpm, flags.tpm);

      // Inject AU context
      if (existingAu) {
        agentBuilder.withSyntheticGadgetCall(
          "AUList",
          { path: "." },
          existingAu,
          "gc_init_1"
        );
      }

      const agent = agentBuilder.ask(initialPrompt);

      out.info(`${label}...`);

      const textState = createTextBlockState();

      if (flags.verbose) {
        const tree = agent.getTree();
        setupIterationTracking(tree, { out });
      }

      return runAgentWithEvents(agent, {
        out,
        textState,
        verbose: flags.verbose,
      });
    };

    const noRefine = flags["no-refine"];

    try {
      // Phase 1: Initial exploration and answer
      const initialAnswer = await runAgent(
        ASK_SYSTEM_PROMPT({ auOnly, codeOnly }),
        ASK_INITIAL_PROMPT(args.question, { auOnly, codeOnly }),
        "Thinking"
      );

      let finalAnswer = initialAnswer;

      // Phase 2: Refinement pass (unless --no-refine or au-only/code-only modes)
      if (!noRefine && !auOnly && !codeOnly) {
        if (flags.verbose) {
          out.info("\n--- Refinement Phase ---");
        }
        finalAnswer = await runAgent(
          REFINE_SYSTEM_PROMPT(),
          REFINE_INITIAL_PROMPT(args.question, initialAnswer),
          "Refining"
        );
      }

      // Output final answer
      if (!flags.verbose) {
        console.log();
        console.log(finalAnswer.trim());
      }
    } catch (error) {
      out.error(`Agent error: ${error instanceof Error ? error.message : error}`);
      restore();
      process.exit(1);
    } finally {
      restore();
    }
  }
}
