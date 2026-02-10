import { Command, Flags, Args } from "@oclif/core";
import { AgentBuilder, LLMist, AbstractGadget } from "llmist";
import { stat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sysmlList } from "../gadgets/index.js";
import { ASK_SYSTEM_PROMPT, ASK_INITIAL_PROMPT, REFINE_SYSTEM_PROMPT, REFINE_INITIAL_PROMPT } from "../lib/ask-system-prompt.js";
import { dumpModel } from "../lib/sysml/sysml2-cli.js";
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

export default class Ask extends Command {
  static description = "Ask questions about the codebase using SysML model and source code";

  static examples = [
    '<%= config.bin %> ask "What does the ingest command do?"',
    '<%= config.bin %> ask "How are gadgets registered?" --model sonnet',
    '<%= config.bin %> ask -v "Explain the file filtering logic"',
    '<%= config.bin %> ask "What is the architecture?" --sysml-only',
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
    "sysml-only": Flags.boolean({
      description: "Use only SysML model, no source code reading",
      default: false,
      exclusive: ["code-only"],
    }),
    "code-only": Flags.boolean({
      description: "Use only source code, no SysML model",
      default: false,
      exclusive: ["sysml-only"],
    }),
    "no-refine": Flags.boolean({
      description: "Skip the refinement pass (faster but may miss patterns)",
      default: false,
    }),
    preload: Flags.boolean({
      description: "Pre-load entire SysML model into context (enables prompt caching)",
      default: false,
      exclusive: ["code-only"],
    }),
    system: Flags.string({
      char: "s",
      description: "Custom system prompt for initial phase",
      exclusive: ["system-file"],
    }),
    "system-file": Flags.string({
      char: "S",
      description: "Path to file containing custom system prompt for initial phase",
      exclusive: ["system"],
    }),
    output: Flags.string({
      char: "o",
      description: "Write final answer to a file (markdown)",
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Ask);
    const out = new Output({ verbose: flags.verbose });

    const { restore } = withWorkingDirectory(flags.path, out);

    const client = new LLMist();

    const sysmlOnly = flags["sysml-only"];
    const codeOnly = flags["code-only"];
    const preload = flags.preload;

    // Check for SysML model (unless code-only mode)
    let existingSysml: string | null = null;
    let preloadedModel: string | null = null;

    if (!codeOnly) {
      const sysmlDir = join(".", ".sysml");
      try {
        const dirStat = await stat(sysmlDir);
        if (dirStat.isDirectory()) {
          if (preload) {
            // Pre-load entire model into context
            out.info("Pre-loading SysML model...");
            preloadedModel = await dumpModel(sysmlDir);
            const lineCount = preloadedModel.split("\n").length;
            out.success(`Pre-loaded model (${lineCount} lines)`);
          } else {
            // Normal mode: just list files
            out.info("Loading SysML model...");
            existingSysml = await sysmlList.execute({ reason: "List available SysML files" }) as string;
            const fileCount = (existingSysml.match(/\.sysml/g) || []).length;
            out.success(`Loaded ${fileCount} SysML model files`);
          }
        }
      } catch {
        out.warn("No SysML model found. Run 'au sysml:ingest' first for best results.");
        if (sysmlOnly || preload) {
          out.error("Cannot use --sysml-only or --preload without a SysML model. Run 'au sysml:ingest' first.");
          restore();
          process.exit(1);
        }
      }
    }

    // Build the agent with appropriate gadgets
    const gadgets = selectReadGadgets({ modelOnly: sysmlOnly, codeOnly, preload });

    // Helper to run an agent and collect its output
    const runAgent = async (
      systemPrompt: string,
      initialPrompt: string,
      label: string,
      gadgetsForPhase: AbstractGadget[] = gadgets
    ): Promise<string> => {
      // When preload is enabled, append model to system prompt for caching
      let finalSystemPrompt = systemPrompt;
      if (preloadedModel) {
        finalSystemPrompt = `${systemPrompt}\n\n<sysml-model>\n${preloadedModel}\n</sysml-model>`;
      }

      let agentBuilder = new AgentBuilder(client)
        .withModel(flags.model)
        .withSystem(finalSystemPrompt)
        .withMaxIterations(flags["max-iterations"])
        .withGadgets(...gadgetsForPhase);

      agentBuilder = configureBuilder(agentBuilder, out, flags.rpm, flags.tpm);

      // Inject SysML context (only when not in preload mode)
      if (existingSysml && !preload) {
        agentBuilder.withSyntheticGadgetCall(
          "SysMLList",
          { reason: "List available SysML model files" },
          existingSysml,
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

    // Get the default system prompt (contains gadget definitions, strategies, etc.)
    // Skip persona line if user provided custom system prompt
    const hasCustomSystem = Boolean(flags.system || flags["system-file"]);
    const defaultSystemPrompt = ASK_SYSTEM_PROMPT({ sysmlOnly, codeOnly, preload, skipPersona: hasCustomSystem });

    // Compose with custom user prompt if provided
    let initialSystemPrompt: string;
    if (flags.system) {
      // User prompt first (task context), then default (tool information)
      initialSystemPrompt = flags.system + "\n\n" + defaultSystemPrompt;
    } else if (flags["system-file"]) {
      const customPrompt = await readFile(flags["system-file"], "utf-8");
      initialSystemPrompt = customPrompt + "\n\n" + defaultSystemPrompt;
    } else {
      initialSystemPrompt = defaultSystemPrompt;
    }

    try {
      // Phase 1: Initial exploration and answer
      // When preload is enabled, no tools needed - model is already in context
      const phase1Gadgets = preload ? [] : gadgets;
      const initialAnswer = await runAgent(
        initialSystemPrompt,
        ASK_INITIAL_PROMPT(args.question, { sysmlOnly, codeOnly, preload }),
        "Thinking",
        phase1Gadgets
      );

      let finalAnswer = initialAnswer;

      // Phase 2: Refinement pass
      // - Skip if --no-refine
      // - Skip if --sysml-only WITHOUT preload (no source code to verify against)
      // - Skip if --code-only (no model to compare with)
      // - ALLOW if --preload + --sysml-only (verify model-based answer against source)
      const canRefine = !noRefine && !codeOnly && (!sysmlOnly || preload);
      if (canRefine) {
        if (flags.verbose) {
          out.info("\n--- Refinement Phase ---");
        }
        finalAnswer = await runAgent(
          REFINE_SYSTEM_PROMPT({ preload }),
          REFINE_INITIAL_PROMPT(args.question, initialAnswer, { preload }),
          "Refining",
          gadgets  // Full gadgets for refinement phase
        );
      }

      // Output final answer
      if (!flags.verbose) {
        console.log();
        console.log(finalAnswer.trim());
      }

      // Write to file if requested
      if (flags.output) {
        await writeFile(flags.output, finalAnswer.trim() + "\n", "utf-8");
        out.success(`Answer written to ${flags.output}`);
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
