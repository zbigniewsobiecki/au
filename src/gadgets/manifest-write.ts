/**
 * Manifest Write Gadgets
 * Write/update the discovery manifest and count patterns in files.
 */

import { createGadget, z } from "llmist";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { GADGET_REASON_DESCRIPTION } from "../lib/constants.js";

/**
 * Manifest structure for Cycle 0 discovery.
 */
export interface ManifestCycle {
  name: string;
  files?: string[];  // Optional for cycles using directory assignments
  counts?: Record<string, number>;
  expectedOutputs?: string[];
  // Coverage tracking for comprehensive mode
  coverage?: {
    targetFiles: string[];    // All files matching patterns
    totalCount: number;
  };
}

export interface ManifestProject {
  name: string;
  primaryLanguage: string;
  framework?: string;
  architectureStyle?: string;
}

export interface ManifestStatistics {
  totalFiles?: number;
  relevantFiles?: number;
}

/**
 * Per-directory cycle assignment.
 * Each directory is assigned to specific cycles with patterns.
 */
export interface DirectoryCycleAssignment {
  patterns: string[];
  reason?: string;
}

export interface DirectoryAssignment {
  path: string;
  purpose?: string;
  cycles: Record<string, DirectoryCycleAssignment>;
}

export interface Manifest {
  version: number;
  discoveredAt: string;
  project: ManifestProject;
  directories?: DirectoryAssignment[];
  cycles: Record<string, ManifestCycle>;
  statistics?: ManifestStatistics;
}

const MANIFEST_PATH = ".sysml/_manifest.json";

export const manifestWrite = createGadget({
  name: "ManifestWrite",
  maxConcurrent: 1,
  description: `Write or update the discovery manifest for subsequent cycles.

**Usage:**
ManifestWrite(manifest={ version: 1, project: {...}, cycles: {...} })

The manifest contains:
- Project metadata (name, language, framework)
- Per-cycle file lists with exact counts
- Expected outputs for validation

**IMPORTANT**: Use "cycle1", "cycle2", etc. as keys (NOT "1", "2", etc.)

Example:
ManifestWrite(manifest={
  version: 1,
  discoveredAt: "2026-01-22T...",
  project: { name: "myapp", primaryLanguage: "typescript", framework: "fastify" },
  cycles: {
    "cycle1": { name: "Discovery", files: ["README.md", "package.json"], expectedOutputs: ["context/boundaries.sysml"] },
    "cycle2": { name: "Structure", files: ["apps/backend/src/modules/*/index.ts"], counts: { modules: 48 } },
    "cycle3": { name: "Data", files: ["schema.prisma"], counts: { models: 34, enums: 30 } }
  }
})`,
  schema: z.object({
    reason: z.string().describe(GADGET_REASON_DESCRIPTION),
    manifest: z.object({
      version: z.number().describe("Manifest version (should be 2 for directory-based assignment)"),
      discoveredAt: z.string().describe("ISO timestamp of discovery"),
      project: z.object({
        name: z.string().describe("Project name"),
        primaryLanguage: z.string().describe("Primary programming language"),
        framework: z.string().optional().describe("Primary framework (e.g., fastify, nextjs)"),
        architectureStyle: z.string().optional().describe("Architecture style (e.g., monorepo, microservices)"),
      }),
      directories: z.array(z.object({
        path: z.string().describe("Directory path relative to project root"),
        purpose: z.string().optional().describe("Brief description of directory purpose"),
        cycles: z.record(z.string(), z.object({
          patterns: z.array(z.string()).describe("File patterns within this directory for this cycle"),
          reason: z.string().optional().describe("Why this directory is assigned to this cycle"),
        })).describe("Cycle assignments for this directory"),
      })).optional().describe("Per-directory cycle assignments (version 2+)"),
      cycles: z.record(z.string(), z.object({
        name: z.string().describe("Cycle name"),
        files: z.array(z.string()).optional().describe("Files or glob patterns for this cycle (optional if using directory assignments)"),
        counts: z.record(z.string(), z.number()).optional().describe("Exact counts for validation (e.g., { models: 34, enums: 30 })"),
        expectedOutputs: z.array(z.string()).optional().describe("Expected SysML output files"),
        coverage: z.object({
          targetFiles: z.array(z.string()).describe("All files matching patterns for this cycle"),
          totalCount: z.number().describe("Total number of target files"),
        }).optional().describe("Coverage tracking for comprehensive file reading"),
      })).describe("Cycle configurations keyed by cycle number"),
      statistics: z.object({
        totalFiles: z.number().optional(),
        relevantFiles: z.number().optional(),
      }).optional().describe("Overall statistics"),
    }).describe("The manifest object"),
  }),
  execute: async ({ reason: _reason, manifest }) => {
    // Create directory if needed
    const dir = dirname(MANIFEST_PATH);
    if (dir && dir !== ".") {
      await mkdir(dir, { recursive: true });
    }

    // Write manifest as formatted JSON
    const content = JSON.stringify(manifest, null, 2);
    await writeFile(MANIFEST_PATH, content, "utf-8");

    // Count total files across all cycles
    let totalCycleFiles = 0;
    const cycleKeys = Object.keys(manifest.cycles).sort();
    for (const key of cycleKeys) {
      totalCycleFiles += manifest.cycles[key].files?.length ?? 0;
    }

    // Summarize counts
    const countsInfo: string[] = [];
    for (const key of cycleKeys) {
      const cycle = manifest.cycles[key];
      if (cycle.counts && Object.keys(cycle.counts).length > 0) {
        const countStr = Object.entries(cycle.counts)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ");
        countsInfo.push(`Cycle ${key}: ${countStr}`);
      }
    }

    let result = `Wrote manifest to ${MANIFEST_PATH}\n`;
    result += `  Version: ${manifest.version}\n`;
    result += `  Project: ${manifest.project.name} (${manifest.project.primaryLanguage})\n`;
    result += `  Cycles defined: ${cycleKeys.join(", ")}\n`;
    result += `  Total file entries: ${totalCycleFiles}`;

    if (countsInfo.length > 0) {
      result += `\n  Target counts:\n    ${countsInfo.join("\n    ")}`;
    }

    // Report directory assignments if present (version 2+)
    if (manifest.directories && manifest.directories.length > 0) {
      result += `\n  Directory assignments: ${manifest.directories.length} directories`;

      // Count how many directories are assigned to each cycle
      const cycleAssignmentCounts: Record<string, number> = {};
      for (const dir of manifest.directories) {
        for (const cycleKey of Object.keys(dir.cycles)) {
          cycleAssignmentCounts[cycleKey] = (cycleAssignmentCounts[cycleKey] || 0) + 1;
        }
      }

      if (Object.keys(cycleAssignmentCounts).length > 0) {
        const assignmentStr = Object.entries(cycleAssignmentCounts)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([cycle, count]) => `${cycle}=${count}`)
          .join(", ");
        result += `\n  Directories per cycle: ${assignmentStr}`;
      }
    }

    return result;
  },
});

/**
 * Extract cycle number from key (handles both "1" and "cycle1" formats).
 */
function getCycleNumber(key: string): number {
  if (key.startsWith("cycle")) {
    return parseInt(key.slice(5), 10);
  }
  return parseInt(key, 10);
}

/**
 * Sort cycle keys by their numeric value.
 */
function sortCycleKeys(keys: string[]): string[] {
  return keys.sort((a, b) => getCycleNumber(a) - getCycleNumber(b));
}

export const manifestRead = createGadget({
  name: "ManifestRead",
  description: `Read the existing discovery manifest.

**Usage:**
ManifestRead()

Returns the manifest contents or an error if not found.`,
  schema: z.object({
    reason: z.string().describe(GADGET_REASON_DESCRIPTION),
  }),
  execute: async ({ reason: _reason }) => {
    try {
      const content = await readFile(MANIFEST_PATH, "utf-8");
      const manifest = JSON.parse(content) as Manifest;

      let output = `=== Discovery Manifest ===\n`;
      output += `Project: ${manifest.project.name} (${manifest.project.primaryLanguage})\n`;
      output += `Discovered: ${manifest.discoveredAt}\n\n`;

      output += `Cycles:\n`;
      const sortedKeys = sortCycleKeys(Object.keys(manifest.cycles));
      for (const key of sortedKeys) {
        const cycle = manifest.cycles[key];
        const cycleNum = getCycleNumber(key);
        output += `  ${cycleNum}. ${cycle.name}\n`;
        output += `     Files: ${cycle.files?.length ?? 0} entries\n`;
        if (cycle.counts && Object.keys(cycle.counts).length > 0) {
          const countStr = Object.entries(cycle.counts)
            .map(([k, v]) => `${k}=${v}`)
            .join(", ");
          output += `     Counts: ${countStr}\n`;
        }
      }

      return output;
    } catch {
      return `Error: Manifest not found at ${MANIFEST_PATH}. Run Cycle 0 to generate it.`;
    }
  },
});

export const countPatterns = createGadget({
  name: "CountPatterns",
  description: `Count regex pattern matches in a file.

**Usage:**
CountPatterns(file="schema.prisma", patterns=["^model ", "^enum "])

Returns exact counts for each pattern. Use this to get accurate counts for the manifest.

Example output:
  "^model ": 34
  "^enum ": 30`,
  schema: z.object({
    reason: z.string().describe(GADGET_REASON_DESCRIPTION),
    file: z.string().describe("Path to the file to analyze"),
    patterns: z.array(z.string()).describe("Array of regex patterns to count (line-by-line matching)"),
  }),
  execute: async ({ reason: _reason, file, patterns }) => {
    try {
      const content = await readFile(file, "utf-8");
      const lines = content.split("\n");

      const counts: Record<string, number> = {};
      const matchedLines: Record<string, string[]> = {};

      for (const pattern of patterns) {
        const regex = new RegExp(pattern);
        counts[pattern] = 0;
        matchedLines[pattern] = [];

        for (const line of lines) {
          if (regex.test(line)) {
            counts[pattern]++;
            // Store first few matches as examples (up to 5)
            if (matchedLines[pattern].length < 5) {
              matchedLines[pattern].push(line.trim().slice(0, 80));
            }
          }
        }
      }

      let output = `=== Pattern Counts for ${file} ===\n\n`;
      for (const pattern of patterns) {
        output += `"${pattern}": ${counts[pattern]}\n`;
        if (matchedLines[pattern].length > 0) {
          output += `  Examples:\n`;
          for (const match of matchedLines[pattern]) {
            output += `    - ${match}\n`;
          }
        }
      }

      // Also output as JSON for easy parsing
      output += `\nJSON: ${JSON.stringify(counts)}`;

      return output;
    } catch (error) {
      return `Error reading file ${file}: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});

/**
 * Load manifest from disk.
 * Returns null if manifest doesn't exist.
 */
export async function loadManifest(): Promise<Manifest | null> {
  try {
    const content = await readFile(MANIFEST_PATH, "utf-8");
    return JSON.parse(content) as Manifest;
  } catch {
    return null;
  }
}

/**
 * Find cycle data by cycle number (handles both "1" and "cycle1" key formats).
 */
function findCycleData(manifest: Manifest, cycle: number): ManifestCycle | null {
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
 * Get files for a specific cycle from the manifest.
 * Returns null if manifest doesn't exist or cycle isn't defined.
 */
export async function getManifestCycleFiles(cycle: number): Promise<string[] | null> {
  const manifest = await loadManifest();
  if (!manifest) return null;

  const cycleData = findCycleData(manifest, cycle);
  if (!cycleData || !cycleData.files) return null;

  return cycleData.files;
}

/**
 * Get target counts for a specific cycle from the manifest.
 * Returns null if manifest doesn't exist or cycle has no counts.
 */
export async function getManifestCycleCounts(cycle: number): Promise<Record<string, number> | null> {
  const manifest = await loadManifest();
  if (!manifest) return null;

  const cycleData = findCycleData(manifest, cycle);
  if (!cycleData || !cycleData.counts) return null;

  return cycleData.counts;
}

/**
 * Get directory patterns for a specific cycle from the manifest.
 * Returns an array of { dirPath, patterns } for version 2+ manifests.
 * Returns null if manifest doesn't exist or has no directory assignments.
 */
export async function getManifestDirectoryPatterns(
  cycle: number
): Promise<{ dirPath: string; patterns: string[] }[] | null> {
  const manifest = await loadManifest();
  if (!manifest || !manifest.directories) return null;

  const cycleKey = `cycle${cycle}`;
  const result: { dirPath: string; patterns: string[] }[] = [];

  // Iterate over array instead of Object.entries
  for (const dir of manifest.directories) {
    const cycleConfig = dir.cycles[cycleKey];
    if (cycleConfig && cycleConfig.patterns.length > 0) {
      result.push({ dirPath: dir.path, patterns: cycleConfig.patterns });
    }
  }

  return result.length > 0 ? result : null;
}
