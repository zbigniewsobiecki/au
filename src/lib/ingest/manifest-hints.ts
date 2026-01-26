/**
 * Manifest hints utilities for guiding LLM exploration during cycles.
 */

import fg from "fast-glob";

import { STANDARD_IGNORE_PATTERNS } from "./constants.js";
import { findManifestCycle } from "./file-utils.js";
import type { ManifestHints } from "./types.js";
import { loadManifest } from "../../gadgets/index.js";
import { getCyclePatterns } from "../sysml/index.js";

/**
 * Get manifest hints for a cycle to guide LLM exploration.
 * Returns directories, sourceFiles, and file patterns that help the LLM discover relevant files.
 */
export async function getManifestHintsForCycle(
  cycle: number,
  language?: string
): Promise<ManifestHints | null> {
  const manifest = await loadManifest();
  if (!manifest) return null;

  const cycleData = findManifestCycle(manifest, cycle);

  // Get relevant directories from manifest.directories
  const relevantDirs: string[] = [];
  const filePatterns: string[] = [];

  if (manifest.directories) {
    for (const dir of manifest.directories) {
      // Check if directory has assignment for this cycle
      const cycleKey = `cycle${cycle}`;
      if (dir.cycles && dir.cycles[cycleKey]) {
        relevantDirs.push(dir.path);
        // Also collect file patterns for this directory
        const patterns = dir.cycles[cycleKey].patterns;
        if (patterns && patterns.length > 0) {
          filePatterns.push(...patterns.map((p: string) => `${dir.path}/${p}`));
        }
      }
    }
  }

  // Get source files from manifest (may contain glob patterns)
  const sourceFiles = cycleData?.sourceFiles ?? null;

  // Fallback: if no directories, extract directories from cycle files or sourceFiles
  if (relevantDirs.length === 0) {
    const files = cycleData?.files ?? sourceFiles ?? [];
    const dirSet = new Set<string>();
    for (const file of files) {
      // Extract directory from file path or pattern
      const lastSlash = file.lastIndexOf("/");
      if (lastSlash > 0) {
        const dir = file.substring(0, lastSlash);
        // Skip glob wildcards in directory names
        if (!dir.includes("*")) {
          dirSet.add(dir);
        }
      }
    }
    relevantDirs.push(...Array.from(dirSet).sort());
    // Also add the files themselves as patterns
    if (cycleData?.files) {
      filePatterns.push(...cycleData.files);
    }
  }

  let expectedFileCount: number | null = null;

  // Try to expand sourceFiles patterns to get actual count
  if (sourceFiles && sourceFiles.length > 0) {
    const expandedFiles: string[] = [];
    for (const pattern of sourceFiles) {
      if (pattern.includes("*")) {
        const matches = await fg(pattern, {
          cwd: ".",
          ignore: STANDARD_IGNORE_PATTERNS,
          onlyFiles: true,
        });
        expandedFiles.push(...matches);
      } else {
        expandedFiles.push(pattern);
      }
    }
    expectedFileCount = [...new Set(expandedFiles)].length;
  }

  // Fallback to cycle patterns if no sourceFiles
  if (!expectedFileCount || expectedFileCount === 0) {
    const patterns = getCyclePatterns(cycle, language);
    if (patterns.length > 0) {
      const matchedFiles = await fg(patterns, {
        cwd: ".",
        ignore: STANDARD_IGNORE_PATTERNS,
        onlyFiles: true,
      });
      expectedFileCount = matchedFiles.length;
    }
  }

  // Final fallback to manifest files count
  if (!expectedFileCount || expectedFileCount === 0) {
    if (cycleData?.files) {
      expectedFileCount = cycleData.files.length;
    }
  }

  return {
    directories: relevantDirs,
    filePatterns: filePatterns.length > 0 ? filePatterns : null,
    sourceFiles,
    expectedOutputs: cycleData?.expectedOutputs ?? null,
    expectedFileCount,
  };
}
