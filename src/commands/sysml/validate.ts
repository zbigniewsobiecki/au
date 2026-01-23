import { Command, Flags } from "@oclif/core";
import { AgentBuilder, LLMist } from "llmist";
import {
  sysmlRead,
  sysmlList,
  sysmlQuery,
  sysmlWrite,
  readFiles,
  readDirs,
  ripGrep,
  finishSysmlFix,
} from "../../gadgets/index.js";
import { SysMLModelValidator, type SysMLValidationResult } from "../../lib/sysml-model-validator.js";
import { Output } from "../../lib/output.js";
import { render } from "../../lib/templates.js";
import {
  agentFlags,
  configureBuilder,
  createTextBlockState,
  endTextBlock,
  setupIterationTracking,
  withWorkingDirectory,
} from "../../lib/command-utils.js";
import { runAgentWithEvents } from "../../lib/agent-runner.js";

export default class SysmlValidate extends Command {
  static description =
    "Validate SysML model structure and coverage. Use --fix for agentic auto-fixing.";

  static examples = [
    "<%= config.bin %> sysml validate",
    "<%= config.bin %> sysml validate --path ./my-project",
    "<%= config.bin %> sysml validate --verbose",
    "<%= config.bin %> sysml validate --fix",
    "<%= config.bin %> sysml validate --fix --model opus",
  ];

  static flags = {
    ...agentFlags,
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
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(SysmlValidate);
    const out = new Output({ verbose: flags.verbose });

    const { restore } = withWorkingDirectory(flags.path, out);

    out.info("Validating SysML model...");

    const validator = new SysMLModelValidator();
    const result = await validator.validate(".");

    // Display validation results
    this.displayResults(result, flags.verbose);

    // Calculate total issues
    const totalIssues = SysMLModelValidator.getIssueCount(result);

    // Summary before fix phase
    console.log();
    if (totalIssues === 0) {
      out.success("All validations passed");
      restore();
      return;
    }

    out.warn(`Summary: ${totalIssues} issue${totalIssues === 1 ? "" : "s"} found`);

    // Phase 2: Agentic fix (if --fix flag is set)
    if (flags.fix) {
      out.info("\nPhase 2: Running agentic fix...");

      const fixesApplied = await this.runFixPhase(result, flags, out);

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

    // Exit with error code if there are still issues (and not in fix mode, or fix didn't resolve all)
    if (!flags.fix && totalIssues > 0) {
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
   * Run the agentic fix phase.
   * Returns the number of fixes applied.
   */
  private async runFixPhase(
    result: SysMLValidationResult,
    flags: { model: string; rpm: number; tpm: number; "fix-iterations": number; verbose: boolean },
    out: Output
  ): Promise<number> {
    // Render prompts
    const systemPrompt = render("sysml-fix/system", {});
    const initialPrompt = render("sysml-fix/initial", {
      result,
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
        onGadgetResult: (gadgetName, result) => {
          if (gadgetName === "SysMLWrite" && result && !result.includes("Error")) {
            fixesApplied++;
            if (!flags.verbose) {
              // Extract path from result for brief output
              const pathMatch = result.match(/path=([^\s]+)/);
              if (pathMatch) {
                out.info(`Fixed: ${pathMatch[1]}`);
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
