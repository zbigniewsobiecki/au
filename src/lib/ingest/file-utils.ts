/**
 * File utilities for the ingest command.
 * Handles file discovery, expansion, and reading.
 */

import { readFile } from "node:fs/promises";
import fg from "fast-glob";
import micromatch from "micromatch";

import { STANDARD_IGNORE_PATTERNS } from "./constants.js";
import {
  loadManifest,
  getManifestDirectoryPatterns,
  getManifestCycleSourceFiles,
} from "../../gadgets/index.js";
import {
  getCyclePatterns,
  SCHEMA_PRIORITY_PATTERNS,
} from "../sysml/index.js";

/**
 * Find cycle data in manifest (handles both "cycle1" and "1" key formats).
 */
export function findManifestCycle(
  manifest: { cycles: Record<string, { files?: string[]; sourceFiles?: string[]; expectedOutputs?: string[] }> },
  cycle: number
) {
  // Try "cycle1" format first
  const prefixedKey = `cycle${cycle}`;
  if (manifest.cycles[prefixedKey]) {
    return manifest.cycles[prefixedKey];
  }
  // Try "1" format
  const numericKey = String(cycle);
  if (manifest.cycles[numericKey]) {
    return manifest.cycles[numericKey];
  }
  return null;
}

/**
 * Check if a file matches any of the high-priority schema patterns.
 */
export function isHighPrioritySchema(file: string): boolean {
  return micromatch.isMatch(file, SCHEMA_PRIORITY_PATTERNS);
}

/**
 * Expand glob patterns from manifest files array.
 * Handles both literal files and glob patterns.
 */
export async function expandManifestGlobs(
  files: string[],
  maxFiles: number
): Promise<string[]> {
  const allFiles: string[] = [];

  for (const pattern of files) {
    // Check if it's a glob pattern or literal file
    if (pattern.includes("*") || pattern.includes("?") || pattern.includes("{")) {
      // It's a glob pattern
      const matched = await fg(pattern, {
        cwd: ".",
        ignore: STANDARD_IGNORE_PATTERNS,
        onlyFiles: true,
      });
      allFiles.push(...matched);
    } else {
      // It's a literal file - check if it exists
      try {
        await readFile(pattern, "utf-8");
        allFiles.push(pattern);
      } catch {
        // File doesn't exist, skip
      }
    }
  }

  // Deduplicate and sort
  return [...new Set(allFiles)].sort().slice(0, maxFiles);
}

/**
 * Expand directory patterns from manifest v2 format.
 * For each directory, expands patterns like "*.service.ts" to actual files.
 */
export async function expandDirectoryPatterns(
  dirPatterns: { dirPath: string; patterns: string[] }[],
  maxFiles: number
): Promise<string[]> {
  const allFiles: string[] = [];

  for (const { dirPath, patterns } of dirPatterns) {
    for (const pattern of patterns) {
      // Combine directory path with pattern
      const fullPattern = `${dirPath}/${pattern}`;
      const matched = await fg(fullPattern, {
        cwd: ".",
        ignore: STANDARD_IGNORE_PATTERNS,
        onlyFiles: true,
      });
      allFiles.push(...matched);
    }
  }

  // Deduplicate, sort, and limit
  return [...new Set(allFiles)].sort().slice(0, maxFiles);
}

/**
 * Get files relevant for a cycle.
 * First checks manifest v2 directory assignments, then manifest v1 files, then falls back to hardcoded patterns.
 * Schema files (*.prisma, *.graphql, etc.) are ONLY included for Cycle 3 (Data & Types).
 */
export async function getFilesForCycle(
  cycle: number,
  language?: string,
  maxFiles: number = 50
): Promise<string[]> {
  // 1. Try manifest v2 directory assignments first
  const dirPatterns = await getManifestDirectoryPatterns(cycle);
  if (dirPatterns && dirPatterns.length > 0) {
    const dirFiles = await expandDirectoryPatterns(dirPatterns, maxFiles);

    // Also include direct file assignments from cycles (e.g., schema files for cycle 3)
    const manifest = await loadManifest();
    if (manifest) {
      const cycleData = findManifestCycle(manifest, cycle);
      if (cycleData?.files && cycleData.files.length > 0) {
        const directFiles = await expandManifestGlobs(cycleData.files, maxFiles);
        // Combine directory files with direct file assignments
        const combined = [...new Set([...dirFiles, ...directFiles])];
        return combined.sort().slice(0, maxFiles);
      }
    }

    return dirFiles;
  }

  // 2. Try manifest sourceFiles patterns (cycle-specific file patterns)
  const sourceFiles = await getManifestCycleSourceFiles(cycle);
  if (sourceFiles && sourceFiles.length > 0) {
    return expandManifestGlobs(sourceFiles, maxFiles);
  }

  // 3. Try manifest v1 files array (legacy format)
  const manifest = await loadManifest();
  if (manifest) {
    const cycleData = findManifestCycle(manifest, cycle);
    if (cycleData?.files && cycleData.files.length > 0) {
      return expandManifestGlobs(cycleData.files, maxFiles);
    }
  }

  // 4. Fall back to hardcoded patterns
  const patterns = getCyclePatterns(cycle, language);

  if (patterns.length === 0) {
    return [];
  }

  // Only include schema files for Cycle 3 (Data & Types)
  if (cycle === 3) {
    // First, find all schema files (high priority for data extraction)
    const schemaFiles = await fg(SCHEMA_PRIORITY_PATTERNS, {
      cwd: ".",
      ignore: STANDARD_IGNORE_PATTERNS,
      onlyFiles: true,
    });

    // Then find other files matching cycle patterns
    const otherFiles = await fg(patterns, {
      cwd: ".",
      ignore: STANDARD_IGNORE_PATTERNS,
      onlyFiles: true,
    });

    // Remove schema files from otherFiles to avoid duplicates
    const schemaSet = new Set(schemaFiles);
    const nonSchemaFiles = otherFiles.filter((f) => !schemaSet.has(f));

    // Schema files are always included (no limit), then fill remaining slots with other files
    const remainingSlots = Math.max(0, maxFiles - schemaFiles.length);
    const selectedOtherFiles = nonSchemaFiles.sort().slice(0, remainingSlots);

    // Return schema files first, then other files
    return [...schemaFiles.sort(), ...selectedOtherFiles];
  }

  // Other cycles: just use cycle-specific patterns (no schema priority)
  const files = await fg(patterns, {
    cwd: ".",
    ignore: STANDARD_IGNORE_PATTERNS,
    onlyFiles: true,
  });

  return files.sort().slice(0, maxFiles);
}

/**
 * Read file contents for context.
 * Schema files (*.prisma, *.graphql, etc.) get a higher character limit (100k)
 * to ensure complete extraction of all models and enums.
 */
export async function readFileContents(files: string[]): Promise<string> {
  const contents: string[] = [];

  // Character limits: schema files get 100k, others get 10k
  const SCHEMA_CHAR_LIMIT = 100000;
  const DEFAULT_CHAR_LIMIT = 10000;

  for (const file of files) {
    try {
      const content = await readFile(file, "utf-8");
      const charLimit = isHighPrioritySchema(file) ? SCHEMA_CHAR_LIMIT : DEFAULT_CHAR_LIMIT;
      const truncated = content.length > charLimit
        ? content.slice(0, charLimit) + "\n... (truncated)"
        : content;
      contents.push(`=== ${file} ===\n${truncated}`);
    } catch {
      contents.push(`=== ${file} ===\n(could not read file)`);
    }
  }

  return contents.join("\n\n");
}

/**
 * Select initial batch of files for a cycle.
 * Prioritizes entry points, index files, and schema files.
 */
export function selectInitialBatch(
  allFiles: string[],
  cycle: number,
  batchSize: number
): string[] {
  // Priority patterns by cycle
  const priorityPatterns: Record<number, RegExp[]> = {
    1: [/README\.md$/i, /package\.json$/, /\.env\.example$/, /docker-compose/],
    2: [/index\.(ts|js)$/, /\.module\.(ts|js)$/, /main\.(ts|js)$/, /app\.(ts|js)$/],
    3: [/\.prisma$/, /\.graphql$/, /\.proto$/, /schema\./i, /types?\.(ts|js)$/],
    4: [/\.service\.(ts|js)$/, /\.controller\.(ts|js)$/, /routes?\.(ts|js)$/],
    5: [/\.test\.(ts|js)$/, /\.spec\.(ts|js)$/, /\.e2e\./],
    6: [/\.md$/, /config\./i, /\.yaml$/, /\.yml$/],
  };

  const patterns = priorityPatterns[cycle] ?? [];

  // Score files by priority
  const scored = allFiles.map((file) => {
    let score = 0;
    for (let i = 0; i < patterns.length; i++) {
      if (patterns[i].test(file)) {
        score = patterns.length - i; // Higher score for earlier patterns
        break;
      }
    }
    return { file, score };
  });

  // Sort by score (descending) and take batch
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, batchSize).map((s) => s.file);
}
