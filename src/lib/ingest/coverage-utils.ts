/**
 * Coverage verification utilities for the ingest command.
 */

import fg from "fast-glob";

import { STANDARD_IGNORE_PATTERNS } from "./constants.js";
import { Output } from "../output.js";
import { getCyclePatterns } from "../sysml/index.js";

/**
 * Coverage verification result.
 */
export interface CoverageVerification {
  targetFiles: number;
  readFiles: number;
  percentage: number;
}

/**
 * Heuristic coverage result.
 */
export interface HeuristicCoverage {
  readFiles: number;
  estimated: string;
  potentialFiles: number;
}

/**
 * Verify cycle coverage and log results.
 */
export function verifyCycleCoverage(
  cycle: number,
  readFiles: Set<string>,
  targetFiles: string[],
  out: Output,
  threshold: number = 95
): CoverageVerification {
  const readCount = readFiles.size;
  const targetCount = targetFiles.length;
  const percentage = targetCount > 0 ? Math.round((readCount / targetCount) * 100) : 100;

  if (percentage < threshold) {
    out.warn(
      `Cycle ${cycle} coverage: ${percentage}% (${readCount}/${targetCount} files) - below ${threshold}% threshold`
    );

    // Find missing files
    const missing = targetFiles.filter((f) => !readFiles.has(f));
    if (missing.length > 0 && missing.length <= 10) {
      out.info(`Missing files: ${missing.join(", ")}`);
    } else if (missing.length > 10) {
      out.info(`Missing ${missing.length} files (first 10): ${missing.slice(0, 10).join(", ")}`);
    }
  }

  return { targetFiles: targetCount, readFiles: readCount, percentage };
}

/**
 * Heuristically verify coverage when target files aren't known upfront.
 * Discovers what files COULD have been relevant and compares with what was read.
 */
export async function verifyCoverageHeuristically(
  cycle: number,
  readFiles: Set<string>,
  language?: string
): Promise<HeuristicCoverage> {
  // Get patterns that SHOULD have been relevant for this cycle
  const patterns = getCyclePatterns(cycle, language);

  if (patterns.length === 0) {
    return {
      readFiles: readFiles.size,
      estimated: "100% (no patterns for cycle)",
      potentialFiles: 0,
    };
  }

  // Discover what files exist matching those patterns
  const potentialFiles = await fg(patterns, {
    cwd: ".",
    ignore: STANDARD_IGNORE_PATTERNS,
    onlyFiles: true,
  });

  // Normalize path by removing leading ./ to handle format mismatches
  // (fast-glob returns "src/foo.ts", but LLM may send "./src/foo.ts")
  const normalizePath = (p: string) => p.replace(/^\.\//, "");
  const normalizedReadFiles = new Set([...readFiles].map(normalizePath));

  const readFromPotential = potentialFiles.filter((f) =>
    normalizedReadFiles.has(normalizePath(f))
  ).length;
  const percentage = potentialFiles.length > 0
    ? Math.round((readFromPotential / potentialFiles.length) * 100)
    : 100;

  return {
    readFiles: readFiles.size,
    estimated: `~${percentage}% of ${potentialFiles.length} pattern-matched files`,
    potentialFiles: potentialFiles.length,
  };
}
