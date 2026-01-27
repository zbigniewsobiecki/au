import { Command, Flags } from "@oclif/core";
import { AgentBuilder, LLMist } from "llmist";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  sysmlRead,
  sysmlList,
  sysmlQuery,
  sysmlWrite,
  sysmlCreate,
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
import {
  SysMLCoverageValidator,
  type CoverageValidationResult,
} from "../lib/sysml-model-validator.js";
import {
  validateModelFull,
  parseMultiFileDiagnosticOutput,
  type Sysml2MultiDiagnostic,
} from "../lib/sysml/sysml2-cli.js";
import { Output } from "../lib/output.js";
import { render } from "../lib/templates.js";
import {
  prioritizeSysml2Diagnostics,
  prioritizeAgenticFindings,
  sortIssuesByPriority,
  groupByPriority,
  type PrioritizedIssue,
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
      default: 50,
    }),
    "coverage-threshold": Flags.integer({
      description: "Minimum coverage % for fix phase to complete (default: 80)",
      default: 80,
      min: 0,
      max: 100,
    }),
    "fix-batch-size": Flags.integer({
      description: "Suggested files to cover per turn (default: 10)",
      default: 10,
      min: 1,
      max: 50,
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

    // Phase 1: sysml2 validation
    out.info("Phase 1: sysml2 validation...");

    // Basic existence check
    if (!(await this.fileExists(".sysml"))) {
      out.error("No .sysml directory found");
      restore();
      process.exit(1);
    }

    // Run sysml2 directly
    const validation = await validateModelFull(".sysml");
    const diagnostics = parseMultiFileDiagnosticOutput(validation.output || "");

    // Display sysml2 results
    this.displaySysml2Results(validation.exitCode, validation.output, diagnostics, flags.verbose);

    const hasErrors = validation.exitCode !== 0;
    const hasWarnings = diagnostics.some(d => d.severity === "warning");

    // Run coverage validation
    const coverageValidator = new SysMLCoverageValidator();
    const coverageResult = await coverageValidator.validate(".");

    // Display coverage results
    this.displayCoverageResults(coverageResult, flags.verbose);

    const coverageIssues = SysMLCoverageValidator.getIssueCount(coverageResult);

    // Summary of static phase
    console.log();
    const totalStaticIssues = diagnostics.filter(d => d.severity === "error").length + coverageIssues;
    if (totalStaticIssues === 0 && !hasWarnings) {
      out.success("Static validation passed");
    } else {
      if (hasErrors) {
        out.warn(`sysml2: ${diagnostics.filter(d => d.severity === "error").length} error(s)`);
      }
      if (hasWarnings) {
        out.info(`sysml2: ${diagnostics.filter(d => d.severity === "warning").length} warning(s)`);
      }
      if (coverageIssues > 0) {
        out.warn(`Coverage: ${coverageIssues} issue(s)`);
      }
    }

    // If --quick, exit after static checks
    if (flags.quick) {
      restore();
      if (hasErrors || coverageIssues > 0) {
        process.exit(1);
      }
      return;
    }

    // Phase 2: Agentic verification (skip if --quick)
    out.info("\nPhase 2: Agentic verification...");
    const agenticFindings = await this.runAgenticVerification(
      validation.exitCode,
      validation.output || "",
      diagnostics,
      flags,
      out
    );

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

    const hasIssues = hasErrors || coverageIssues > 0 || errors > 0;

    // Phase 3: Fix (if --fix and issues found)
    if (flags.fix && hasIssues) {
      out.info("\nPhase 3: Running agentic fix...");

      const fixesApplied = await this.runFixPhase(
        validation.exitCode,
        diagnostics,
        coverageResult,
        agenticFindings,
        coverageValidator,
        flags,
        out
      );

      if (fixesApplied > 0) {
        out.success(`Applied ${fixesApplied} fix${fixesApplied === 1 ? "" : "es"}`);

        // Re-validate to show updated status
        out.info("\nRe-validating...");
        const newValidation = await validateModelFull(".sysml");
        const newDiagnostics = parseMultiFileDiagnosticOutput(newValidation.output || "");
        this.displaySysml2Results(newValidation.exitCode, newValidation.output, newDiagnostics, flags.verbose);

        const newCoverageResult = await coverageValidator.validate(".");
        this.displayCoverageResults(newCoverageResult, flags.verbose);

        const newErrorCount = newDiagnostics.filter(d => d.severity === "error").length;
        const newCoverageIssues = SysMLCoverageValidator.getActionableIssueCount(newCoverageResult);
        const totalRemaining = newErrorCount + newCoverageIssues;
        console.log();
        if (totalRemaining === 0) {
          out.success("All validations passed after fixes");
        } else {
          out.warn(`${totalRemaining} issue${totalRemaining === 1 ? "" : "s"} remaining`);
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
   * Check if a file/directory exists.
   */
  private async fileExists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Display sysml2 validation results.
   */
  private displaySysml2Results(
    exitCode: number,
    output: string | undefined,
    diagnostics: Sysml2MultiDiagnostic[],
    verbose: boolean
  ): void {
    console.log("\n━━━ sysml2 Validation ━━━\n");

    if (exitCode === 0) {
      const warningCount = diagnostics.filter(d => d.severity === "warning").length;
      if (warningCount === 0) {
        console.log("✓ No errors or warnings");
      } else {
        console.log(`✓ No errors, ${warningCount} warning(s)`);
      }
    } else {
      const errorType = exitCode === 1 ? "Syntax" : "Semantic";
      const errorCount = diagnostics.filter(d => d.severity === "error").length;
      console.log(`✗ ${errorType} errors: ${errorCount}`);
    }

    // Show diagnostics
    if (diagnostics.length > 0) {
      const displayDiags = verbose ? diagnostics : diagnostics.slice(0, 10);
      for (const diag of displayDiags) {
        const icon = diag.severity === "error" ? "✗" : "⚠";
        const codeInfo = diag.code ? `[${diag.code}] ` : "";
        console.log(`  ${icon} ${diag.file}:${diag.line}:${diag.column}: ${codeInfo}${diag.message}`);
      }
      if (!verbose && diagnostics.length > 10) {
        console.log(`  ... and ${diagnostics.length - 10} more (use --verbose)`);
      }
    }
  }

  /**
   * Display coverage validation results.
   */
  private displayCoverageResults(result: CoverageValidationResult, verbose: boolean): void {
    console.log("\n━━━ Coverage Validation ━━━\n");

    // File coverage validation
    if (result.fileCoverageMismatches.length === 0) {
      console.log("✓ Source file coverage: all files covered");
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
    sysml2ExitCode: number,
    sysml2Output: string,
    diagnostics: Sysml2MultiDiagnostic[],
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

    // Format sysml2 status
    const sysml2HasWarnings = diagnostics.some(d => d.severity === "warning");

    // Render prompts
    const systemPrompt = render("sysml-verify/system", {});
    const userPrompt = render("sysml-verify/user", {
      sysmlContent,
      manifestSummary,
      sysml2ExitCode,
      sysml2Output: sysml2Output.trim(),
      sysml2HasWarnings,
    });

    // Build agent with gadgets
    const client = new LLMist();
    const gadgets = [
      verifyFinding,
      finishVerify,
      sysmlRead,
      sysmlQuery,
      readFiles,
      readDirs,
      ripGrep,
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

          if (entry.isDirectory()) {
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
   * Convert coverage validation results to prioritized issues.
   */
  private prioritizeCoverageIssues(result: CoverageValidationResult): PrioritizedIssue[] {
    const issues: PrioritizedIssue[] = [];

    // P4 - MEDIUM: File coverage mismatches (now actionable - add @SourceFile metadata)
    // Create batched issues (groups of 10 files) to avoid overwhelming the agent
    for (const mismatch of result.fileCoverageMismatches) {
      const batches: string[][] = [];
      for (let i = 0; i < mismatch.uncoveredFiles.length; i += 10) {
        batches.push(mismatch.uncoveredFiles.slice(i, i + 10));
      }

      for (const batch of batches) {
        issues.push({
          priority: 4,
          priorityLabel: "MEDIUM",
          category: "coverage-mismatch",
          description: `${mismatch.cycle}: Add @SourceFile coverage for: ${batch.slice(0, 3).join(", ")}${batch.length > 3 ? ` (+${batch.length - 3} more)` : ""}`,
          recommendation: `Read these source files and add @SourceFile metadata to appropriate SysML definitions`,
          actionable: true,
          uncoveredFiles: batch,
        });
      }
    }

    // P5 - LOW: Coverage issues (actionable - can be fixed by updating manifest/model)
    for (const issue of result.coverageIssues) {
      issues.push({
        priority: 5,
        priorityLabel: "LOW",
        category: `coverage-${issue.type}`,
        description: `${issue.cycle}: ${issue.type} - ${issue.path}`,
        recommendation: issue.detail,
        actionable: true,
      });
    }

    return issues;
  }

  /**
   * Run the agentic fix phase.
   * Returns the number of fixes applied.
   */
  private async runFixPhase(
    sysml2ExitCode: number,
    diagnostics: Sysml2MultiDiagnostic[],
    coverageResult: CoverageValidationResult,
    agenticFindings: VerificationFinding[],
    coverageValidator: SysMLCoverageValidator,
    flags: { model: string; rpm: number; tpm: number; "fix-iterations": number; "coverage-threshold": number; "fix-batch-size": number; verbose: boolean },
    out: Output
  ): Promise<number> {
    // Render prompts
    const systemPrompt = render("sysml-fix/system", {});

    // Prioritize and sort all issues
    const sysml2Issues = prioritizeSysml2Diagnostics(sysml2ExitCode, diagnostics);
    const coverageIssues = this.prioritizeCoverageIssues(coverageResult);
    const agenticIssues = prioritizeAgenticFindings(
      agenticFindings.filter((f) => f.category === "error" || f.category === "warning")
    );
    const allIssues = sortIssuesByPriority([...sysml2Issues, ...coverageIssues, ...agenticIssues]);

    // Separate actionable from non-actionable issues
    // Only pass actionable issues to the fix agent
    const actionableIssues = allIssues.filter(issue => issue.actionable !== false);
    const nonActionableIssues = allIssues.filter(issue => issue.actionable === false);
    const groupedIssues = groupByPriority(actionableIssues);

    const initialPrompt = render("sysml-fix/initial", {
      prioritizedIssues: actionableIssues,
      groupedIssues: groupedIssues,
      nonActionableIssues: nonActionableIssues,
      basePath: ".",
    });

    // Build agent with gadgets
    // sysmlWrite first for maxConcurrent=1 priority
    const client = new LLMist();
    const gadgets = [
      sysmlWrite,
      sysmlCreate,
      finishSysmlFix,
      sysmlRead,
      sysmlList,
      sysmlQuery,
      readFiles,
      readDirs,
      ripGrep,
    ];

    // Track state for trailing message
    let currentIteration = 0;
    let validationExitCode = 0;
    let validationOutput = "";

    // Initialize coverage stats from initial coverageResult
    const initialUncovered: string[] = [];
    let initialTotal = 0;
    let initialCovered = 0;
    for (const mismatch of coverageResult.fileCoverageMismatches) {
      initialTotal += mismatch.expected;
      initialCovered += mismatch.covered;
      initialUncovered.push(...mismatch.uncoveredFiles);
    }
    let coverageStats = {
      covered: initialCovered,
      total: initialTotal,
      percent: initialTotal > 0 ? Math.round((initialCovered / initialTotal) * 100) : 100,
      uncoveredFiles: initialUncovered.slice(0, 20),
    };

    let builder = new AgentBuilder(client)
      .withModel(flags.model)
      .withSystem(systemPrompt)
      .withMaxIterations(flags["fix-iterations"])
      .withGadgetExecutionMode("sequential")
      .withGadgetOutputLimitPercent(30)
      .withGadgets(...gadgets);

    builder = configureBuilder(builder, out, flags.rpm, flags.tpm);

    // Add trailing message with validation AND coverage feedback
    builder = builder.withTrailingMessage(() => {
      return render("sysml-fix/trailing", {
        iteration: currentIteration,
        maxIterations: flags["fix-iterations"],
        fixesApplied,
        // Coverage stats (dynamic - updated in onGadgetResult)
        coveragePercent: coverageStats.percent,
        coveredFiles: coverageStats.covered,
        totalFiles: coverageStats.total,
        uncoveredFiles: coverageStats.uncoveredFiles,
        coverageThreshold: flags["coverage-threshold"],
        batchSize: flags["fix-batch-size"],
        // Validation
        validationExitCode,
        validationOutput,
      });
    });

    const agent = builder.ask(initialPrompt);

    // Track progress
    const textState = createTextBlockState();
    let fixesApplied = 0;

    // Set up iteration tracking
    const tree = agent.getTree();
    setupIterationTracking(tree, {
      out,
      showCumulativeCostEvery: 5,
      onIterationChange: (iteration) => {
        currentIteration = iteration;
        endTextBlock(textState, out);
      },
    });

    // Run agent
    try {
      await runAgentWithEvents(agent, {
        out,
        textState,
        verbose: flags.verbose,
        onGadgetResult: async (gadgetName, gadgetResult) => {
          if (gadgetName === "SysMLWrite" && gadgetResult && !gadgetResult.includes("Error")) {
            fixesApplied++;
            // Re-run validation for trailing message feedback
            try {
              const validation = await validateModelFull(".sysml");
              validationExitCode = validation.exitCode;
              validationOutput = validation.output || "";
            } catch {
              // sysml2 not available, skip validation update
            }
            // Re-validate coverage dynamically for trailing message
            try {
              const result = await coverageValidator.validate(".");
              let total = 0;
              let covered = 0;
              const uncovered: string[] = [];
              for (const mismatch of result.fileCoverageMismatches) {
                total += mismatch.expected;
                covered += mismatch.covered;
                uncovered.push(...mismatch.uncoveredFiles);
              }
              coverageStats = {
                covered,
                total,
                percent: total > 0 ? Math.round((covered / total) * 100) : 100,
                uncoveredFiles: uncovered.slice(0, 20), // Show first 20
              };
            } catch {
              // Ignore coverage validation errors
            }
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

    // Display current validation errors
    try {
      const validation = await validateModelFull(".sysml");
      if (validation.exitCode !== 0 && validation.output) {
        const errorType = validation.exitCode === 1 ? "Syntax" : "Semantic";
        out.warn(`${errorType} validation errors (exit code ${validation.exitCode})`);
      }
    } catch {
      // sysml2 not available
    }

    return fixesApplied;
  }
}
