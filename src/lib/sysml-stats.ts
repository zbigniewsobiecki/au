/**
 * SysML Model Statistics
 * Gathers statistics about the SysML model.
 */

import { readFile, readdir, stat, access } from "node:fs/promises";
import { join } from "node:path";
import { loadManifest, type Manifest, type ManifestProject } from "../gadgets/manifest-write.js";
import fg from "fast-glob";

const SYSML_DIR = ".sysml";
const MANIFEST_PATH = ".sysml/_manifest.json";

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

export interface SysMLModelStats {
  fileCount: number;
  totalBytes: number;
  averageBytes: number;
  project: ManifestProject | null;
  cycleCounts: Record<string, CycleCounts>;
  sourceCoverage: SourceCoverage;
  directoryCount: number;
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
      } catch {
        // Manifest exists but couldn't be parsed
      }
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
