import { Command, Flags } from "@oclif/core";
import { AgentBuilder, LLMist } from "llmist";
import { rm, mkdir } from "node:fs/promises";
import {
  auRead,
  auList,
  auListSummary,
  writeDoc,
  setTargetDir,
  readFiles,
  readDirs,
  ripGrep,
} from "../gadgets/index.js";
import { docPlan, finishPlanning, finishDocs } from "../gadgets/doc-gadgets.js";
import { Output } from "../lib/output.js";
import { render } from "../lib/templates.js";
import {
  agentFlags,
  configureBuilder,
  createTextBlockState,
  endTextBlock,
  setupIterationTracking,
} from "../lib/command-utils.js";

interface DocPlanStructure {
  structure: Array<{
    directory: string;
    documents: Array<{
      path: string;
      title: string;
      description: string;
      order: number;
    }>;
  }>;
}

export default class Document extends Command {
  static description = "Generate markdown documentation from AU understanding";

  static examples = [
    "<%= config.bin %> document --target ./docs",
    "<%= config.bin %> document --target ./docs --model opus",
    "<%= config.bin %> document --target ./docs --dry-run",
    "<%= config.bin %> document --target ./docs --au-only",
    "<%= config.bin %> document --target ./docs --code-only",
  ];

  static flags = {
    ...agentFlags,
    target: Flags.string({
      char: "t",
      description: "Target directory for generated documentation",
      required: true,
    }),
    "dry-run": Flags.boolean({
      description: "Show planned structure without writing files",
      default: false,
    }),
    "skip-clear": Flags.boolean({
      description: "Skip clearing target directory",
      default: false,
    }),
    "plan-iterations": Flags.integer({
      description: "Max iterations for planning phase",
      default: 5,
    }),
    "gen-iterations": Flags.integer({
      description: "Max iterations for generation phase",
      default: 30,
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
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Document);
    const out = new Output({ verbose: flags.verbose, progressLabel: "Documentation" });

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

    const auOnly = flags["au-only"];
    const codeOnly = flags["code-only"];

    // Load AU understanding summary (unless code-only mode)
    let auSummary: string | null = null;
    if (!codeOnly) {
      out.info("Loading AU understanding...");
      try {
        auSummary = (await auListSummary.execute({ path: "." })) as string;
      } catch (error) {
        out.error(`Failed to load AU understanding: ${error instanceof Error ? error.message : error}`);
        process.chdir(originalCwd);
        process.exit(1);
      }

      if (!auSummary || auSummary.trim() === "" || auSummary === "No AU entries found.") {
        if (auOnly) {
          out.error("No AU understanding found. Run 'au ingest' first to create understanding files.");
          process.chdir(originalCwd);
          process.exit(1);
        } else {
          out.warn("No AU understanding found. Will use source code only.");
          auSummary = null;
        }
      } else {
        const auEntries = (auSummary.match(/^=== /gm) || []).length;
        out.success(`Found ${auEntries} understanding entries`);
      }
    } else {
      out.info("Code-only mode: skipping AU files");
    }

    // Phase 1: Planning
    out.info("Planning documentation structure...");
    const client = new LLMist();

    const planSystemPrompt = render("document/plan-system", {});
    const planInitialPrompt = render("document/plan-initial", { auSummary: auSummary || "" });

    // Build gadgets based on mode
    let planGadgets;
    if (auOnly) {
      planGadgets = [docPlan, finishPlanning, auRead, auList];
    } else if (codeOnly) {
      planGadgets = [docPlan, finishPlanning, readFiles, readDirs, ripGrep];
    } else {
      planGadgets = [docPlan, finishPlanning, auRead, auList, readFiles, readDirs, ripGrep];
    }

    let planBuilder = new AgentBuilder(client)
      .withModel(flags.model)
      .withSystem(planSystemPrompt)
      .withMaxIterations(flags["plan-iterations"])
      .withGadgetOutputLimitPercent(30)
      .withGadgets(...planGadgets);

    planBuilder = configureBuilder(planBuilder, out, flags.rpm, flags.tpm);

    // Inject AU summary as synthetic call (only if available)
    if (auSummary) {
      planBuilder.withSyntheticGadgetCall(
        "AUListSummary",
        { path: "." },
        auSummary,
        "gc_init_1"
      );
    }

    const planAgent = planBuilder.ask(planInitialPrompt);

    // Track text block state for planning
    const planTextState = createTextBlockState();

    // Subscribe to planning agent for iteration tracking
    const planTree = planAgent.getTree();
    setupIterationTracking(planTree, {
      out,
      showCumulativeCostEvery: 5,
      onIterationChange: () => endTextBlock(planTextState, out),
    });

    // Run planning agent and capture DocPlan
    let documentPlan: DocPlanStructure | null = null;

    try {
      for await (const event of planAgent.run()) {
        if (event.type === "text") {
          planTextState.inTextBlock = true;
          out.thinkingChunk(event.content);
        } else if (event.type === "gadget_call") {
          endTextBlock(planTextState, out);
          const params = event.call.parameters as Record<string, unknown>;
          out.gadgetCall(event.call.gadgetName, params);
        } else if (event.type === "gadget_result") {
          const result = event.result;

          if (result.error) {
            out.gadgetError(result.gadgetName, result.error);
          } else {
            out.gadgetResult(result.gadgetName);

            // Capture DocPlan result
            if (result.gadgetName === "DocPlan" && result.result) {
              // Extract JSON from the result (it's wrapped in <plan> tags)
              const planMatch = result.result.match(/<plan>\s*([\s\S]*?)\s*<\/plan>/);
              if (planMatch) {
                try {
                  documentPlan = JSON.parse(planMatch[1]);
                } catch {
                  out.warn("Failed to parse documentation plan");
                }
              }
            }
          }
        }
      }

      endTextBlock(planTextState, out);
    } catch (error) {
      endTextBlock(planTextState, out);
      out.error(`Planning failed: ${error instanceof Error ? error.message : error}`);
      process.chdir(originalCwd);
      process.exit(1);
    }

    if (!documentPlan) {
      out.error("No documentation plan was created. Check verbose output for details.");
      process.chdir(originalCwd);
      process.exit(1);
    }

    // Display plan summary
    const totalDocs = documentPlan.structure.reduce((sum, dir) => sum + dir.documents.length, 0);
    out.success(`Plan created: ${totalDocs} documents in ${documentPlan.structure.length} directories`);

    console.log();
    out.header("Documentation Plan:");
    for (const dir of documentPlan.structure) {
      console.log(`  ${dir.directory} (${dir.documents.length} docs)`);
      for (const doc of dir.documents) {
        console.log(`    - ${doc.path}`);
      }
    }
    console.log();

    // Handle dry-run mode
    if (flags["dry-run"]) {
      out.success("Dry run complete. Use without --dry-run to generate documentation.");
      process.chdir(originalCwd);
      return;
    }

    // Clear target directory
    const targetDir = flags.target;
    if (!flags["skip-clear"]) {
      out.warn(`Clearing target directory: ${targetDir}`);
      try {
        await rm(targetDir, { recursive: true, force: true });
      } catch {
        // Directory might not exist, that's fine
      }
    }

    // Create target directory
    try {
      await mkdir(targetDir, { recursive: true });
    } catch (error) {
      out.error(`Failed to create target directory: ${error instanceof Error ? error.message : error}`);
      process.chdir(originalCwd);
      process.exit(1);
    }

    // Phase 2: Generation via orchestrator
    out.info("Generating documentation...");

    // Set target directory for WriteFile gadget
    setTargetDir(targetDir);

    const orchestratorSystemPrompt = render("document/orchestrator-system", {});

    // Flatten documents for the orchestrator
    const allDocs = documentPlan.structure.flatMap((dir) =>
      dir.documents.map((doc) => ({
        ...doc,
        directory: dir.directory,
      }))
    );

    // Build research instruction based on mode
    let researchInstruction: string;
    if (auOnly) {
      researchInstruction = "Use AURead to gather relevant information about the topic";
    } else if (codeOnly) {
      researchInstruction = "Use ReadFiles/ReadDirs/RipGrep to gather relevant source code";
    } else {
      researchInstruction = "Use AURead and/or ReadFiles/RipGrep to gather relevant information";
    }

    const orchestratorInitialPrompt = `Generate documentation based on this plan.

Documents to write (${allDocs.length} total):
${allDocs.map((d) => `- ${d.path}: ${d.title} - ${d.description} (order: ${d.order})`).join("\n")}

For each document:
1. ${researchInstruction}
2. Call WriteFile with the path and complete markdown content (including frontmatter)

Work through ALL ${allDocs.length} documents. Call FinishDocs when done.`;

    // Build gadgets based on mode
    let genGadgets;
    if (auOnly) {
      genGadgets = [writeDoc, auRead, auList, finishDocs];
    } else if (codeOnly) {
      genGadgets = [writeDoc, readFiles, readDirs, ripGrep, finishDocs];
    } else {
      genGadgets = [writeDoc, auRead, auList, readFiles, readDirs, ripGrep, finishDocs];
    }

    let genBuilder = new AgentBuilder(client)
      .withModel(flags.model)
      .withSystem(orchestratorSystemPrompt)
      .withMaxIterations(flags["gen-iterations"])
      .withGadgetOutputLimitPercent(30)
      .withGadgets(...genGadgets);

    genBuilder = configureBuilder(genBuilder, out, flags.rpm, flags.tpm);

    // No pre-loading - orchestrator uses AURead on-demand for each document

    const genAgent = genBuilder.ask(orchestratorInitialPrompt);

    // Track progress
    const genTextState = createTextBlockState();
    let docsWritten = 0;

    // Subscribe to generation agent for iteration tracking
    const genTree = genAgent.getTree();
    setupIterationTracking(genTree, {
      out,
      showCumulativeCostEvery: 5,
      onIterationChange: () => endTextBlock(genTextState, out),
    });

    // Run generation agent
    try {
      for await (const event of genAgent.run()) {
        if (event.type === "text") {
          genTextState.inTextBlock = true;
          out.thinkingChunk(event.content);
        } else if (event.type === "gadget_call") {
          endTextBlock(genTextState, out);
          const params = event.call.parameters as Record<string, unknown>;
          out.gadgetCall(event.call.gadgetName, params);
        } else if (event.type === "gadget_result") {
          const result = event.result;

          if (result.error) {
            out.gadgetError(result.gadgetName, result.error);
          } else {
            out.gadgetResult(result.gadgetName);

            // Track WriteFile completions
            if (result.gadgetName === "WriteFile" && result.result) {
              docsWritten++;
              // Parse bytes from result: "Written: path (123 bytes)"
              const match = result.result.match(/Written: (.+) \((\d+) bytes\)/);
              if (match) {
                const [, filePath, bytesStr] = match;
                const bytes = parseInt(bytesStr, 10);
                out.documenting(filePath, bytes, true);
              } else {
                out.success(`[${docsWritten}/${totalDocs}] ${result.result}`);
              }
            }
          }
        }
      }

      endTextBlock(genTextState, out);
    } catch (error) {
      endTextBlock(genTextState, out);
      // TaskCompletionSignal is expected
      if (error instanceof Error && error.message.includes("Documentation complete")) {
        // This is fine, it means we're done
      } else {
        out.error(`Generation failed: ${error instanceof Error ? error.message : error}`);
        process.chdir(originalCwd);
        process.exit(1);
      }
    }

    process.chdir(originalCwd);
    out.success(`Done. Generated ${docsWritten} documentation files in ${targetDir}`);
  }
}
