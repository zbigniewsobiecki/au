/**
 * SysML Coverage Validator
 * Validates source file coverage in the SysML model.
 *
 * Note: Syntax and semantic validation is handled by sysml2 CLI.
 * This module focuses only on coverage tracking via @SourceFile metadata.
 */

import { readFile, readdir, access } from "node:fs/promises";
import { join } from "node:path";
import { loadManifest, type Manifest } from "../gadgets/manifest-write.js";
import fg from "fast-glob";

const SYSML_DIR = ".sysml";

export interface FileCoverageMismatch {
  cycle: string;
  patterns: string[];      // Original patterns from manifest
  expected: number;        // Expanded file count
  covered: number;         // Files with @SourceFile metadata
  uncoveredFiles: string[]; // Specific files not covered
}

export interface CoverageIssue {
  cycle: string;
  type: "missing-file" | "missing-directory" | "pattern-no-match";
  path: string;
  detail?: string;
}

export interface CoverageValidationResult {
  fileCoverageMismatches: FileCoverageMismatch[];
  coverageIssues: CoverageIssue[];
}

/**
 * Check if a file exists.
 */
async function fileExists(path: string): Promise<boolean> {
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
async function scanSysmlFiles(basePath: string): Promise<string[]> {
  const sysmlDir = join(basePath, SYSML_DIR);
  const files: string[] = [];

  async function scanDir(dir: string, prefix: string = ""): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        const fullPath = join(dir, entry.name);

        if (entry.isDirectory()) {
          // Skip .debug/ directory (contains partial fragments from edit history)
          if (entry.name === ".debug") {
            continue;
          }
          await scanDir(fullPath, relativePath);
        } else if (entry.name.endsWith(".sysml")) {
          files.push(relativePath);
        }
      }
    } catch {
      // Directory doesn't exist
    }
  }

  await scanDir(sysmlDir);
  return files;
}

export class SysMLCoverageValidator {
  /**
   * Validate coverage at the given path.
   */
  async validate(basePath: string = "."): Promise<CoverageValidationResult> {
    const result: CoverageValidationResult = {
      fileCoverageMismatches: [],
      coverageIssues: [],
    };

    // Check if .sysml directory exists
    const sysmlDir = join(basePath, SYSML_DIR);
    if (!(await fileExists(sysmlDir))) {
      return result;
    }

    // Load manifest
    const manifest = await loadManifest();
    if (!manifest) {
      return result;
    }

    // Scan all .sysml files and load their content
    const sysmlFiles = await scanSysmlFiles(basePath);
    const fileContents: Map<string, string> = new Map();

    for (const file of sysmlFiles) {
      const fullPath = join(basePath, SYSML_DIR, file);
      try {
        const content = await readFile(fullPath, "utf-8");
        fileContents.set(file, content);
      } catch {
        // Skip files that can't be read
      }
    }

    // Check file coverage from manifest cycles
    await this.validateFileCoverage(manifest, fileContents, basePath, result);

    // Check coverage completeness (target files exist)
    await this.validateCoverage(manifest, basePath, result);

    return result;
  }

  /**
   * Get total issue count from validation result.
   */
  static getIssueCount(result: CoverageValidationResult): number {
    return result.fileCoverageMismatches.length + result.coverageIssues.length;
  }

  /**
   * Get actionable issue count (includes all issues - coverage-mismatch is now actionable).
   */
  static getActionableIssueCount(result: CoverageValidationResult): number {
    return result.fileCoverageMismatches.length + result.coverageIssues.length;
  }

  /**
   * Validate that source files are covered by SysML definitions.
   * Checks for @SourceFile { :>> path = "<path>"; } metadata in SysML files.
   */
  private async validateFileCoverage(
    manifest: Manifest,
    fileContents: Map<string, string>,
    basePath: string,
    result: CoverageValidationResult
  ): Promise<void> {
    // Extract all covered files from SysML content (@SourceFile metadata)
    const coveredFiles = this.findCoveredFiles(fileContents);

    for (const [cycleKey, cycle] of Object.entries(manifest.cycles)) {
      if (!cycle.sourceFiles || cycle.sourceFiles.length === 0) continue;

      // Expand glob patterns to actual file paths
      const expectedFiles = await this.expandPatterns(cycle.sourceFiles, basePath);

      if (expectedFiles.length === 0) continue;

      // Normalize paths for comparison (remove leading ./)
      const normalizedCoveredFiles = new Set(
        [...coveredFiles].map(f => f.replace(/^\.\//, ''))
      );
      const normalizedExpectedFiles = expectedFiles.map(f => f.replace(/^\.\//, ''));

      // Find which files are not covered
      const uncoveredFiles = normalizedExpectedFiles.filter(f => !normalizedCoveredFiles.has(f));

      if (uncoveredFiles.length > 0) {
        result.fileCoverageMismatches.push({
          cycle: cycleKey,
          patterns: cycle.sourceFiles,
          expected: expectedFiles.length,
          covered: expectedFiles.length - uncoveredFiles.length,
          uncoveredFiles,
        });
      }
    }
  }

  /**
   * Extract source file references from SysML content.
   * Looks for @SourceFile { :>> path = "<path>"; } metadata.
   */
  findCoveredFiles(fileContents: Map<string, string>): Set<string> {
    const covered = new Set<string>();

    for (const [, content] of fileContents) {
      // Match @SourceFile { :>> path = "<path>"; } metadata
      const sourceMatches = content.matchAll(/@SourceFile\s*\{\s*:>>\s*path\s*=\s*"([^"]+)"/g);
      for (const match of sourceMatches) {
        const sourcePath = match[1].trim();
        if (sourcePath) {
          covered.add(sourcePath);
        }
      }
    }

    return covered;
  }

  /**
   * Get all @SourceFile references from .sysml files at the given path.
   * Returns a Set of all referenced file paths.
   */
  async getCoveredFilesFromPath(basePath: string = "."): Promise<Set<string>> {
    const sysmlFiles = await scanSysmlFiles(basePath);
    const fileContents: Map<string, string> = new Map();

    for (const file of sysmlFiles) {
      const fullPath = join(basePath, SYSML_DIR, file);
      try {
        const content = await readFile(fullPath, "utf-8");
        fileContents.set(file, content);
      } catch {
        // Skip files that can't be read
      }
    }

    return this.findCoveredFiles(fileContents);
  }

  /**
   * Validate that @SourceFile paths in the model reference existing files.
   * Returns paths that are referenced but don't exist on disk.
   */
  async validateSourceFilePaths(basePath: string = "."): Promise<string[]> {
    const coveredFiles = await this.getCoveredFilesFromPath(basePath);
    const brokenPaths: string[] = [];

    for (const filePath of coveredFiles) {
      const fullPath = join(basePath, filePath);
      if (!(await fileExists(fullPath))) {
        brokenPaths.push(filePath);
      }
    }

    return brokenPaths;
  }

  /**
   * Expand glob patterns to actual file paths.
   */
  private async expandPatterns(patterns: string[], basePath: string): Promise<string[]> {
    const files: string[] = [];

    for (const pattern of patterns) {
      if (pattern.includes("*")) {
        // Expand glob pattern
        const matches = await fg(pattern, {
          cwd: basePath,
          onlyFiles: true,
          ignore: ["**/node_modules/**", "**/dist/**", "**/.git/**"],
        });
        files.push(...matches);
      } else {
        // Literal path - check if it exists
        const fullPath = join(basePath, pattern);
        if (await fileExists(fullPath)) {
          files.push(pattern);
        }
      }
    }

    // Deduplicate
    return [...new Set(files)];
  }

  /**
   * Validate coverage completeness - target files in manifest exist.
   */
  private async validateCoverage(
    manifest: Manifest,
    basePath: string,
    result: CoverageValidationResult
  ): Promise<void> {
    // Check cycle.coverage.targetFiles
    for (const [cycleKey, cycle] of Object.entries(manifest.cycles)) {
      if (cycle.coverage?.targetFiles) {
        for (const targetFile of cycle.coverage.targetFiles) {
          const fullPath = join(basePath, targetFile);
          if (!(await fileExists(fullPath))) {
            result.coverageIssues.push({
              cycle: cycleKey,
              type: "missing-file",
              path: targetFile,
            });
          }
        }
      }
    }

    // Check directories paths exist
    if (manifest.directories) {
      for (const dir of manifest.directories) {
        const fullPath = join(basePath, dir.path);
        if (!(await fileExists(fullPath))) {
          result.coverageIssues.push({
            cycle: "directories",
            type: "missing-directory",
            path: dir.path,
          });
        } else {
          // Check that patterns match at least one file
          for (const [cycleKey, cycleConfig] of Object.entries(dir.cycles)) {
            for (const pattern of cycleConfig.patterns) {
              const globPattern = join(basePath, dir.path, pattern);
              const matches = await fg(globPattern, { onlyFiles: true });
              if (matches.length === 0) {
                result.coverageIssues.push({
                  cycle: cycleKey,
                  type: "pattern-no-match",
                  path: `${dir.path}/${pattern}`,
                  detail: "Pattern does not match any files",
                });
              }
            }
          }
        }
      }
    }
  }
}
