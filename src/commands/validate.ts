import { Command, Flags } from "@oclif/core";
import { AgentBuilder, LLMist } from "llmist";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  sysmlRead,
  sysmlList,
  sysmlQuery,
  sysmlWrite,
  readFiles,
  readDirs,
  ripGrep,
  finishSysmlFix,
  verifyFinding,
  finishVerify,
  resetCollectedFindings,
  getCollectedFindings,
  loadManifest,
  type VerificationFinding,
} from "../gadgets/index.js";
import { SysMLModelValidator, type SysMLValidationResult } from "../lib/sysml-model-validator.js";
import { Output } from "../lib/output.js";
import { render } from "../lib/templates.js";
import {
  prioritizeStaticIssues,
  prioritizeAgenticFindings,
  sortIssuesByPriority,
  groupByPriority,
} from "../lib/issue-priority.js";
import {
  agentFlags,
  configureBuilder,
  createTextBlockState,
  endTextBlock,
  setupIterationTracking,
  withWorkingDirectory,
} from "../lib/command-utils.js";
import { runAgentWithEvents } from "../lib/agent-runner.js";
import { extractDiffFromResult } from "../lib/diff-utils.js";

export default class Validate extends Command {
  static description =
    "Validate SysML model with static checks and optional agentic verification. Use --quick for static-only.";

  static examples = [
    "<%= config.bin %> validate",
    "<%= config.bin %> validate --quick",
    "<%= config.bin %> validate --path ./my-project",
    "<%= config.bin %> validate --verbose",
    "<%= config.bin %> validate --fix",
    "<%= config.bin %> validate --fix --model opus",
  ];

  static flags = {
    ...agentFlags,
    quick: Flags.boolean({
      char: "q",
      description: "Run static validation only (no agentic verification)",
      default: false,
    }),
    verbose: Flags.boolean({
      char: "v",
      description: "Show detailed output",
      default: false,
    }),
    fix: Flags.boolean({
      description: "Automatically fix issues using AI agent",
      default: false,
    }),
    "fix-iterations": Flags.integer({
      description: "Max iterations for fix phase",
      default: 30,
    }),
    "verify-iterations": Flags.integer({
      description: "Max iterations for verification phase",
      default: 30,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Validate);
    const out = new Output({ verbose: flags.verbose });

    const { restore } = withWorkingDirectory(flags.path, out);

    // Phase 1: Static validation (always runs)
    out.info("Phase 1: Static validation...");

    const validator = new SysMLModelValidator();
    const result = await validator.validate(".");

    // Display validation results
    this.displayResults(result, flags.verbose);

    // Calculate total issues
    const staticIssues = SysMLModelValidator.getIssueCount(result);

    // Summary of static phase
    console.log();
    if (staticIssues === 0) {
      out.success("Static validation passed");
    } else {
      out.warn(`Static: ${staticIssues} issue${staticIssues === 1 ? "" : "s"} found`);
    }

    // If --quick, exit after static checks
    if (flags.quick) {
      restore();
      if (staticIssues > 0) {
        process.exit(1);
      }
      return;
    }

    // Phase 2: Agentic verification (skip if --quick)
    out.info("\nPhase 2: Agentic verification...");
    const agenticFindings = await this.runAgenticVerification(result, flags, out);

    // Display agentic findings summary
    const errors = agenticFindings.filter((f) => f.category === "error").length;
    const warnings = agenticFindings.filter((f) => f.category === "warning").length;
    const suggestions = agenticFindings.filter((f) => f.category === "suggestion").length;

    if (agenticFindings.length === 0) {
      out.success("Agentic verification passed");
    } else {
      console.log();
      out.warn(`Agentic: ${agenticFindings.length} finding${agenticFindings.length === 1 ? "" : "s"}`);
      if (errors > 0) console.log(`  Errors: ${errors}`);
      if (warnings > 0) console.log(`  Warnings: ${warnings}`);
      if (suggestions > 0) console.log(`  Suggestions: ${suggestions}`);

      // Show findings in verbose mode
      if (flags.verbose) {
        console.log("\nFindings:");
        for (const finding of agenticFindings) {
          const prefix =
            finding.category === "error"
              ? "ERROR"
              : finding.category === "warning"
                ? "WARNING"
                : "SUGGESTION";
          const fileInfo = finding.file ? ` (${finding.file})` : "";
          console.log(`  [${prefix}] ${finding.domain}${fileInfo}: ${finding.issue}`);
          if (finding.recommendation) {
            console.log(`    Recommendation: ${finding.recommendation}`);
          }
        }
      }
    }

    const hasIssues = staticIssues > 0 || errors > 0;

    // Phase 3: Fix (if --fix and issues found)
    if (flags.fix && hasIssues) {
      out.info("\nPhase 3: Running agentic fix...");

      const fixesApplied = await this.runFixPhase(result, agenticFindings, flags, out);

      if (fixesApplied > 0) {
        out.success(`Applied ${fixesApplied} fix${fixesApplied === 1 ? "" : "es"}`);

        // Re-validate to show updated status
        out.info("\nRe-validating...");
        const newResult = await validator.validate(".");
        this.displayResults(newResult, flags.verbose);

        const newTotalIssues = SysMLModelValidator.getIssueCount(newResult);
        console.log();
        if (newTotalIssues === 0) {
          out.success("All validations passed after fixes");
        } else {
          out.warn(`${newTotalIssues} issue${newTotalIssues === 1 ? "" : "s"} remaining`);
        }
      } else {
        out.info("No fixes were applied");
      }
    }

    restore();

    // Exit with error code if there are unresolved issues
    if (!flags.fix && hasIssues) {
      process.exit(1);
    }
  }

  /**
   * Display validation results to console.
   */
  private displayResults(result: SysMLValidationResult, verbose: boolean): void {
    console.log("\n━━━ SysML Model Validation ━━━\n");

    // Manifest check
    if (result.manifestExists) {
      console.log("✓ Manifest exists");
    } else {
      console.log("✗ Manifest missing");
      if (result.manifestErrors.length > 0) {
        for (const error of result.manifestErrors) {
          console.log(`  ${error}`);
        }
      }
    }

    // Manifest errors
    if (result.manifestErrors.length > 0 && result.manifestExists) {
      console.log("⚠ Manifest issues:");
      for (const error of result.manifestErrors) {
        console.log(`  ${error}`);
      }
    }

    // Expected outputs
    const existingOutputs = result.expectedOutputs.filter((o) => o.exists).length;
    const totalOutputs = result.expectedOutputs.length;

    if (totalOutputs > 0) {
      if (existingOutputs === totalOutputs) {
        console.log(`✓ Expected outputs: ${existingOutputs}/${totalOutputs} exist`);
      } else {
        console.log(`⚠ Expected outputs: ${existingOutputs}/${totalOutputs} exist`);
        if (verbose) {
          for (const output of result.expectedOutputs) {
            if (!output.exists) {
              console.log(`  ✗ Missing: ${output.path}`);
            }
          }
        } else {
          const missing = result.expectedOutputs.filter((o) => !o.exists);
          if (missing.length <= 3) {
            for (const output of missing) {
              console.log(`  ✗ Missing: ${output.path}`);
            }
          } else {
            console.log(`  (${missing.length} missing files, use --verbose to see all)`);
          }
        }
      }
    }

    // Syntax validation
    if (result.totalFileCount > 0) {
      if (result.syntaxErrors.length === 0) {
        console.log(`✓ SysML syntax: ${result.validFileCount} files valid`);
      } else {
        const errorCount = result.syntaxErrors.length;
        console.log(`⚠ SysML syntax: ${result.validFileCount}/${result.totalFileCount} files valid (${errorCount} with errors)`);

        if (verbose) {
          for (const syntaxError of result.syntaxErrors) {
            console.log(`  ✗ ${syntaxError.file}:`);
            for (const error of syntaxError.errors.slice(0, 3)) {
              console.log(`    ${error}`);
            }
            if (syntaxError.errors.length > 3) {
              console.log(`    ... and ${syntaxError.errors.length - 3} more errors`);
            }
          }
        } else {
          const first3 = result.syntaxErrors.slice(0, 3);
          for (const syntaxError of first3) {
            console.log(`  ✗ ${syntaxError.file}: ${syntaxError.errors[0]}`);
          }
          if (result.syntaxErrors.length > 3) {
            console.log(`  ... and ${result.syntaxErrors.length - 3} more files with errors`);
          }
        }
      }
    }

    // File coverage validation
    if (result.fileCoverageMismatches.length === 0) {
      // Only show success if there were expected source files to validate
      const hasSourceFiles = result.expectedOutputs.length > 0;
      if (hasSourceFiles) {
        console.log("✓ Source file coverage: all files covered");
      }
    } else {
      console.log("⚠ Coverage mismatches:");
      for (const mismatch of result.fileCoverageMismatches) {
        console.log(
          `  ${mismatch.cycle}: ${mismatch.covered}/${mismatch.expected} files covered`
        );
        if (verbose && mismatch.uncoveredFiles.length > 0) {
          for (const file of mismatch.uncoveredFiles.slice(0, 5)) {
            console.log(`    ✗ Missing: ${file}`);
          }
          if (mismatch.uncoveredFiles.length > 5) {
            console.log(`    ... and ${mismatch.uncoveredFiles.length - 5} more`);
          }
        }
      }
    }

    // Orphaned files
    if (result.orphanedFiles.length === 0) {
      console.log("✓ No orphaned files");
    } else {
      console.log("⚠ Orphaned files:");
      for (const orphan of result.orphanedFiles.slice(0, 5)) {
        console.log(`  ${orphan}`);
      }
      if (result.orphanedFiles.length > 5) {
        console.log(`  ... and ${result.orphanedFiles.length - 5} more`);
      }
    }

    // Reference integrity
    if (result.missingReferences.length === 0) {
      console.log("✓ References: all resolved");
    } else {
      console.log(`⚠ Missing references (${result.missingReferences.length}):`);
      const displayRefs = verbose
        ? result.missingReferences
        : result.missingReferences.slice(0, 5);
      for (const ref of displayRefs) {
        console.log(`  ${ref.file}:${ref.line}: ${ref.type} '${ref.reference}'`);
        if (verbose && ref.context) {
          console.log(`    context: ${ref.context}`);
        }
      }
      if (!verbose && result.missingReferences.length > 5) {
        console.log(`  ... and ${result.missingReferences.length - 5} more (use --verbose)`);
      }
    }

    // Coverage completeness
    if (result.coverageIssues.length === 0) {
      console.log("✓ Coverage: directories and patterns valid");
    } else {
      console.log(`⚠ Coverage issues (${result.coverageIssues.length}):`);
      const displayIssues = verbose
        ? result.coverageIssues
        : result.coverageIssues.slice(0, 5);
      for (const issue of displayIssues) {
        const detail = issue.detail ? ` (${issue.detail})` : "";
        console.log(`  ${issue.cycle}: ${issue.type} ${issue.path}${detail}`);
      }
      if (!verbose && result.coverageIssues.length > 5) {
        console.log(`  ... and ${result.coverageIssues.length - 5} more (use --verbose)`);
      }
    }
  }

  /**
   * Run the agentic verification phase.
   * Returns all findings discovered by the agent.
   */
  private async runAgenticVerification(
    staticResult: SysMLValidationResult,
    flags: { model: string; rpm: number; tpm: number; "verify-iterations": number; verbose: boolean },
    out: Output
  ): Promise<VerificationFinding[]> {
    // Reset collected findings
    resetCollectedFindings();

    // Load all SysML content
    const sysmlContent = await this.loadAllSysmlContent();
    if (!sysmlContent) {
      out.warn("No SysML files found to verify");
      return [];
    }

    // Get manifest summary
    const manifestSummary = await this.getManifestSummary();

    // Format static results for context
    const staticResults = this.formatStaticResults(staticResult);

    // Render prompts
    const systemPrompt = render("sysml-verify/system", {});
    const userPrompt = render("sysml-verify/user", {
      sysmlContent,
      manifestSummary,
      staticResults,
    });

    // Build agent with gadgets
    const client = new LLMist();
    const gadgets = [
      verifyFinding,
      finishVerify,
      sysmlRead,
      sysmlQuery,
      readFiles,
    ];

    let builder = new AgentBuilder(client)
      .withModel(flags.model)
      .withSystem(systemPrompt)
      .withMaxIterations(flags["verify-iterations"])
      .withGadgetExecutionMode("sequential")
      .withGadgetOutputLimitPercent(30)
      .withGadgets(...gadgets);

    builder = configureBuilder(builder, out, flags.rpm, flags.tpm);

    const agent = builder.ask(userPrompt);

    // Track progress
    const textState = createTextBlockState();

    // Set up iteration tracking
    const tree = agent.getTree();
    setupIterationTracking(tree, {
      out,
      showCumulativeCostEvery: 5,
      onIterationChange: () => endTextBlock(textState, out),
    });

    // Run agent
    try {
      await runAgentWithEvents(agent, {
        out,
        textState,
        verbose: flags.verbose,
        onGadgetResult: (gadgetName, result) => {
          if (gadgetName === "VerifyFinding" && result && !flags.verbose) {
            // Show brief finding notification
            out.info(result);
          }
        },
      });
    } catch (error) {
      // TaskCompletionSignal is expected
      if (!(error instanceof Error && error.message.includes("SysML verification complete"))) {
        out.warn(`Verification phase stopped: ${error instanceof Error ? error.message : error}`);
      }
    }

    return getCollectedFindings();
  }

  /**
   * Load all SysML file content for agentic verification.
   */
  private async loadAllSysmlContent(): Promise<string | null> {
    const sysmlDir = ".sysml";

    try {
      await stat(sysmlDir);
    } catch {
      return null;
    }

    const files: string[] = [];

    const scanDir = async (dir: string, prefix: string = ""): Promise<void> => {
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
          const fullPath = join(dir, entry.name);

          if (entry.isDirectory() && entry.name !== ".debug") {
            await scanDir(fullPath, relativePath);
          } else if (entry.name.endsWith(".sysml") && !entry.name.startsWith("_")) {
            files.push(relativePath);
          }
        }
      } catch {
        // Directory doesn't exist or can't be read
      }
    };

    await scanDir(sysmlDir);

    if (files.length === 0) {
      return null;
    }

    // Sort files for consistent ordering
    files.sort();

    // Load content of each file
    const sections: string[] = [];
    for (const file of files) {
      try {
        const content = await readFile(join(sysmlDir, file), "utf-8");
        sections.push(`### ${file}\n\`\`\`sysml\n${content}\n\`\`\``);
      } catch {
        // Skip files that can't be read
      }
    }

    return sections.join("\n\n");
  }

  /**
   * Get a summary of the manifest for context.
   */
  private async getManifestSummary(): Promise<string> {
    const manifest = await loadManifest();

    if (!manifest) {
      return "No manifest found.";
    }

    const lines: string[] = [];
    lines.push(`Project: ${manifest.project.name} (${manifest.project.primaryLanguage})`);

    if (manifest.project.framework) {
      lines.push(`Framework: ${manifest.project.framework}`);
    }

    if (manifest.project.architectureStyle) {
      lines.push(`Architecture: ${manifest.project.architectureStyle}`);
    }

    // Summarize cycles
    const cycleKeys = Object.keys(manifest.cycles).sort();
    lines.push(`\nCycles: ${cycleKeys.length}`);
    for (const key of cycleKeys) {
      const cycle = manifest.cycles[key];
      const sourceCount = cycle.sourceFiles?.length ?? 0;
      const outputCount = cycle.expectedOutputs?.length ?? 0;
      lines.push(`  ${key} (${cycle.name}): ${sourceCount} source patterns, ${outputCount} expected outputs`);
    }

    // Summarize directories if present
    if (manifest.directories && manifest.directories.length > 0) {
      lines.push(`\nDirectory assignments: ${manifest.directories.length} directories`);
    }

    return lines.join("\n");
  }

  /**
   * Format static validation results for context.
   */
  private formatStaticResults(result: SysMLValidationResult): string {
    const lines: string[] = [];

    lines.push(`Manifest: ${result.manifestExists ? "exists" : "MISSING"}`);

    if (result.manifestErrors.length > 0) {
      lines.push(`Manifest errors: ${result.manifestErrors.length}`);
    }

    lines.push(`Files: ${result.validFileCount}/${result.totalFileCount} valid`);

    if (result.syntaxErrors.length > 0) {
      lines.push(`Syntax errors: ${result.syntaxErrors.length} files`);
    }

    if (result.missingReferences.length > 0) {
      lines.push(`Missing references: ${result.missingReferences.length}`);
    }

    if (result.orphanedFiles.length > 0) {
      lines.push(`Orphaned files: ${result.orphanedFiles.length}`);
    }

    if (result.coverageIssues.length > 0) {
      lines.push(`Coverage issues: ${result.coverageIssues.length}`);
    }

    const totalIssues = SysMLModelValidator.getIssueCount(result);
    lines.push(`\nTotal static issues: ${totalIssues}`);

    return lines.join("\n");
  }

  /**
   * Run the agentic fix phase.
   * Returns the number of fixes applied.
   */
  private async runFixPhase(
    result: SysMLValidationResult,
    agenticFindings: VerificationFinding[],
    flags: { model: string; rpm: number; tpm: number; "fix-iterations": number; verbose: boolean },
    out: Output
  ): Promise<number> {
    // Render prompts
    const systemPrompt = render("sysml-fix/system", {});

    // Prioritize and sort all issues
    const staticIssues = prioritizeStaticIssues(result);
    const agenticIssues = prioritizeAgenticFindings(
      agenticFindings.filter((f) => f.category === "error" || f.category === "warning")
    );
    const allIssues = sortIssuesByPriority([...staticIssues, ...agenticIssues]);
    const groupedIssues = groupByPriority(allIssues);

    const initialPrompt = render("sysml-fix/initial", {
      prioritizedIssues: allIssues,
      groupedIssues: groupedIssues,
      basePath: ".",
    });

    // Build agent with gadgets
    // sysmlWrite first for maxConcurrent=1 priority
    const client = new LLMist();
    const gadgets = [
      sysmlWrite,
      finishSysmlFix,
      sysmlRead,
      sysmlList,
      sysmlQuery,
      readFiles,
      readDirs,
      ripGrep,
    ];

    let builder = new AgentBuilder(client)
      .withModel(flags.model)
      .withSystem(systemPrompt)
      .withMaxIterations(flags["fix-iterations"])
      .withGadgetExecutionMode("sequential")
      .withGadgetOutputLimitPercent(30)
      .withGadgets(...gadgets);

    builder = configureBuilder(builder, out, flags.rpm, flags.tpm);

    const agent = builder.ask(initialPrompt);

    // Track progress
    const textState = createTextBlockState();
    let fixesApplied = 0;

    // Set up iteration tracking
    const tree = agent.getTree();
    setupIterationTracking(tree, {
      out,
      showCumulativeCostEvery: 5,
      onIterationChange: () => endTextBlock(textState, out),
    });

    // Run agent
    try {
      await runAgentWithEvents(agent, {
        out,
        textState,
        verbose: flags.verbose,
        onGadgetResult: (gadgetName, gadgetResult) => {
          if (gadgetName === "SysMLWrite" && gadgetResult && !gadgetResult.includes("Error")) {
            fixesApplied++;
            if (!flags.verbose) {
              // Extract path from result for brief output
              const pathMatch = gadgetResult.match(/path=([^\s]+)/);
              if (pathMatch) {
                out.info(`Fixed: ${pathMatch[1]}`);
              }
            } else {
              // In verbose mode, display the colored diff if available
              const diff = extractDiffFromResult(gadgetResult);
              if (diff) {
                const indentedDiff = diff.split("\n").map((line) => `      ${line}`).join("\n");
                console.log(indentedDiff);
              }
            }
          }
        },
      });
    } catch (error) {
      // TaskCompletionSignal is expected
      if (!(error instanceof Error && error.message.includes("SysML fix complete"))) {
        out.warn(`Fix phase stopped: ${error instanceof Error ? error.message : error}`);
      }
    }

    return fixesApplied;
  }
}
