import { Command, Flags } from "@oclif/core";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { findAuFiles, getSourceFromAuPath } from "../lib/au-paths.js";
import { ProgressTracker } from "../lib/progress-tracker.js";

export default class Stats extends Command {
  static description =
    "Display statistics about agent understanding coverage (deterministic, non-agentic)";

  static examples = [
    "<%= config.bin %> stats",
    "<%= config.bin %> stats --path ./src",
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

    // Get coverage stats
    const progressTracker = new ProgressTracker();
    await progressTracker.scanSourceFiles(flags.path);
    await progressTracker.scanExistingAuFiles(flags.path);
    const counts = progressTracker.getCounts();

    const auFiles = await findAuFiles(flags.path, true);

    if (auFiles.length === 0) {
      console.log("No .au files found.");
      console.log(`\nSource files: ${counts.total}`);
      console.log("Coverage: 0%");
      return;
    }

    let totalAuSize = 0;
    let totalSourceSize = 0;
    let filesWithSource = 0;
    const auSizes: number[] = [];
    const ratios: number[] = [];

    for (const auFile of auFiles) {
      const fullAuPath = join(flags.path, auFile);
      const sourcePath = getSourceFromAuPath(auFile);
      const fullSourcePath = join(flags.path, sourcePath);

      try {
        const auStat = await stat(fullAuPath);
        const auSize = auStat.size;
        auSizes.push(auSize);
        totalAuSize += auSize;

        // Try to get source file size
        try {
          const sourceStat = await stat(fullSourcePath);
          const sourceSize = sourceStat.size;
          if (sourceSize > 0) {
            totalSourceSize += sourceSize;
            ratios.push(auSize / sourceSize);
            filesWithSource++;
          }
        } catch {
          // Source file doesn't exist (directory .au or deleted file)
        }
      } catch {
        // Can't stat .au file
      }
    }

    const avgAuSize = totalAuSize / auFiles.length;
    const medianRatio = ratios.length > 0
      ? median(ratios)
      : 0;

    console.log("\n━━━ Understanding Stats ━━━\n");

    // Coverage
    console.log(`Source files:       ${counts.total}`);
    console.log(`Documented:         ${counts.documented}`);
    console.log(`Coverage:           ${progressTracker.getProgressPercent()}%`);

    // Size stats
    console.log(`\nAU files:           ${auFiles.length}`);
    console.log(`Total AU size:      ${formatBytes(totalAuSize)}`);
    console.log(`Average AU size:    ${formatBytes(avgAuSize)}`);

    if (filesWithSource > 0) {
      console.log(`\nTotal source size:  ${formatBytes(totalSourceSize)}`);
      console.log(`Compression:        ${(medianRatio * 100).toFixed(0)}% of source size (median)`);
    }

    console.log();
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}
