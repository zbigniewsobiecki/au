import { Command, Flags } from "@oclif/core";
import { SysMLStats, formatBytes } from "../lib/sysml-stats.js";

export default class Stats extends Command {
  static description =
    "Display statistics about SysML model coverage (deterministic, non-agentic)";

  static examples = [
    "<%= config.bin %> stats",
    "<%= config.bin %> stats --path ./my-project",
  ];

  static flags = {
    path: Flags.string({
      char: "p",
      description: "Root path to analyze",
      default: ".",
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Stats);

    const stats = new SysMLStats();
    const result = await stats.getStats(flags.path);

    if (result.fileCount === 0) {
      console.log("No SysML model found.");
      console.log("Run 'au ingest' first to generate the model.");
      return;
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

    console.log();
  }
}
