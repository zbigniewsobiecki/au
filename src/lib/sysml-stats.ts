/**
 * SysML Model Statistics
 * Gathers statistics about the SysML model.
 */

import { readFile, readdir, stat, access } from "node:fs/promises";
import { join } from "node:path";
import { loadManifest, type Manifest, type ManifestProject } from "../gadgets/manifest-write.js";
import { SysMLCoverageValidator } from "./sysml-model-validator.js";
import { validateModelFull, parseMultiFileDiagnosticOutput } from "./sysml/sysml2-cli.js";
import { validateSourceFilePaths as validateSourceFiles, type SourceFileError } from "./sysml/index.js";
import fg from "fast-glob";

const SYSML_DIR = ".sysml";
const MANIFEST_PATH = ".sysml/_manifest.json";

export interface Sysml2ValidationDiagnostic {
  file: string;
  line: number;
  column: number;
  severity: "error" | "warning";
  message: string;
  code?: string;
}

export interface Sysml2ValidationStats {
  exitCode: number;
  errorCount: number;
  warningCount: number;
  diagnostics: Sysml2ValidationDiagnostic[];
}

export interface CycleCounts {
  name: string;
  filePatterns: number;
  expectedOutputs: number;
  sourceFiles?: string[];
}

export interface SourceCoverage {
  /** Number of unique source files covered by directory patterns */
  filesCovered: number;
}

export interface CycleCoverageStats {
  covered: number;
  expected: number;
  percent: number;
  uncoveredFiles: string[];
}

export interface CoverageStats {
  /** Total files referenced by @SourceFile in .sysml */
  referencedFiles: number;
  /** Files referenced that don't exist on disk */
  brokenReferences: number;
  /** Actual paths that are broken references */
  brokenPaths: string[];
  /** Detailed errors for broken references (includes sysml file and line) */
  brokenPathErrors: SourceFileError[];
  /** Per-cycle: expected vs covered from manifest sourceFiles */
  cycleCoverage: Record<string, CycleCoverageStats>;
}

export interface SysMLModelStats {
  fileCount: number;
  totalBytes: number;
  averageBytes: number;
  project: ManifestProject | null;
  cycleCounts: Record<string, CycleCounts>;
  sourceCoverage: SourceCoverage;
  directoryCount: number;
  coverageStats: CoverageStats | null;
  sysml2Validation: Sysml2ValidationStats | null;
}

/**
 * Check if a file/directory exists.
 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Scan the .sysml directory for all .sysml files.
 */
async function scanSysmlFiles(basePath: string): Promise<{ path: string; bytes: number }[]> {
  const sysmlDir = join(basePath, SYSML_DIR);
  const files: { path: string; bytes: number }[] = [];

  async function scanDir(dir: string, prefix: string = ""): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        const fullPath = join(dir, entry.name);

        if (entry.isDirectory()) {
          await scanDir(fullPath, relativePath);
        } else if (entry.name.endsWith(".sysml")) {
          const stats = await stat(fullPath);
          files.push({ path: relativePath, bytes: stats.size });
        }
      }
    } catch {
      // Directory doesn't exist
    }
  }

  await scanDir(sysmlDir);
  return files;
}

/**
 * Count unique source files matching directory patterns.
 */
async function countSourceFiles(
  basePath: string,
  manifest: Manifest
): Promise<number> {
  if (!manifest.directories || manifest.directories.length === 0) {
    return 0;
  }

  const coveredFiles = new Set<string>();

  for (const dir of manifest.directories) {
    for (const cycleConfig of Object.values(dir.cycles)) {
      for (const pattern of cycleConfig.patterns) {
        const globPattern = join(basePath, dir.path, pattern);
        try {
          const matches = await fg(globPattern, { onlyFiles: true });
          matches.forEach((m) => coveredFiles.add(m));
        } catch {
          // Pattern didn't match
        }
      }
    }
  }

  return coveredFiles.size;
}

export class SysMLStats {
  /**
   * Expand glob patterns to actual file paths.
   */
  private async expandPatterns(patterns: string[], basePath: string): Promise<string[]> {
    const files: string[] = [];

    for (const pattern of patterns) {
      if (pattern.includes("*")) {
        const matches = await fg(pattern, {
          cwd: basePath,
          onlyFiles: true,
          ignore: ["**/node_modules/**", "**/dist/**", "**/.git/**"],
        });
        files.push(...matches);
      } else {
        const fullPath = join(basePath, pattern);
        if (await pathExists(fullPath)) {
          files.push(pattern);
        }
      }
    }

    return [...new Set(files)];
  }

  /**
   * Get statistics about the SysML model.
   */
  async getStats(basePath: string = "."): Promise<SysMLModelStats> {
    const result: SysMLModelStats = {
      fileCount: 0,
      totalBytes: 0,
      averageBytes: 0,
      project: null,
      cycleCounts: {},
      sourceCoverage: { filesCovered: 0 },
      directoryCount: 0,
      coverageStats: null,
      sysml2Validation: null,
    };

    // Check if .sysml directory exists
    const sysmlDir = join(basePath, SYSML_DIR);
    if (!(await pathExists(sysmlDir))) {
      return result;
    }

    // Scan all .sysml files
    const files = await scanSysmlFiles(basePath);
    result.fileCount = files.length;
    result.totalBytes = files.reduce((sum, f) => sum + f.bytes, 0);
    result.averageBytes = files.length > 0 ? Math.round(result.totalBytes / files.length) : 0;

    // Load manifest if exists
    const manifestPath = join(basePath, MANIFEST_PATH);
    if (await pathExists(manifestPath)) {
      try {
        const content = await readFile(manifestPath, "utf-8");
        const manifest: Manifest = JSON.parse(content);

        result.project = manifest.project;
        result.directoryCount = manifest.directories?.length ?? 0;

        // Extract cycle counts
        for (const [cycleKey, cycle] of Object.entries(manifest.cycles)) {
          result.cycleCounts[cycleKey] = {
            name: cycle.name,
            filePatterns: cycle.files?.length ?? 0,
            expectedOutputs: cycle.expectedOutputs?.length ?? 0,
            sourceFiles: cycle.sourceFiles,
          };
        }

        // Calculate source coverage
        const filesCovered = await countSourceFiles(basePath, manifest);
        result.sourceCoverage = { filesCovered };

        // Gather coverage stats using validator
        const validator = new SysMLCoverageValidator();
        const coveredFiles = await validator.getCoveredFilesFromPath(basePath);
        // Use the coverage-checker's validateSourceFilePaths for detailed errors
        const sourceFileValidation = await validateSourceFiles(join(basePath, ".sysml"), basePath);
        const brokenPathErrors = sourceFileValidation.errors;
        const brokenPaths = brokenPathErrors.map(e => e.referencedPath);
        const validationResult = await validator.validate(basePath);

        // Build per-cycle coverage from validation mismatches
        const cycleCoverage: Record<string, CycleCoverageStats> = {};

        // First, populate from manifest sourceFiles (cycles that have coverage expectations)
        for (const [cycleKey, cycle] of Object.entries(manifest.cycles)) {
          if (cycle.sourceFiles && cycle.sourceFiles.length > 0) {
            // Find mismatch for this cycle if any
            const mismatch = validationResult.fileCoverageMismatches.find(
              (m) => m.cycle === cycleKey
            );
            if (mismatch) {
              cycleCoverage[cycleKey] = {
                covered: mismatch.covered,
                expected: mismatch.expected,
                percent: mismatch.expected > 0
                  ? Math.round((mismatch.covered / mismatch.expected) * 100)
                  : 100,
                uncoveredFiles: mismatch.uncoveredFiles,
              };
            } else {
              // No mismatch means 100% coverage for this cycle
              // We need to expand patterns to get expected count
              const expectedFiles = await this.expandPatterns(cycle.sourceFiles, basePath);
              cycleCoverage[cycleKey] = {
                covered: expectedFiles.length,
                expected: expectedFiles.length,
                percent: 100,
                uncoveredFiles: [],
              };
            }
          }
        }

        result.coverageStats = {
          referencedFiles: coveredFiles.size,
          brokenReferences: brokenPaths.length,
          brokenPaths,
          brokenPathErrors,
          cycleCoverage,
        };
      } catch {
        // Manifest exists but couldn't be parsed
      }
    }

    // Run sysml2 validation
    try {
      const validation = await validateModelFull(sysmlDir);
      const diagnostics = parseMultiFileDiagnosticOutput(validation.output || "");

      result.sysml2Validation = {
        exitCode: validation.exitCode,
        errorCount: diagnostics.filter(d => d.severity === "error").length,
        warningCount: diagnostics.filter(d => d.severity === "warning").length,
        diagnostics: diagnostics.map(d => ({
          file: d.file,
          line: d.line,
          column: d.column,
          severity: d.severity,
          message: d.message,
          code: d.code || undefined,
        })),
      };
    } catch {
      // sysml2 not available or validation failed
    }

    return result;
  }
}

/**
 * Format bytes to human-readable string.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
