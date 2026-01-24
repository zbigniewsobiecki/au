/**
 * Coverage Checker for SysML Ingest
 *
 * Validates that source files have been documented in SysML by checking
 * for `// Source: <filepath>` comments in .sysml files.
 *
 * Also provides manifest coverage checking to ensure the manifest patterns
 * cover all source files in the repository.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import fg from "fast-glob";
import { loadManifest, type Manifest } from "../../gadgets/manifest-write.js";

const SYSML_DIR = ".sysml";

/**
 * Mapping from cycle number to output directory.
 * Each cycle writes to a specific subdirectory within .sysml.
 */
const CYCLE_OUTPUT_DIRS: Record<number, string> = {
  1: "context",
  2: "structure",
  3: "data",
  4: "behavior",
  5: "verification",
  6: "analysis",
};

/**
 * Result of checking coverage for a cycle.
 */
export interface CoverageResult {
  /** All files that should be covered based on manifest sourceFiles patterns */
  expectedFiles: string[];
  /** Files that have `// Source:` comments in .sysml files */
  coveredFiles: string[];
  /** Files that are expected but not covered */
  missingFiles: string[];
  /** Coverage percentage (0-100) */
  coveragePercent: number;
}

/**
 * Context passed to gadget for coverage validation.
 */
export interface CoverageContext {
  cycle: number;
  basePath: string;
  /** Minimum coverage percentage required (default: 80) */
  minCoveragePercent?: number;
}

/**
 * Scan all .sysml files and extract paths from `@SourceFile` metadata.
 * This metadata indicates which source files have been documented.
 */
export async function findCoveredFiles(sysmlDir: string = SYSML_DIR): Promise<Set<string>> {
  const coveredFiles = new Set<string>();

  // Pattern to match `@SourceFile { :>> path = "<filepath>"; }` metadata
  // Supports various formats:
  // - `@SourceFile { :>> path = "src/controllers/user.ts"; }`
  // - `@SourceFile { :>> path = "src/controllers/user.controller.ts"; :>> line = 42; }`
  // - Also supports legacy syntax without :>> for backward compatibility
  // - Multiple sources on separate lines
  const metadataPattern = /@SourceFile\s*\{\s*(?::>>\s*)?path\s*=\s*"([^"]+)"/g;

  async function scanDir(dir: string): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dir, entry.name);

        if (entry.isDirectory()) {
          await scanDir(fullPath);
        } else if (entry.name.endsWith(".sysml")) {
          try {
            const content = await readFile(fullPath, "utf-8");

            // Find all `@SourceFile` metadata
            let match;
            while ((match = metadataPattern.exec(content)) !== null) {
              const sourcePath = match[1].trim();
              if (sourcePath) {
                coveredFiles.add(sourcePath);
              }
            }
            // Reset regex lastIndex for next file
            metadataPattern.lastIndex = 0;
          } catch {
            // Skip unreadable files
          }
        }
      }
    } catch {
      // Directory doesn't exist
    }
  }

  await scanDir(sysmlDir);
  return coveredFiles;
}

/**
 * Expand glob patterns from manifest sourceFiles to actual file paths.
 */
async function expandSourcePatterns(patterns: string[]): Promise<string[]> {
  const ignorePatterns = [
    "**/node_modules/**",
    "**/vendor/**",
    "**/target/**",
    "**/dist/**",
    "**/build/**",
    "**/.git/**",
    "**/.sysml/**",
  ];

  const allFiles: string[] = [];

  for (const pattern of patterns) {
    if (pattern.includes("*") || pattern.includes("?") || pattern.includes("{")) {
      // Glob pattern
      const matched = await fg(pattern, {
        cwd: ".",
        ignore: ignorePatterns,
        onlyFiles: true,
      });
      allFiles.push(...matched);
    } else {
      // Literal file path
      try {
        await readFile(pattern, "utf-8");
        allFiles.push(pattern);
      } catch {
        // File doesn't exist, skip
      }
    }
  }

  // Deduplicate and sort
  return [...new Set(allFiles)].sort();
}

/**
 * Find cycle data in manifest (handles both "cycle1" and "1" key formats).
 */
function findManifestCycle(
  manifest: { cycles: Record<string, { sourceFiles?: string[] }> },
  cycle: number
): { sourceFiles?: string[] } | null {
  const prefixedKey = `cycle${cycle}`;
  if (manifest.cycles[prefixedKey]) {
    return manifest.cycles[prefixedKey];
  }
  const numericKey = String(cycle);
  if (manifest.cycles[numericKey]) {
    return manifest.cycles[numericKey];
  }
  return null;
}

/**
 * Check coverage for a specific cycle.
 *
 * @param cycle - The cycle number (1-6)
 * @param basePath - Base path of the project (default: ".")
 * @returns Coverage result with expected, covered, and missing files
 */
export async function checkCycleCoverage(
  cycle: number,
  basePath: string = "."
): Promise<CoverageResult> {
  const result: CoverageResult = {
    expectedFiles: [],
    coveredFiles: [],
    missingFiles: [],
    coveragePercent: 100,
  };

  // Load manifest to get sourceFiles patterns
  const manifest = await loadManifest();
  if (!manifest) {
    return result; // No manifest = no expectations = 100% coverage
  }

  const cycleData = findManifestCycle(manifest, cycle);
  if (!cycleData?.sourceFiles || cycleData.sourceFiles.length === 0) {
    return result; // No sourceFiles defined = 100% coverage
  }

  // Expand patterns to actual files
  const expectedFiles = await expandSourcePatterns(cycleData.sourceFiles);
  result.expectedFiles = expectedFiles;

  if (expectedFiles.length === 0) {
    return result; // No files match patterns = 100% coverage
  }

  // Find covered files from .sysml Source: comments
  // IMPORTANT: Only scan the cycle's specific output directory, not the entire .sysml dir.
  // This prevents files documented in earlier cycles (e.g., structure/) from being
  // counted as "covered" for later cycles (e.g., behavior/).
  const cycleOutputDir = CYCLE_OUTPUT_DIRS[cycle];
  const sysmlDir = cycleOutputDir
    ? join(basePath, SYSML_DIR, cycleOutputDir)
    : join(basePath, SYSML_DIR); // Fallback for unknown cycles
  const coveredSet = await findCoveredFiles(sysmlDir);
  result.coveredFiles = [...coveredSet].sort();

  // Calculate missing files
  result.missingFiles = expectedFiles.filter(f => !coveredSet.has(f));

  // Calculate coverage percentage
  result.coveragePercent = expectedFiles.length > 0
    ? Math.round(((expectedFiles.length - result.missingFiles.length) / expectedFiles.length) * 100)
    : 100;

  return result;
}

/**
 * Format coverage result for display in error messages.
 */
export function formatCoverageResult(result: CoverageResult): string {
  const lines: string[] = [];

  lines.push(`Coverage: ${result.coveragePercent}%`);
  lines.push(`Expected: ${result.expectedFiles.length} files`);
  lines.push(`Covered: ${result.coveredFiles.length} files`);
  lines.push(`Missing: ${result.missingFiles.length} files`);

  if (result.missingFiles.length > 0) {
    lines.push("");
    lines.push("Missing files:");
    const displayCount = Math.min(result.missingFiles.length, 20);
    for (let i = 0; i < displayCount; i++) {
      lines.push(`  - ${result.missingFiles[i]}`);
    }
    if (result.missingFiles.length > 20) {
      lines.push(`  ... and ${result.missingFiles.length - 20} more`);
    }
  }

  return lines.join("\n");
}

// ============================================================================
// Manifest Coverage Checking
// ============================================================================

/**
 * Default patterns for discovering source files in a repository.
 */
const SOURCE_FILE_PATTERNS = [
  "**/*.ts",
  "**/*.tsx",
  "**/*.js",
  "**/*.jsx",
  "**/*.json",
];

/**
 * Default patterns to ignore when discovering source files.
 */
const DEFAULT_IGNORE_PATTERNS = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/.git/**",
  "**/.sysml/**",
  "**/pnpm-lock.yaml",
  "**/package-lock.json",
  "**/yarn.lock",
  "**/*.d.ts",
  "**/scripts/**",
  "**/migrations/**",
  "**/__mocks__/**",
  "**/__fixtures__/**",
  "**/fixtures/**",
  "**/.next/**",
  "**/.nuxt/**",
  "**/.output/**",
  "**/vendor/**",
  "**/target/**",
];

/**
 * Result of checking manifest coverage against all repository source files.
 */
export interface ManifestCoverageResult {
  /** All source files discovered in the repository */
  discoveredFiles: string[];
  /** Files that are covered by manifest sourceFiles patterns */
  coveredByPatterns: string[];
  /** Files that are NOT covered by any manifest pattern */
  notCoveredFiles: string[];
  /** Coverage percentage (0-100) */
  coveragePercent: number;
}

/**
 * Discover all source files in the repository.
 * Excludes node_modules, dist, coverage, .git, etc.
 *
 * @param basePath - Base path to search (default: ".")
 * @param customIgnore - Additional patterns to ignore
 * @returns Array of relative file paths
 */
export async function discoverAllSourceFiles(
  basePath: string = ".",
  customIgnore: string[] = []
): Promise<string[]> {
  const ignorePatterns = [...DEFAULT_IGNORE_PATTERNS, ...customIgnore];

  const files = await fg(SOURCE_FILE_PATTERNS, {
    cwd: basePath,
    ignore: ignorePatterns,
    onlyFiles: true,
    dot: false,
  });

  return files.sort();
}

/**
 * Expand all sourceFiles patterns from all cycles in the manifest.
 *
 * @param manifest - The manifest to expand patterns from
 * @param basePath - Base path for pattern matching
 * @returns Set of all files covered by manifest patterns
 */
async function expandAllManifestPatterns(
  manifest: Manifest,
  basePath: string = "."
): Promise<Set<string>> {
  const coveredFiles = new Set<string>();
  const ignorePatterns = [
    "**/node_modules/**",
    "**/vendor/**",
    "**/target/**",
    "**/dist/**",
    "**/build/**",
    "**/.git/**",
    "**/.sysml/**",
  ];

  // Collect all sourceFiles patterns from all cycles
  for (const cycleKey of Object.keys(manifest.cycles)) {
    const cycle = manifest.cycles[cycleKey];
    const patterns = cycle.sourceFiles || [];

    for (const pattern of patterns) {
      if (pattern.includes("*") || pattern.includes("?") || pattern.includes("{")) {
        // Glob pattern
        const matched = await fg(pattern, {
          cwd: basePath,
          ignore: ignorePatterns,
          onlyFiles: true,
        });
        for (const f of matched) {
          coveredFiles.add(f);
        }
      } else {
        // Literal file path - check if it exists
        try {
          await readFile(join(basePath, pattern), "utf-8");
          coveredFiles.add(pattern);
        } catch {
          // File doesn't exist, skip
        }
      }
    }
  }

  return coveredFiles;
}

/**
 * Check if manifest patterns cover all discovered source files.
 *
 * @param manifest - The manifest to check
 * @param basePath - Base path of the project (default: ".")
 * @returns Coverage result with discovered, covered, and uncovered files
 */
export async function checkManifestCoverage(
  manifest: Manifest,
  basePath: string = "."
): Promise<ManifestCoverageResult> {
  // 1. Discover all source files in the repository
  const discoveredFiles = await discoverAllSourceFiles(basePath);

  // 2. Expand all sourceFiles patterns from all cycles
  const coveredSet = await expandAllManifestPatterns(manifest, basePath);
  const coveredByPatterns = [...coveredSet].sort();

  // 3. Calculate which files are not covered
  const notCoveredFiles = discoveredFiles.filter(f => !coveredSet.has(f));

  // 4. Calculate coverage percentage
  const coveragePercent = discoveredFiles.length > 0
    ? Math.round((coveredByPatterns.length / discoveredFiles.length) * 100)
    : 100;

  return {
    discoveredFiles,
    coveredByPatterns,
    notCoveredFiles,
    coveragePercent,
  };
}

/**
 * Format manifest coverage result for display in error messages.
 */
export function formatManifestCoverageResult(result: ManifestCoverageResult): string {
  const lines: string[] = [];

  lines.push(`Manifest Coverage: ${result.coveragePercent}%`);
  lines.push(`Discovered: ${result.discoveredFiles.length} source files in repository`);
  lines.push(`Covered by patterns: ${result.coveredByPatterns.length} files`);
  lines.push(`Not covered: ${result.notCoveredFiles.length} files`);

  if (result.notCoveredFiles.length > 0) {
    lines.push("");
    lines.push("Uncovered files:");
    const displayCount = Math.min(result.notCoveredFiles.length, 20);
    for (let i = 0; i < displayCount; i++) {
      lines.push(`  - ${result.notCoveredFiles[i]}`);
    }
    if (result.notCoveredFiles.length > 20) {
      lines.push(`  ... and ${result.notCoveredFiles.length - 20} more`);
    }
  }

  return lines.join("\n");
}

/**
 * Suggest patterns that might cover uncovered files.
 * Groups files by directory and suggests glob patterns.
 */
export function suggestPatternsForUncoveredFiles(uncoveredFiles: string[]): string[] {
  const suggestions: string[] = [];
  const directoryCounts = new Map<string, number>();

  // Count files per directory (up to 2 levels deep)
  for (const file of uncoveredFiles) {
    const parts = file.split("/");
    if (parts.length >= 2) {
      // Try directory + pattern
      const dir = parts.slice(0, -1).join("/");
      directoryCounts.set(dir, (directoryCounts.get(dir) || 0) + 1);
    }
  }

  // Generate suggestions for directories with multiple files
  const sortedDirs = [...directoryCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  for (const [dir, count] of sortedDirs) {
    // Find common extensions in this directory
    const filesInDir = uncoveredFiles.filter(f => f.startsWith(dir + "/"));
    const extensions = new Set<string>();
    for (const f of filesInDir) {
      const ext = f.split(".").pop();
      if (ext) extensions.add(ext);
    }

    const extPatterns = extensions.size <= 2
      ? [...extensions].map(e => `*.${e}`).join(",")
      : "*";

    suggestions.push(`${dir}/${extPatterns.includes(",") ? `{${extPatterns}}` : extPatterns} (${count} files)`);
  }

  return suggestions;
}
