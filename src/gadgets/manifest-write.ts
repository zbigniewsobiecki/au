/**
 * Manifest Write Gadgets
 * Write/update the discovery manifest and count patterns in files.
 */

import { createGadget, z } from "llmist";
import { writeFile, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { GADGET_REASON_DESCRIPTION } from "../lib/constants.js";
import {
  checkManifestCoverage,
  suggestPatternsForUncoveredFiles,
} from "../lib/sysml/coverage-checker.js";

/** Minimum coverage percentage required for manifest to be accepted (configurable) */
export let MIN_MANIFEST_COVERAGE = 95;  // Lower than 99%, with config files auto-excluded

/**
 * Set the minimum manifest coverage threshold.
 * @param value - Coverage percentage (0-100)
 */
export function setMinManifestCoverage(value: number): void {
  MIN_MANIFEST_COVERAGE = Math.max(0, Math.min(100, value));
}

/**
 * Entity ID tracking for sequential ID assignment.
 */
export interface EntityTracking {
  requirements?: { lastId: number };
  entities?: { lastId: number };
  operations?: { lastId: number };
  security?: { lastId: number };
  nfr?: { lastId: number };
}

/**
 * Manifest structure for Cycle 0 discovery.
 */
export interface ManifestCycle {
  name: string;
  files?: string[];  // Optional for cycles using directory assignments
  sourceFiles?: string[];  // Explicit source file list (supports glob patterns)
  expectedOutputs?: string[];
  // Coverage tracking for comprehensive mode
  coverage?: {
    targetFiles: string[];    // All files matching patterns
    totalCount: number;
  };
  // Entity ID tracking for sequential assignment
  entityTracking?: EntityTracking;
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
  discoveredEntities?: string[];  // Entity names discovered from model/entity files
  discoveredDomains?: string[];   // Domain names discovered from controllers/services
}

const MANIFEST_PATH = ".sysml/_manifest.json";

/**
 * Schema for the manifest object, extracted for use with z.preprocess().
 * This allows accepting both parsed objects and JSON strings from LLMs.
 */
const manifestObjectSchema = z.object({
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
    sourceFiles: z.array(z.string()).optional().describe("Source files to cover (supports glob patterns like 'src/models/**/*.ts')"),
    expectedOutputs: z.array(z.string()).optional().describe("Expected SysML output files"),
    coverage: z.object({
      targetFiles: z.array(z.string()).describe("All files matching patterns for this cycle"),
      totalCount: z.number().describe("Total number of target files"),
    }).optional().describe("Coverage tracking for comprehensive file reading"),
    entityTracking: z.object({
      requirements: z.object({ lastId: z.number() }).optional(),
      entities: z.object({ lastId: z.number() }).optional(),
      operations: z.object({ lastId: z.number() }).optional(),
      security: z.object({ lastId: z.number() }).optional(),
      nfr: z.object({ lastId: z.number() }).optional(),
    }).optional().describe("Track last assigned IDs for sequential numbering"),
  })).describe("Cycle configurations keyed by cycle number"),
  statistics: z.object({
    totalFiles: z.number().optional(),
    relevantFiles: z.number().optional(),
  }).optional().describe("Overall statistics"),
  discoveredEntities: z.array(z.string()).optional()
    .describe("Entity names discovered from model/entity files"),
  discoveredDomains: z.array(z.string()).optional()
    .describe("Domain names discovered from controllers/services"),
});

export const manifestWrite = createGadget({
  name: "ManifestWrite",
  maxConcurrent: 1,
  description: `Write or update the discovery manifest for subsequent cycles.

**Usage:**
ManifestWrite(manifest={ version: 1, project: {...}, cycles: {...} })

The manifest contains:
- Project metadata (name, language, framework)
- Per-cycle sourceFiles lists (glob patterns supported)
- Expected outputs for validation

**IMPORTANT**:
- Use "cycle1", "cycle2", etc. as keys (NOT "1", "2", etc.)
- sourceFiles patterns should cover source files (>=${MIN_MANIFEST_COVERAGE}% coverage by default, config files auto-excluded)
- Config files (package.json, tsconfig.json, etc.) are automatically excluded from coverage calculation

**Cycle purposes and typical sourceFiles:**
- cycle1 (Context): README, docs, configs → context/*.sysml
- cycle2 (Structure): Components, modules, routes → structure/*.sysml
- cycle3 (Data): Models, schemas, types, DTOs → data/*.sysml
- cycle4 (Behavior): Services, controllers, hooks, utils, state → behavior/*.sysml
- cycle5 (Verification): Tests, CI/CD configs → verification/*.sysml
- cycle6 (Analysis): Performance, security, observability → analysis/*.sysml

**COMPREHENSIVE EXAMPLE** (TypeScript monorepo with frontend + backend):

ManifestWrite(manifest={
  version: 1,
  discoveredAt: "2026-01-23T10:00:00.000Z",
  project: {
    name: "car-dealership",
    primaryLanguage: "typescript",
    framework: "express+react",
    architectureStyle: "monorepo"
  },
  cycles: {
    "cycle1": {
      name: "Context & Boundaries",
      sourceFiles: [
        "README.md",
        "package.json",
        "apps/*/package.json",
        "tsconfig.json",
        "docker-compose.yml",
        ".github/workflows/*.yml"
      ],
      expectedOutputs: ["context/boundaries.sysml", "context/stakeholders.sysml"]
    },
    "cycle2": {
      name: "Structure",
      sourceFiles: [
        "apps/backend/src/app.ts",
        "apps/backend/src/routes/**/*.ts",
        "apps/backend/src/middleware/**/*.ts",
        "apps/frontend/src/App.tsx",
        "apps/frontend/src/main.tsx",
        "apps/frontend/src/routes/**/*.tsx",
        "apps/frontend/src/components/**/*.tsx",
        "apps/frontend/src/pages/**/*.tsx",
        "apps/frontend/src/layouts/**/*.tsx"
      ],
      expectedOutputs: ["structure/components.sysml", "structure/modules.sysml"]
    },
    "cycle3": {
      name: "Data Model",
      sourceFiles: [
        "prisma/schema.prisma",
        "apps/backend/src/models/**/*.ts",
        "apps/backend/src/entities/**/*.ts",
        "apps/backend/src/dto/**/*.ts",
        "apps/frontend/src/types/**/*.ts",
        "apps/shared/src/types/**/*.ts"
      ],
      expectedOutputs: ["data/entities.sysml", "data/relationships.sysml"]
    },
    "cycle4": {
      name: "Behavior",
      sourceFiles: [
        "apps/backend/src/services/**/*.ts",
        "apps/backend/src/controllers/**/*.ts",
        "apps/backend/src/utils/**/*.ts",
        "apps/frontend/src/services/**/*.ts",
        "apps/frontend/src/hooks/**/*.ts",
        "apps/frontend/src/store/**/*.ts",
        "apps/frontend/src/utils/**/*.ts",
        "apps/frontend/src/context/**/*.tsx"
      ],
      expectedOutputs: ["behavior/operations.sysml", "behavior/handlers.sysml", "behavior/states.sysml"]
    },
    "cycle5": {
      name: "Verification",
      sourceFiles: [
        "apps/backend/test/**/*.ts",
        "apps/backend/src/**/*.spec.ts",
        "apps/backend/src/**/*.test.ts",
        "apps/frontend/src/**/*.test.tsx",
        "apps/frontend/src/**/*.spec.tsx",
        "e2e/**/*.ts",
        ".github/workflows/ci.yml"
      ],
      expectedOutputs: ["verification/test-mapping.sysml"]
    },
    "cycle6": {
      name: "Analysis",
      sourceFiles: [
        "apps/backend/src/middleware/auth*.ts",
        "apps/backend/src/middleware/rate*.ts",
        "apps/backend/src/config/**/*.ts",
        "apps/frontend/src/config/**/*.ts",
        "docker-compose.yml",
        "Dockerfile*"
      ],
      expectedOutputs: ["analysis/security.sysml", "analysis/deployment.sysml"]
    }
  },
  statistics: {
    totalFiles: 150,
    relevantFiles: 108
  }
})

**Common patterns by file type:**
- Components: "src/components/**/*.tsx", "apps/*/src/components/**/*.tsx"
- Services: "src/services/**/*.ts", "apps/backend/src/services/**/*.ts"
- Hooks: "src/hooks/**/*.ts", "apps/frontend/src/hooks/*.ts"
- State/Store: "src/store/**/*.ts", "src/context/**/*.tsx"
- Utils: "src/utils/**/*.ts", "src/lib/**/*.ts"
- Tests: "**/*.test.ts", "**/*.spec.ts", "test/**/*.ts"
- Config: "*.config.ts", "*.config.js", "config/**/*.ts"`,
  schema: z.object({
    reason: z.string().describe(GADGET_REASON_DESCRIPTION),
    manifest: z.preprocess(
      (val) => {
        // If it's already an object, return as-is
        if (typeof val === "object" && val !== null) {
          return val;
        }
        // If it's a string, try to parse as JSON
        if (typeof val === "string") {
          try {
            return JSON.parse(val);
          } catch {
            return val; // Let Zod handle the validation error
          }
        }
        return val;
      },
      manifestObjectSchema
    ).describe("The manifest object (accepts JSON string or object)"),
  }),
  execute: async ({ reason: _reason, manifest }) => {
    // Check manifest coverage before writing
    const coverage = await checkManifestCoverage(manifest as Manifest);

    if (coverage.coveragePercent < MIN_MANIFEST_COVERAGE) {
      // Generate suggestions for uncovered files
      const suggestions = suggestPatternsForUncoveredFiles(coverage.notCoveredFiles);

      let errorMsg = `ERROR: Manifest coverage too low (${coverage.coveragePercent}% < ${MIN_MANIFEST_COVERAGE}% threshold)\n\n`;
      errorMsg += `Discovered ${coverage.discoveredFiles.length} source files in repository.\n`;
      errorMsg += `Manifest patterns cover ${coverage.coveredByPatterns.length} files.\n`;
      errorMsg += `Missing ${coverage.notCoveredFiles.length} files:\n\n`;

      // Show uncovered files (up to 30)
      const displayCount = Math.min(coverage.notCoveredFiles.length, 30);
      for (let i = 0; i < displayCount; i++) {
        errorMsg += `  - ${coverage.notCoveredFiles[i]}\n`;
      }
      if (coverage.notCoveredFiles.length > 30) {
        errorMsg += `  ... and ${coverage.notCoveredFiles.length - 30} more\n`;
      }

      // Add suggestions
      if (suggestions.length > 0) {
        errorMsg += `\nSuggested patterns to add:\n`;
        for (const suggestion of suggestions) {
          errorMsg += `  - ${suggestion}\n`;
        }
      }

      errorMsg += `\nAdd patterns to appropriate cycles and call ManifestWrite again.`;

      return errorMsg;
    }

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
      totalCycleFiles += manifest.cycles[key].sourceFiles?.length ?? 0;
    }

    // Summarize sourceFiles
    const sourceFilesInfo: string[] = [];
    for (const key of cycleKeys) {
      const cycle = manifest.cycles[key];
      if (cycle.sourceFiles && cycle.sourceFiles.length > 0) {
        sourceFilesInfo.push(`Cycle ${key}: ${cycle.sourceFiles.length} patterns`);
      }
    }

    let result = `Wrote manifest to ${MANIFEST_PATH}\n`;
    result += `  Version: ${manifest.version}\n`;
    result += `  Project: ${manifest.project.name} (${manifest.project.primaryLanguage})\n`;
    result += `  Cycles defined: ${cycleKeys.join(", ")}\n`;
    result += `  Total file entries: ${totalCycleFiles}\n`;
    result += `  Manifest coverage: ${coverage.coveragePercent}% (${coverage.coveredByPatterns.length}/${coverage.discoveredFiles.length} files)`;

    if (sourceFilesInfo.length > 0) {
      result += `\n  Source file patterns:\n    ${sourceFilesInfo.join("\n    ")}`;
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
        if (cycle.sourceFiles && cycle.sourceFiles.length > 0) {
          output += `     Source files: ${cycle.sourceFiles.length} patterns\n`;
          for (const pattern of cycle.sourceFiles.slice(0, 5)) {
            output += `       - ${pattern}\n`;
          }
          if (cycle.sourceFiles.length > 5) {
            output += `       ... +${cycle.sourceFiles.length - 5} more\n`;
          }
        }
      }

      return output;
    } catch {
      return `Error: Manifest not found at ${MANIFEST_PATH}. Run Cycle 0 to generate it.`;
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
 * Get source files for a specific cycle from the manifest.
 * Returns null if manifest doesn't exist or cycle has no sourceFiles.
 */
export async function getManifestCycleSourceFiles(cycle: number): Promise<string[] | null> {
  const manifest = await loadManifest();
  if (!manifest) return null;

  const cycleData = findCycleData(manifest, cycle);
  if (!cycleData || !cycleData.sourceFiles) return null;

  return cycleData.sourceFiles;
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

/**
 * Scan directory recursively for .sysml files.
 */
async function scanSysmlFilesInDir(dir: string, prefix: string): Promise<string[]> {
  const files: string[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        files.push(...await scanSysmlFilesInDir(join(dir, entry.name), relativePath));
      } else if (entry.name.endsWith(".sysml")) {
        files.push(relativePath);
      }
    }
  } catch { /* directory doesn't exist */ }
  return files;
}

/**
 * Sync manifest expectedOutputs with actual files on disk for a cycle.
 * This ensures files created during a cycle are registered in the manifest.
 */
export async function syncManifestOutputs(
  cycle: number,
  basePath: string = "."
): Promise<{ added: string[]; total: number }> {
  const manifest = await loadManifest();
  if (!manifest) return { added: [], total: 0 };

  const cycleKey = `cycle${cycle}`;
  const cycleData = manifest.cycles[cycleKey];
  if (!cycleData) return { added: [], total: 0 };

  // Map cycle to output directory
  const outputDirs: Record<number, string> = {
    1: "context", 2: "structure", 3: "data",
    4: "behavior", 5: "verification", 6: "analysis"
  };
  const outputDir = outputDirs[cycle];
  if (!outputDir) return { added: [], total: 0 };

  // Scan for all .sysml files in the cycle's output directory
  const sysmlDir = join(basePath, ".sysml", outputDir);
  const actualFiles = await scanSysmlFilesInDir(sysmlDir, outputDir);

  // Get current expected outputs
  const currentOutputs = new Set(cycleData.expectedOutputs ?? []);
  const added: string[] = [];

  for (const file of actualFiles) {
    // Skip index files
    if (file.endsWith("/_index.sysml")) continue;
    if (!currentOutputs.has(file)) {
      currentOutputs.add(file);
      added.push(file);
    }
  }

  // Write updated manifest if changes
  if (added.length > 0) {
    cycleData.expectedOutputs = Array.from(currentOutputs).sort();
    await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2), "utf-8");
  }

  return { added, total: currentOutputs.size };
}
