import { Command, Flags } from "@oclif/core";
import { readFile, writeFile } from "node:fs/promises";
import { AgentBuilder, LLMist } from "llmist";
import { parse as parseYaml } from "yaml";
import { ASK_SYSTEM_PROMPT, ASK_INITIAL_PROMPT } from "../lib/ask-system-prompt.js";
import { Output } from "../lib/output.js";
import {
  commonFlags,
  configureBuilder,
  withWorkingDirectory,
  selectReadGadgets,
} from "../lib/command-utils.js";

type Mode = "model-only" | "code-only" | "default";

interface BenchmarkResult {
  question: string;
  mode: Mode;
  iterations: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  timeMs: number;
  answer: string;
  gadgetCalls: Record<string, number>;
}

interface QuestionEntry {
  question: string;
  category?: string;
}

export default class Benchmark extends Command {
  static description = "Compare ask modes with benchmark questions";

  static examples = [
    '<%= config.bin %> benchmark -q "What is the architecture?"',
    '<%= config.bin %> benchmark --questions questions.yaml --path ~/Code/myproject',
    '<%= config.bin %> benchmark -q "How does auth work?" --modes model-only,default',
  ];

  static flags = {
    ...commonFlags,
    question: Flags.string({
      char: "q",
      description: "Single question to benchmark",
    }),
    questions: Flags.string({
      description: "Path to YAML file with questions",
    }),
    modes: Flags.string({
      default: "model-only,code-only,default",
      description: "Comma-separated modes to compare",
    }),
    output: Flags.string({
      char: "o",
      description: "Output file for results (markdown)",
    }),
    "max-iterations": Flags.integer({
      char: "i",
      description: "Maximum agent iterations per run",
      default: 10,
    }),
    json: Flags.boolean({
      description: "Output results as JSON",
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Benchmark);
    const out = new Output({ verbose: flags.verbose });

    const { restore } = withWorkingDirectory(flags.path, out);

    // Load questions
    let questions: QuestionEntry[] = [];
    if (flags.question) {
      questions = [{ question: flags.question }];
    } else if (flags.questions) {
      try {
        const content = await readFile(flags.questions, "utf-8");
        questions = parseYaml(content) as QuestionEntry[];
      } catch (error) {
        out.error(`Failed to load questions: ${error}`);
        process.exit(1);
      }
    } else {
      out.error("Provide --question or --questions");
      process.exit(1);
    }

    // Parse modes
    const modes = flags.modes.split(",").map((m) => m.trim()) as Mode[];
    const validModes: Mode[] = ["model-only", "code-only", "default"];
    for (const mode of modes) {
      if (!validModes.includes(mode)) {
        out.error(`Invalid mode: ${mode}. Valid: ${validModes.join(", ")}`);
        process.exit(1);
      }
    }

    out.info(`Running ${questions.length} question(s) across ${modes.length} mode(s)`);
    console.log();

    const results: BenchmarkResult[] = [];

    for (const entry of questions) {
      const shortQ = entry.question.slice(0, 50) + (entry.question.length > 50 ? "..." : "");
      out.info(`Question: "${shortQ}"`);

      for (const mode of modes) {
        out.info(`  Mode: ${mode}...`);
        const startTime = Date.now();

        try {
          const result = await this.runQuestion(entry.question, mode, flags, out);
          result.timeMs = Date.now() - startTime;
          results.push(result);

          out.success(`    ${result.iterations} iterations, ${result.totalTokens} tokens, ${(result.timeMs / 1000).toFixed(1)}s`);
        } catch (error) {
          out.error(`    Failed: ${error}`);
          results.push({
            question: entry.question,
            mode,
            iterations: 0,
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            costUsd: 0,
            timeMs: Date.now() - startTime,
            answer: `Error: ${error}`,
            gadgetCalls: {},
          });
        }
      }
      console.log();
    }

    restore();

    // Output results
    if (flags.json) {
      const output = JSON.stringify(results, null, 2);
      if (flags.output) {
        await writeFile(flags.output, output);
        out.success(`Results written to ${flags.output}`);
      } else {
        console.log(output);
      }
    } else {
      const markdown = this.formatMarkdown(results);
      if (flags.output) {
        await writeFile(flags.output, markdown);
        out.success(`Results written to ${flags.output}`);
      } else {
        console.log(markdown);
      }
    }
  }

  private async runQuestion(
    question: string,
    mode: Mode,
    flags: { model: string; rpm: number; tpm: number; "max-iterations": number },
    out: Output
  ): Promise<BenchmarkResult> {
    const client = new LLMist();

    const modelOnly = mode === "model-only";
    const codeOnly = mode === "code-only";

    // Select gadgets - no preloading, agent discovers on demand
    const gadgets = selectReadGadgets({ modelOnly, codeOnly });

    let builder = new AgentBuilder(client)
      .withModel(flags.model)
      .withSystem(ASK_SYSTEM_PROMPT({ sysmlOnly: modelOnly, codeOnly }))
      .withMaxIterations(flags["max-iterations"])
      .withGadgetExecutionMode("sequential")
      .withGadgets(...gadgets);

    builder = configureBuilder(builder, out, flags.rpm, flags.tpm);

    const agent = builder.ask(ASK_INITIAL_PROMPT(question));

    // Track metrics
    let iterations = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    const gadgetCalls: Record<string, number> = {};
    let answer = "";

    const tree = agent.getTree();
    tree.onAll((event) => {
      if (event.type === "llm_call_start") {
        iterations = event.iteration + 1;
      } else if (event.type === "llm_call_complete") {
        inputTokens += event.usage?.inputTokens || 0;
        outputTokens += event.usage?.outputTokens || 0;
        costUsd += event.cost || 0;
      }
    });

    // Run agent
    for await (const event of agent.run()) {
      if (event.type === "text") {
        answer += event.content;
      } else if (event.type === "gadget_call") {
        const name = event.call.gadgetName;
        gadgetCalls[name] = (gadgetCalls[name] || 0) + 1;
      }
    }

    return {
      question,
      mode,
      iterations,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      costUsd,
      timeMs: 0, // filled in by caller
      answer: answer.trim(),
      gadgetCalls,
    };
  }

  private formatMarkdown(results: BenchmarkResult[]): string {
    const lines: string[] = [];
    lines.push("# Benchmark Results\n");

    // Group by question
    const byQuestion = new Map<string, BenchmarkResult[]>();
    for (const r of results) {
      const existing = byQuestion.get(r.question) || [];
      existing.push(r);
      byQuestion.set(r.question, existing);
    }

    // Summary table
    lines.push("## Summary\n");
    lines.push("| Question | Mode | Iterations | Tokens | Cost | Time |");
    lines.push("|----------|------|------------|--------|------|------|");

    for (const [question, questionResults] of byQuestion) {
      const shortQ = question.slice(0, 40) + (question.length > 40 ? "..." : "");
      for (const r of questionResults) {
        lines.push(
          `| ${shortQ} | ${r.mode} | ${r.iterations} | ${r.totalTokens.toLocaleString()} | $${r.costUsd.toFixed(4)} | ${(r.timeMs / 1000).toFixed(1)}s |`
        );
      }
    }

    // Comparison section
    lines.push("\n## Mode Comparison\n");
    for (const [question, questionResults] of byQuestion) {
      lines.push(`### ${question.slice(0, 60)}${question.length > 60 ? "..." : ""}\n`);

      const modelOnlyResult = questionResults.find((r) => r.mode === "model-only");
      const codeOnlyResult = questionResults.find((r) => r.mode === "code-only");
      const defaultResult = questionResults.find((r) => r.mode === "default");

      if (modelOnlyResult && codeOnlyResult) {
        const iterSaved = codeOnlyResult.iterations - modelOnlyResult.iterations;
        const tokenSaved = codeOnlyResult.totalTokens - modelOnlyResult.totalTokens;
        const timeSaved = codeOnlyResult.timeMs - modelOnlyResult.timeMs;

        lines.push(`**Model-only vs Code-only:**`);
        lines.push(`- Iterations saved: ${iterSaved} (${modelOnlyResult.iterations} vs ${codeOnlyResult.iterations})`);
        lines.push(`- Tokens saved: ${tokenSaved.toLocaleString()} (${modelOnlyResult.totalTokens.toLocaleString()} vs ${codeOnlyResult.totalTokens.toLocaleString()})`);
        lines.push(`- Time saved: ${(timeSaved / 1000).toFixed(1)}s`);
        lines.push("");
      }

      if (modelOnlyResult && defaultResult) {
        const iterSaved = defaultResult.iterations - modelOnlyResult.iterations;
        const tokenSaved = defaultResult.totalTokens - modelOnlyResult.totalTokens;

        lines.push(`**Model-only vs Default:**`);
        lines.push(`- Iterations saved: ${iterSaved} (${modelOnlyResult.iterations} vs ${defaultResult.iterations})`);
        lines.push(`- Tokens saved: ${tokenSaved.toLocaleString()}`);
        lines.push("");
      }

      // Gadget calls breakdown
      lines.push("**Gadget calls:**");
      for (const r of questionResults) {
        const calls = Object.entries(r.gadgetCalls)
          .map(([k, v]) => `${k}:${v}`)
          .join(", ") || "none";
        lines.push(`- ${r.mode}: ${calls}`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }
}
