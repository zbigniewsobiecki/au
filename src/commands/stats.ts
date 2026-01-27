import { Command, Flags } from "@oclif/core";
import { SysMLStats, formatBytes } from "../lib/sysml-stats.js";

export default class Stats extends Command {
  static description =
    "Display statistics about SysML model including sysml2 validation, coverage, and broken references (deterministic, non-agentic)";

  static examples = [
    "<%= config.bin %> stats",
    "<%= config.bin %> stats --path ./my-project",
    "<%= config.bin %> stats --check",
    "<%= config.bin %> stats -v",
  ];

  static flags = {
    path: Flags.string({
      char: "p",
      description: "Root path to analyze",
      default: ".",
    }),
    verbose: Flags.boolean({
      char: "v",
      description: "Show detailed lists of broken references and uncovered files",
      default: false,
    }),
    check: Flags.boolean({
      description: "Exit with code 1 if sysml2 errors or broken references (for CI)",
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Stats);

    const stats = new SysMLStats();
    const result = await stats.getStats(flags.path);

    if (result.fileCount === 0) {
      console.log("No SysML model found.");
      console.log("Run 'au ingest' first to generate the model.");
      if (flags.check) {
        process.exit(1);
      }
      return;
    }

    // Track issues for --check flag
    let hasErrors = false;
    let hasBrokenRefs = false;

    // sysml2 Validation section
    console.log("\n━━━ sysml2 Validation ━━━\n");

    if (result.sysml2Validation) {
      const v = result.sysml2Validation;
      if (v.exitCode === 0 && v.warningCount === 0) {
        console.log("✓ No errors or warnings");
      } else if (v.exitCode === 0) {
        console.log(`✓ No errors, ${v.warningCount} warning(s)`);
      } else {
        hasErrors = true;
        const errorType = v.exitCode === 1 ? "Syntax" : "Semantic";
        console.log(`✗ ${errorType} errors: ${v.errorCount}`);
      }

      // Show diagnostics
      if (v.diagnostics.length > 0) {
        const displayDiags = flags.verbose ? v.diagnostics : v.diagnostics.slice(0, 10);
        for (const diag of displayDiags) {
          const icon = diag.severity === "error" ? "✗" : "⚠";
          const codeInfo = diag.code ? `[${diag.code}] ` : "";
          console.log(`  ${icon} ${diag.file}:${diag.line}:${diag.column}: ${codeInfo}${diag.message}`);
        }
        if (!flags.verbose && v.diagnostics.length > 10) {
          console.log(`  ... and ${v.diagnostics.length - 10} more (use --verbose)`);
        }
      }
    } else {
      console.log("⚠ sysml2 not available");
    }

    console.log("\n━━━ SysML Model Stats ━━━\n");

    // Model files
    console.log(`Model files:         ${result.fileCount} .sysml files`);
    console.log(`Total model size:    ${formatBytes(result.totalBytes)}`);
    console.log(`Average file size:   ${formatBytes(result.averageBytes)}`);

    // Project info
    if (result.project) {
      console.log();
      const framework = result.project.framework ? `, ${result.project.framework}` : "";
      console.log(`Project: ${result.project.name} (${result.project.primaryLanguage}${framework})`);
      if (result.project.architectureStyle) {
        console.log(`Architecture: ${result.project.architectureStyle}`);
      }
    }

    // Directory assignments
    if (result.directoryCount > 0) {
      console.log(`Directories: ${result.directoryCount} assigned`);
    }

    // Coverage by cycle
    const cycleKeys = Object.keys(result.cycleCounts).sort((a, b) => {
      const numA = parseInt(a.replace("cycle", ""), 10) || 0;
      const numB = parseInt(b.replace("cycle", ""), 10) || 0;
      return numA - numB;
    });

    if (cycleKeys.length > 0) {
      console.log("\nCoverage by Cycle:");
      for (const key of cycleKeys) {
        const cycle = result.cycleCounts[key];
        const cycleNum = key.replace("cycle", "");

        // Format sourceFiles if present
        let sourceFilesStr = "";
        if (cycle.sourceFiles && cycle.sourceFiles.length > 0) {
          sourceFilesStr = ` (${cycle.sourceFiles.length} patterns)`;
        }

        const outputsStr = cycle.expectedOutputs > 0
          ? ` → ${cycle.expectedOutputs} output${cycle.expectedOutputs === 1 ? "" : "s"}`
          : "";

        console.log(`  cycle${cycleNum} ${cycle.name}:${sourceFilesStr}${outputsStr}`);
      }
    }

    // Source coverage
    if (result.sourceCoverage.filesCovered > 0) {
      console.log();
      console.log(`Source files covered: ${result.sourceCoverage.filesCovered}`);
    }

    // Coverage stats section
    if (result.coverageStats) {
      const cs = result.coverageStats;
      console.log("\nSource File Coverage:");
      console.log(`  Referenced in model:  ${cs.referencedFiles} files`);

      if (cs.brokenReferences > 0) {
        hasBrokenRefs = true;
      }
      const brokenIcon = cs.brokenReferences > 0 ? "✗" : "✓";
      console.log(`  ${brokenIcon} Broken references:    ${cs.brokenReferences}`);

      // Show broken paths in verbose mode
      if (flags.verbose && cs.brokenPaths.length > 0) {
        for (const path of cs.brokenPaths) {
          console.log(`    - ${path}`);
        }
      }

      // Per-cycle coverage
      const cycleKeys = Object.keys(cs.cycleCoverage).sort((a, b) => {
        const numA = parseInt(a.replace("cycle", ""), 10) || 0;
        const numB = parseInt(b.replace("cycle", ""), 10) || 0;
        return numA - numB;
      });

      if (cycleKeys.length > 0) {
        console.log();
        for (const key of cycleKeys) {
          const cycle = cs.cycleCoverage[key];
          const cycleName = result.cycleCounts[key]?.name || key;
          const cycleNum = key.replace("cycle", "");
          const coverageWarning = cycle.percent < 50 ? "  ⚠" : "";
          console.log(
            `  cycle${cycleNum} ${cycleName}:`.padEnd(24) +
              `${cycle.covered}/${cycle.expected} (${cycle.percent}%)${coverageWarning}`
          );

          // Show uncovered files in verbose mode
          if (flags.verbose && cycle.uncoveredFiles.length > 0) {
            for (const file of cycle.uncoveredFiles) {
              console.log(`    - ${file}`);
            }
          }
        }
      }
    }

    console.log();

    // Exit with error code for CI if --check flag and issues found
    if (flags.check && (hasErrors || hasBrokenRefs)) {
      process.exit(1);
    }
  }
}
