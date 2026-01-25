import { Command, Flags } from "@oclif/core";
import { AgentBuilder, LLMist } from "llmist";
import { mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import fg from "fast-glob";
import chalk from "chalk";

import {
  sysmlCreate,
  sysmlWrite,
  sysmlRead,
  sysmlList,
  projectMetaRead,
  fileDiscoverCustom,
  readFiles,
  readDirs,
  ripGrep,
  manifestWrite,
  manifestRead,
  loadManifest,
  getManifestDirectoryPatterns,
  getManifestCycleSourceFiles,
  enumerateDirectories,
  fileViewerNextFileSet,
  setCoverageContext,
} from "../gadgets/index.js";
import {
  checkCycleCoverage,
  formatCoverageResult,
  CYCLE_OUTPUT_DIRS,
  type CoverageResult,
} from "../lib/sysml/index.js";
import { parsePathList } from "../lib/command-utils.js";
import { extractDiffFromResult } from "../lib/diff-utils.js";
import { Output } from "../lib/output.js";
import { render } from "../lib/templates.js";
import {
  agentFlags,
  configureBuilder,
  createTextBlockState,
  endTextBlock,
  withWorkingDirectory,
} from "../lib/command-utils.js";
import {
  discoverProject,
  generateInitialFiles,
  generateDataModelTemplate,
  cycleNames,
  cycleGoals,
  getCyclePatterns,
  SCHEMA_PRIORITY_PATTERNS,
  type ProjectMetadata,
} from "../lib/sysml/index.js";
import { runSysml2Multi, validateModelFull, type Sysml2MultiDiagnostic } from "../lib/sysml/sysml2-cli.js";
import { estimateTokens, formatTokens } from "../lib/formatting.js";
import micromatch from "micromatch";

const TOTAL_CYCLES = 6;  // Cycles 1-6 (Cycle 0 is special discovery cycle)
const SYSML_DIR = ".sysml";

/**
 * Cycle → SysML directory mapping.
 * Each cycle only sees output from previous cycles to enforce cycle boundaries.
 * This prevents the LLM from seeing empty templates for future cycles
 * and attempting to populate them prematurely.
 *
 * Cycle 0 is special: it discovers the repository and creates a manifest.
 */
const CYCLE_SYSML_PATTERNS: Record<number, string[]> = {
  0: ["SysMLPrimitives.sysml", "_project.sysml"],  // Cycle 0: Discovery - no prior SysML output
  1: ["SysMLPrimitives.sysml", "_project.sysml"],  // Primitives only
  2: ["SysMLPrimitives.sysml", "_project.sysml", "context/**/*.sysml"],  // + Cycle 1 output
  3: ["SysMLPrimitives.sysml", "_project.sysml", "context/**/*.sysml", "structure/**/*.sysml"],  // + Cycle 2
  4: ["SysMLPrimitives.sysml", "_project.sysml", "context/**/*.sysml", "structure/**/*.sysml", "data/**/*.sysml"],  // + Cycle 3
  5: ["SysMLPrimitives.sysml", "_project.sysml", "context/**/*.sysml", "structure/**/*.sysml", "data/**/*.sysml", "behavior/**/*.sysml"],  // + Cycle 4
  6: ["**/*.sysml"],  // Full model for final analysis
};

interface CycleState {
  cycle: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cost: number;
  filesWritten: number;
  coverage?: {
    targetFiles: number;
    readFiles: number;
    percentage: number;
  };
}

/**
 * Entity created during SysML generation.
 */
interface CreatedEntity {
  type: string;   // e.g., "item def", "enum def", "requirement def", "action def"
  name: string;   // e.g., "User", "OrderStatus", "FR001"
  file: string;   // e.g., "data/entities.sysml"
}

/**
 * State for iterative multi-turn cycle processing.
 * Uses seed+explore model: LLM discovers files rather than pre-computed list.
 */
interface CycleIterationState {
  readFiles: Set<string>;        // Files read so far (tracked)
  currentBatch: string[];        // Files in current FileViewer
  turnCount: number;
  maxTurns: number;              // Safety limit
  createdEntities: CreatedEntity[];  // Entities created so far (to prevent duplicates)
  // NOTE: pendingFiles removed - LLM now discovers files via exploration
}

/**
 * Parse SysML content to extract entity definitions.
 */
function extractEntitiesFromSysml(content: string, file: string): CreatedEntity[] {
  const entities: CreatedEntity[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();

    // Match item/part/action/state/analysis definitions
    const itemMatch = trimmed.match(/^(item|part|action|state|analysis)\s+def\s+(\w+)/);
    if (itemMatch) {
      entities.push({ type: `${itemMatch[1]} def`, name: itemMatch[2], file });
    }

    // Match enum definitions
    const enumMatch = trimmed.match(/^enum\s+def\s+(\w+)/);
    if (enumMatch) {
      entities.push({ type: "enum def", name: enumMatch[1], file });
    }

    // Match requirement definitions
    const reqMatch = trimmed.match(/^requirement\s+def\s+(\w+)/);
    if (reqMatch) {
      entities.push({ type: "requirement def", name: reqMatch[1], file });
    }
  }

  return entities;
}

/**
 * Manifest hints to guide LLM exploration during a cycle.
 */
interface ManifestHints {
  directories: string[];         // Relevant directories for this cycle
  filePatterns: string[] | null; // File patterns to search (e.g., "src/**/*.service.ts")
  sourceFiles: string[] | null;  // Source files to cover (supports glob patterns)
  expectedOutputs: string[] | null;       // Expected SysML outputs
  expectedFileCount: number | null;       // Estimated number of files to analyze
}

interface IngestState {
  currentCycle: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;
  totalCost: number;
  totalFilesWritten: number;
  cycleHistory: CycleState[];
  metadata: ProjectMetadata | null;
}

/**
 * Read existing SysML files from the model, filtered by cycle.
 * Each cycle only sees output from previous cycles to enforce boundaries.
 * @param cycle - The current cycle number (1-6)
 */
async function readExistingModel(cycle: number): Promise<string> {
  const patterns = CYCLE_SYSML_PATTERNS[cycle] ?? ["**/*.sysml"];

  const files = await fg(patterns, {
    cwd: SYSML_DIR,
    onlyFiles: true,
  });

  if (files.length === 0) {
    return "";
  }

  const contents: string[] = [];
  for (const file of files.sort()) {
    try {
      const content = await readFile(join(SYSML_DIR, file), "utf-8");
      contents.push(`=== ${file} ===\n${content}`);
    } catch {
      // Skip unreadable files
    }
  }

  return contents.join("\n\n");
}

/**
 * Check if a file matches any of the high-priority schema patterns.
 */
function isHighPrioritySchema(file: string): boolean {
  return micromatch.isMatch(file, SCHEMA_PRIORITY_PATTERNS);
}

/**
 * Expand glob patterns from manifest files array.
 * Handles both literal files and glob patterns.
 */
async function expandManifestGlobs(
  files: string[],
  maxFiles: number
): Promise<string[]> {
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

  for (const pattern of files) {
    // Check if it's a glob pattern or literal file
    if (pattern.includes("*") || pattern.includes("?") || pattern.includes("{")) {
      // It's a glob pattern
      const matched = await fg(pattern, {
        cwd: ".",
        ignore: ignorePatterns,
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
 * Find cycle data in manifest (handles both "cycle1" and "1" key formats).
 */
function findManifestCycle(manifest: { cycles: Record<string, { files?: string[]; sourceFiles?: string[]; expectedOutputs?: string[] }> }, cycle: number) {
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
 * Get manifest hints for a cycle to guide LLM exploration.
 * Returns directories, sourceFiles, and file patterns that help the LLM discover relevant files.
 */
async function getManifestHintsForCycle(cycle: number, language?: string): Promise<ManifestHints | null> {
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
          filePatterns.push(...patterns.map(p => `${dir.path}/${p}`));
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

  // Calculate expected file count from sourceFiles patterns
  const ignorePatterns = [
    "**/node_modules/**",
    "**/vendor/**",
    "**/target/**",
    "**/dist/**",
    "**/build/**",
    "**/.git/**",
    "**/.sysml/**",
  ];

  let expectedFileCount: number | null = null;

  // Try to expand sourceFiles patterns to get actual count
  if (sourceFiles && sourceFiles.length > 0) {
    const expandedFiles: string[] = [];
    for (const pattern of sourceFiles) {
      if (pattern.includes("*")) {
        const matches = await fg(pattern, {
          cwd: ".",
          ignore: ignorePatterns,
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
        ignore: ignorePatterns,
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

/**
 * Expand directory patterns from manifest v2 format.
 * For each directory, expands patterns like "*.service.ts" to actual files.
 */
async function expandDirectoryPatterns(
  dirPatterns: { dirPath: string; patterns: string[] }[],
  maxFiles: number
): Promise<string[]> {
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

  for (const { dirPath, patterns } of dirPatterns) {
    for (const pattern of patterns) {
      // Combine directory path with pattern
      const fullPattern = `${dirPath}/${pattern}`;
      const matched = await fg(fullPattern, {
        cwd: ".",
        ignore: ignorePatterns,
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
async function getFilesForCycle(
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

  const ignorePatterns = [
    "**/node_modules/**",
    "**/vendor/**",
    "**/target/**",
    "**/dist/**",
    "**/build/**",
    "**/.git/**",
    "**/.sysml/**",
  ];

  // Only include schema files for Cycle 3 (Data & Types)
  if (cycle === 3) {
    // First, find all schema files (high priority for data extraction)
    const schemaFiles = await fg(SCHEMA_PRIORITY_PATTERNS, {
      cwd: ".",
      ignore: ignorePatterns,
      onlyFiles: true,
    });

    // Then find other files matching cycle patterns
    const otherFiles = await fg(patterns, {
      cwd: ".",
      ignore: ignorePatterns,
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
    ignore: ignorePatterns,
    onlyFiles: true,
  });

  return files.sort().slice(0, maxFiles);
}

/**
 * Read file contents for context.
 * Schema files (*.prisma, *.graphql, etc.) get a higher character limit (100k)
 * to ensure complete extraction of all models and enums.
 */
async function readFileContents(files: string[]): Promise<string> {
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
function selectInitialBatch(
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

/**
 * Verify cycle coverage and log results.
 */
function verifyCycleCoverage(
  cycle: number,
  readFiles: Set<string>,
  targetFiles: string[],
  out: Output,
  threshold: number = 95
): { targetFiles: number; readFiles: number; percentage: number } {
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
async function verifyCoverageHeuristically(
  cycle: number,
  readFiles: Set<string>,
  language?: string
): Promise<{ readFiles: number; estimated: string; potentialFiles: number }> {
  const ignorePatterns = [
    "**/node_modules/**",
    "**/vendor/**",
    "**/target/**",
    "**/dist/**",
    "**/build/**",
    "**/.git/**",
    "**/.sysml/**",
  ];

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
    ignore: ignorePatterns,
    onlyFiles: true,
  });

  const readFromPotential = potentialFiles.filter((f) => readFiles.has(f)).length;
  const percentage = potentialFiles.length > 0
    ? Math.round((readFromPotential / potentialFiles.length) * 100)
    : 100;

  return {
    readFiles: readFiles.size,
    estimated: `~${percentage}% of ${potentialFiles.length} pattern-matched files`,
    potentialFiles: potentialFiles.length,
  };
}

export default class Ingest extends Command {
  static description = "Reverse engineer a codebase into SysML v2 models";

  static examples = [
    "<%= config.bin %> ingest",
    "<%= config.bin %> ingest --cycle 0",
    "<%= config.bin %> ingest --cycle 1",
    "<%= config.bin %> ingest --cycle 3 --model opus",
    "<%= config.bin %> ingest --purge",
    "<%= config.bin %> ingest --skip-cycle0",
    "<%= config.bin %> ingest -v",
  ];

  static flags = {
    ...agentFlags,
    cycle: Flags.integer({
      char: "c",
      description: "Run only a specific cycle (0-6). Cycle 0 is repository discovery.",
      min: 0,
      max: 6,
    }),
    purge: Flags.boolean({
      description: "Remove existing .sysml directory before starting",
      default: false,
    }),
    "skip-init": Flags.boolean({
      description: "Skip initial file generation (use existing model)",
      default: false,
    }),
    "skip-cycle0": Flags.boolean({
      description: "Skip Cycle 0 (repository discovery). Uses existing manifest or falls back to hardcoded patterns.",
      default: false,
    }),
    "max-files-per-turn": Flags.integer({
      char: "b",
      description: "Batch size for file viewer (default: 8)",
      default: 8,
      min: 3,
      max: 15,
    }),
    "coverage-threshold": Flags.integer({
      description: "Minimum coverage % required per cycle (default: 95)",
      default: 95,
      min: 0,
      max: 100,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Ingest);
    const out = new Output({ verbose: flags.verbose });

    const { restore } = withWorkingDirectory(flags.path, out);

    try {
      // Purge existing model if requested
      if (flags.purge) {
        out.info("Purging existing .sysml directory...");
        try {
          await rm(SYSML_DIR, { recursive: true, force: true });
          out.success("Removed existing SysML model");
        } catch {
          // Directory doesn't exist, that's fine
        }
      }

      // Initialize state
      const state: IngestState = {
        currentCycle: flags.cycle ?? 1,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCachedTokens: 0,
        totalCost: 0,
        totalFilesWritten: 0,
        cycleHistory: [],
        metadata: null,
      };

      // Discover project metadata
      out.info("Discovering project metadata...");
      state.metadata = await discoverProject(".");
      out.success(`Discovered: ${state.metadata.name} (${state.metadata.primaryLanguage})`);

      if (flags.verbose) {
        console.log(`  Type: ${state.metadata.projectType}`);
        console.log(`  Framework: ${state.metadata.framework ?? "none"}`);
        console.log(`  Architecture: ${state.metadata.architectureStyle}`);
      }

      // Generate initial files if not skipping
      if (!flags["skip-init"]) {
        out.info("Generating initial SysML model structure...");
        await this.generateInitialModel(state.metadata, out, flags.verbose);

        // Validate initial files before continuing
        const validationPassed = await this.validateInitialModel(out, flags.verbose);
        if (!validationPassed) {
          out.error("Initial SysML files have validation errors. Fix these before continuing.");
          return;
        }
      }

      // Run cycles
      const client = new LLMist();

      // Determine if we should run Cycle 0
      const runCycle0 = !flags["skip-cycle0"] && (
        flags.cycle === 0 ||  // Explicitly requested Cycle 0
        flags.cycle === undefined  // Full run (no specific cycle requested)
      );

      // Run Cycle 0 (repository discovery) if needed
      if (runCycle0) {
        const cycle0Result = await this.runCycle0(client, state, flags, out);
        state.cycleHistory.push(cycle0Result);
        state.totalInputTokens += cycle0Result.inputTokens;
        state.totalOutputTokens += cycle0Result.outputTokens;
        state.totalCachedTokens += cycle0Result.cachedTokens;
        state.totalCost += cycle0Result.cost;

        // Regenerate data/_index.sysml with discovered entity stubs
        const manifest = await loadManifest();
        if (manifest?.discoveredEntities || manifest?.discoveredDomains) {
          const dataModel = generateDataModelTemplate(
            manifest.discoveredEntities,
            manifest.discoveredDomains
          );
          await writeFile(
            join(SYSML_DIR, "data/_index.sysml"),
            dataModel,
            "utf-8"
          );
          if (flags.verbose) {
            const entityCount = manifest.discoveredEntities?.length ?? 0;
            const domainCount = manifest.discoveredDomains?.length ?? 0;
            console.log(`\x1b[2m   Regenerated data/_index.sysml with ${entityCount} entity stubs, ${domainCount} domains\x1b[0m`);
          }
        }
      }

      // If only Cycle 0 was requested, we're done
      if (flags.cycle === 0) {
        this.printSummary(state, flags.verbose);
        return;
      }

      // Determine cycles 1-6 to run
      const startCycle = flags.cycle ?? 1;
      const endCycle = flags.cycle ?? TOTAL_CYCLES;

      for (let cycle = startCycle; cycle <= endCycle; cycle++) {
        state.currentCycle = cycle;

        // Set coverage context for the FileViewerNextFileSet gadget
        setCoverageContext({
          cycle,
          basePath: ".",
          minCoveragePercent: flags["coverage-threshold"],
        });

        const cycleResult = await this.runCycle(client, state, flags, out);

        // Post-cycle coverage validation and retry
        const coverage = await checkCycleCoverage(cycle, ".");
        if (coverage.missingFiles.length > 0 && coverage.coveragePercent < flags["coverage-threshold"]) {
          if (flags.verbose) {
            out.warn(`Cycle ${cycle} incomplete: ${coverage.missingFiles.length} files not covered (${coverage.coveragePercent}%)`);
          }

          // Run retry phase
          const retryResult = await this.runCycleRetry(
            client,
            state,
            flags,
            out,
            coverage
          );

          // Accumulate retry results
          cycleResult.inputTokens += retryResult.inputTokens;
          cycleResult.outputTokens += retryResult.outputTokens;
          cycleResult.cachedTokens += retryResult.cachedTokens;
          cycleResult.cost += retryResult.cost;
          cycleResult.filesWritten += retryResult.filesWritten;
        }

        // Clear coverage context after cycle completes
        setCoverageContext(null);

        state.cycleHistory.push(cycleResult);

        state.totalInputTokens += cycleResult.inputTokens;
        state.totalOutputTokens += cycleResult.outputTokens;
        state.totalCachedTokens += cycleResult.cachedTokens;
        state.totalCost += cycleResult.cost;
        state.totalFilesWritten += cycleResult.filesWritten;
      }

      // Print summary
      this.printSummary(state, flags.verbose);
    } finally {
      restore();
    }
  }

  private async generateInitialModel(
    metadata: ProjectMetadata,
    out: Output,
    verbose: boolean
  ): Promise<void> {
    const files = generateInitialFiles(metadata);

    // Create directories
    await mkdir(SYSML_DIR, { recursive: true });
    await mkdir(join(SYSML_DIR, "context"), { recursive: true });
    await mkdir(join(SYSML_DIR, "structure"), { recursive: true });
    await mkdir(join(SYSML_DIR, "data"), { recursive: true });
    await mkdir(join(SYSML_DIR, "behavior"), { recursive: true });
    await mkdir(join(SYSML_DIR, "verification"), { recursive: true });
    await mkdir(join(SYSML_DIR, "analysis"), { recursive: true });

    // Write files
    for (const [path, content] of Object.entries(files)) {
      const fullPath = join(SYSML_DIR, path);
      await writeFile(fullPath, content, "utf-8");
      if (verbose) {
        console.log(`  Created: ${fullPath}`);
      }
    }

    out.success(`Created ${Object.keys(files).length} initial SysML files`);
  }

  private async validateInitialModel(
    out: Output,
    verbose: boolean
  ): Promise<boolean> {
    // Collect all .sysml files recursively
    const files: string[] = [];

    const collectFiles = async (dir: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          await collectFiles(fullPath);
        } else if (entry.name.endsWith(".sysml")) {
          files.push(fullPath);
        }
      }
    };

    try {
      await collectFiles(SYSML_DIR);
    } catch {
      // Directory doesn't exist yet
      return true;
    }

    if (files.length === 0) {
      return true;
    }

    if (verbose) {
      console.log(`● Validating ${files.length} initial SysML files...`);
    }

    try {
      const result = await runSysml2Multi(files);

      if (!result.success) {
        const errors = result.diagnostics.filter(d => d.severity === "error");

        if (errors.length > 0) {
          out.error(`Validation failed with ${errors.length} error(s):`);
          for (const err of errors.slice(0, 10)) {
            console.log(`  ${err.file}:${err.line}:${err.column}: ${err.message}`);
          }
          if (errors.length > 10) {
            console.log(`  ... and ${errors.length - 10} more errors`);
          }
          return false;
        }
      }

      if (verbose) {
        out.success("Initial SysML files validated successfully");
      }
      return true;
    } catch (err) {
      // sysml2 not available - skip validation with warning
      if (verbose) {
        console.log(`⚠ Skipping validation: ${err instanceof Error ? err.message : String(err)}`);
      }
      return true;
    }
  }

  private async runCycle(
    client: LLMist,
    state: IngestState,
    flags: {
      model: string;
      verbose: boolean;
      rpm: number;
      tpm: number;
      "max-iterations": number;
      "max-files-per-turn": number;
      "coverage-threshold": number;
    },
    out: Output
  ): Promise<CycleState> {
    const cycle = state.currentCycle;
    const cycleName = cycleNames[cycle] ?? `Cycle ${cycle}`;
    const cycleGoal = cycleGoals[cycle] ?? "";
    const batchSize = flags["max-files-per-turn"];

    // Display cycle header
    if (flags.verbose) {
      console.log();
      console.log(`\x1b[34m━━━ Cycle ${cycle}/${TOTAL_CYCLES}: ${cycleName} ━━━\x1b[0m`);
      console.log(`\x1b[2m   Goal: ${cycleGoal}\x1b[0m`);
    } else {
      console.log(`[Cycle ${cycle}/${TOTAL_CYCLES}] ${cycleName}`);
    }

    // Get seed files (can be empty - that's OK now with exploration model)
    const seedFiles = await getFilesForCycle(cycle, state.metadata?.primaryLanguage, batchSize);

    // Get manifest hints for this cycle (directories, counts)
    const manifestHints = await getManifestHintsForCycle(cycle, state.metadata?.primaryLanguage);

    if (flags.verbose) {
      if (seedFiles.length > 0) {
        console.log(`\x1b[2m   Seed files: ${seedFiles.length}\x1b[0m`);
      } else {
        console.log(`\x1b[2m   No seed files - LLM will explore using hints\x1b[0m`);
      }
      if (manifestHints?.directories && manifestHints.directories.length > 0) {
        console.log(`\x1b[2m   Hint directories: ${manifestHints.directories.length}\x1b[0m`);
      }
      if (manifestHints?.expectedFileCount) {
        console.log(`\x1b[2m   Expected files: ~${manifestHints.expectedFileCount}\x1b[0m`);
      }
    }

    // Initialize iteration state (seed+explore model - no pendingFiles)
    const iterState: CycleIterationState = {
      readFiles: new Set(),
      currentBatch: seedFiles,  // May be empty - that's OK
      turnCount: 0,
      maxTurns: 100,  // Safety limit
      createdEntities: [],  // Track what we've created to avoid duplicates
    };

    // Read stable content once (for caching)
    const existingModel = await readExistingModel(cycle);
    const repoMap = await readDirs.execute({
      paths: ".",
      depth: 4,
      includeGitIgnored: false,
    }) as string;

    // Get cycle-specific prompt (stable within cycle)
    const cyclePrompt = render(`sysml/cycle${cycle}`, {
      metadata: state.metadata,
      files: seedFiles,
      sourceFiles: manifestHints?.sourceFiles ?? null,
      totalCount: seedFiles.length,  // Initial count, may discover more
      isIterative: true,
    });

    // Build system prompt
    const systemPrompt = render("sysml/system", {});

    // Read initial batch contents (may be empty)
    let fileViewerContents = seedFiles.length > 0
      ? await readFileContents(seedFiles)
      : "";
    const previousTurnSummary: string[] = [];

    // Initialize cycle state for tracking
    const cycleState: CycleState = {
      cycle,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      cost: 0,
      filesWritten: 0,
    };

    let totalTurns = 0;
    let llmDone = false;

    // Show initial context composition
    if (flags.verbose) {
      const contextTokens = {
        system: estimateTokens(systemPrompt),
        repoMap: estimateTokens(repoMap),
        existingModel: estimateTokens(existingModel),
        cyclePrompt: estimateTokens(cyclePrompt),
      };
      const totalContext = contextTokens.system + contextTokens.repoMap + contextTokens.existingModel + contextTokens.cyclePrompt;

      console.log(`\x1b[2m   Base context: ${formatTokens(totalContext)} tokens (cached across turns)\x1b[0m`);
    }

    // Iterative turn loop - LLM signals done OR maxTurns reached
    while (!llmDone && iterState.turnCount < iterState.maxTurns) {
      iterState.turnCount++;

      // Build user message with current state and manifest hints
      const userMessage = render("sysml/user", {
        cycle,
        totalCycles: TOTAL_CYCLES,
        cyclePrompt,
        repoMap,
        existingModel: existingModel || undefined,
        fileViewerContents,
        manifestHints,  // NEW: directories & counts to guide exploration
        readCount: iterState.readFiles.size,
        previousTurnSummary: previousTurnSummary.length > 0 ? previousTurnSummary : undefined,
        createdEntities: iterState.createdEntities.length > 0 ? iterState.createdEntities : undefined,
        isIterative: true,
        isLastCycle: cycle === TOTAL_CYCLES,
        batchSize,
      });

      // Compute documentation coverage for trailing template
      // This shows files missing @SourceFile annotations (not just unread files)
      const docCoverage = await checkCycleCoverage(cycle, ".");

      // Run single turn with FileViewerNextFileSet gadget
      const turnResult = await this.runSingleCycleTurn(
        client,
        systemPrompt,
        userMessage,
        iterState,
        cycleState,
        flags,
        out,
        {
          expectedCount: manifestHints?.expectedFileCount ?? seedFiles.length,
          cycle,
          language: state.metadata?.primaryLanguage,
          docCoveragePercent: docCoverage.coveragePercent,
          docMissingFiles: docCoverage.missingFiles,
        }
      );

      totalTurns += turnResult.turns;

      // Track files read in this turn
      for (const file of iterState.currentBatch) {
        iterState.readFiles.add(file);
      }

      // Update summary for next turn
      if (turnResult.summary.length > 0) {
        previousTurnSummary.length = 0;
        previousTurnSummary.push(...turnResult.summary.slice(-5)); // Keep last 5 items
      }

      // Check if LLM is done (requested empty file set)
      if (turnResult.nextFiles.length === 0) {
        // Early-termination prevention: check coverage before accepting "done"
        const minFilesExpected = manifestHints?.expectedFileCount ?? 0;
        const coverageRatio = minFilesExpected > 0
          ? iterState.readFiles.size / minFilesExpected
          : 1;

        // If coverage is too low and we haven't tried many turns, force continuation
        if (coverageRatio < 0.3 && iterState.turnCount < 5 && minFilesExpected > 5) {
          if (flags.verbose) {
            console.log(`\x1b[33m   ⚠ Coverage too low (${Math.round(coverageRatio * 100)}%), auto-discovering more files...\x1b[0m`);
          }

          // Try to discover more files using patterns from manifest
          const moreFiles = await getFilesForCycle(cycle, state.metadata?.primaryLanguage, batchSize * 3);
          const unreadFiles = moreFiles.filter(f => !iterState.readFiles.has(f));

          if (unreadFiles.length > 0) {
            iterState.currentBatch = unreadFiles.slice(0, batchSize);
            fileViewerContents = await readFileContents(iterState.currentBatch);
            // Don't set llmDone - continue the loop
          } else {
            // No more files to discover, accept completion
            llmDone = true;
          }
        } else {
          llmDone = true;
        }
      } else {
        // Load next batch (LLM can request any files, including already read ones)
        iterState.currentBatch = turnResult.nextFiles.slice(0, batchSize);
        fileViewerContents = await readFileContents(iterState.currentBatch);
      }

      // Progress update
      if (flags.verbose && !llmDone) {
        const coverageStr = manifestHints?.expectedFileCount
          ? ` (~${Math.round((iterState.readFiles.size / manifestHints.expectedFileCount) * 100)}% coverage)`
          : "";
        console.log(`\x1b[2m   Progress: ${iterState.readFiles.size} files analyzed${coverageStr}\x1b[0m`);
      }
    }

    // Verify coverage heuristically (since we don't know target files upfront)
    const heuristicCoverage = await verifyCoverageHeuristically(
      cycle,
      iterState.readFiles,
      state.metadata?.primaryLanguage
    );

    // Convert to CycleState coverage format
    cycleState.coverage = {
      targetFiles: heuristicCoverage.potentialFiles,
      readFiles: heuristicCoverage.readFiles,
      percentage: heuristicCoverage.potentialFiles > 0
        ? Math.round((heuristicCoverage.readFiles / heuristicCoverage.potentialFiles) * 100)
        : 100,
    };

    // Display cycle summary
    if (flags.verbose) {
      const totalTokens = cycleState.inputTokens + cycleState.outputTokens;
      const tokensStr = formatTokens(totalTokens);
      const cachedStr = cycleState.cachedTokens > 0
        ? ` (${formatTokens(cycleState.cachedTokens)} cached)`
        : "";
      const costStr = cycleState.cost >= 0.01
        ? `$${cycleState.cost.toFixed(3)}`
        : `$${cycleState.cost.toFixed(4)}`;
      const turnsStr = totalTurns === 1 ? "1 turn" : `${totalTurns} turns`;
      const coverageStr = heuristicCoverage.estimated;

      console.log();
      console.log(`\x1b[32m✓ Cycle ${cycle} complete: ${turnsStr} · ${tokensStr} tokens${cachedStr} · ${costStr} · ${cycleState.filesWritten} files · ${coverageStr}\x1b[0m`);
    }

    return cycleState;
  }

  /**
   * Run a retry phase to cover missing files from a cycle.
   * This is called when post-cycle validation shows incomplete coverage.
   * Uses an iterative loop that continues until coverage threshold is met or maxIterations reached.
   */
  private async runCycleRetry(
    client: LLMist,
    state: IngestState,
    flags: {
      model: string;
      verbose: boolean;
      rpm: number;
      tpm: number;
      "max-iterations": number;
      "max-files-per-turn": number;
      "coverage-threshold": number;
    },
    out: Output,
    initialCoverage: CoverageResult
  ): Promise<CycleState> {
    const cycle = state.currentCycle;
    const batchSize = flags["max-files-per-turn"];
    const totalMissing = initialCoverage.missingFiles.length;

    const retryState: CycleState = {
      cycle,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      cost: 0,
      filesWritten: 0,
    };

    // Iteration state for retry phase
    const iterState = {
      readFiles: new Set<string>(),
      currentBatch: initialCoverage.missingFiles.slice(0, batchSize),
      turnCount: 0,
      maxTurns: flags["max-iterations"],
    };

    if (flags.verbose) {
      console.log();
      console.log(`\x1b[33m━━━ Cycle ${cycle} Retry Phase ━━━\x1b[0m`);
      console.log(`\x1b[2m   Missing files: ${totalMissing}\x1b[0m`);
    }

    // Read existing model for context
    const existingModel = await readExistingModel(cycle);
    const systemPrompt = render("sysml/system", {});

    let done = false;
    while (!done && iterState.turnCount < iterState.maxTurns) {
      iterState.turnCount++;

      if (flags.verbose) {
        console.log(`\x1b[2m   Retry turn ${iterState.turnCount}/${iterState.maxTurns}: ${iterState.currentBatch.length} files in batch\x1b[0m`);
      }

      // Run validation to get semantic errors
      let validationErrors: Sysml2MultiDiagnostic[] = [];
      try {
        const validation = await validateModelFull(".sysml");
        validationErrors = validation.semanticErrors;
      } catch {
        // sysml2 not available - skip validation
      }

      // Get the cycle's output directory
      const cycleOutputDir = CYCLE_OUTPUT_DIRS[cycle] || "context";

      // Create focused retry prompt
      const retryPrompt = render("sysml/retry", {
        cycle,
        cycleOutputDir,
        missingFiles: iterState.currentBatch.slice(0, 30),
        totalMissing,
        existingModel,
      });

      // Read contents of current batch
      const fileContents = await readFileContents(iterState.currentBatch);
      const userMessage = `${retryPrompt}\n\n## Files to Document\n\n${fileContents}`;

      // Run retry turn with iterative support
      const turnResult = await this.runRetryTurn(
        client,
        systemPrompt,
        userMessage,
        iterState,
        retryState,
        flags,
        out,
        validationErrors,
        totalMissing,
        cycleOutputDir
      );

      // Track read files
      for (const file of iterState.currentBatch) {
        iterState.readFiles.add(file);
      }

      // Check if LLM requested more files
      if (turnResult.nextFiles.length === 0) {
        // Re-check coverage
        const coverage = await checkCycleCoverage(cycle, ".");

        if (flags.verbose) {
          console.log(`\x1b[2m   After turn ${iterState.turnCount}: ${coverage.coveragePercent}% coverage, ${coverage.missingFiles.length} files remaining\x1b[0m`);
        }

        if (coverage.coveragePercent >= flags["coverage-threshold"]) {
          done = true;
        } else if (coverage.missingFiles.length === 0) {
          // All files are actually covered - exit
          done = true;
        } else {
          // Re-show the same missing files, they still need coverage
          // Don't filter by readFiles - the LLM may not have written metadata correctly
          iterState.currentBatch = coverage.missingFiles.slice(0, batchSize);
        }
      } else {
        // LLM requested specific files
        iterState.currentBatch = turnResult.nextFiles.slice(0, batchSize);
      }
    }

    // Final status
    if (flags.verbose) {
      const finalCoverage = await checkCycleCoverage(cycle, ".");
      if (finalCoverage.missingFiles.length > 0) {
        out.warn(`Retry phase complete: ${finalCoverage.coveragePercent}% coverage (${finalCoverage.missingFiles.length} files still missing)`);
      } else {
        out.success(`Retry phase complete: ${finalCoverage.coveragePercent}% coverage achieved`);
      }
    }

    return retryState;
  }

  /**
   * Run a single turn within the retry phase.
   * Similar to runSingleCycleTurn but optimized for retry scenarios.
   */
  private async runRetryTurn(
    client: LLMist,
    systemPrompt: string,
    userMessage: string,
    iterState: { readFiles: Set<string>; currentBatch: string[]; turnCount: number; maxTurns: number },
    retryState: CycleState,
    flags: {
      model: string;
      verbose: boolean;
      rpm: number;
      tpm: number;
      "max-iterations": number;
    },
    out: Output,
    validationErrors: Sysml2MultiDiagnostic[],
    totalMissing: number,
    cycleOutputDir: string
  ): Promise<{ nextFiles: string[]; turns: number }> {
    const textState = createTextBlockState();
    let nextFiles: string[] = [];

    // Single turn with limited iterations
    const maxTurnIterations = Math.min(flags["max-iterations"], 30);

    // Get current coverage for trailing message
    let stillMissingCount = totalMissing - iterState.readFiles.size;
    const unreadFiles: string[] = [];
    try {
      const coverage = await checkCycleCoverage(retryState.cycle, ".");
      stillMissingCount = coverage.missingFiles.length;
      unreadFiles.push(...coverage.missingFiles.filter(f => !iterState.readFiles.has(f)));
    } catch {
      // Ignore coverage check errors
    }

    let builder = new AgentBuilder(client)
      .withModel(flags.model)
      .withSystem(systemPrompt)
      .withMaxIterations(maxTurnIterations)
      .withGadgetExecutionMode("sequential")
      .withGadgets(
        sysmlCreate,
        sysmlWrite,
        sysmlRead,
        sysmlList,
        readFiles,
        readDirs,
        fileViewerNextFileSet
      );
      // Note: No .withTextOnlyHandler("terminate") - let the LLM keep trying

    builder = configureBuilder(builder, out, flags.rpm, flags.tpm)
      .withTrailingMessage(() => {
        return render("sysml/retry-trailing", {
          iteration: iterState.turnCount,
          maxIterations: iterState.maxTurns,
          cycleOutputDir,
          readCount: iterState.readFiles.size,
          remainingFiles: iterState.currentBatch.length,
          totalMissing,
          stillMissing: stillMissingCount,
          unreadFiles: unreadFiles.slice(0, 20),
          validationErrors,
        });
      });

    const agent = builder.ask(userMessage);

    // Track usage
    let turnCount = 0;
    let turnInputTokens = 0;
    let turnOutputTokens = 0;
    let turnCachedTokens = 0;
    let turnCost = 0;

    const tree = agent.getTree();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tree.onAll((event: any) => {
      if (event.type === "llm_call_complete") {
        turnCount++;
        if (event.usage) {
          turnInputTokens = event.usage.inputTokens || 0;
          turnOutputTokens = event.usage.outputTokens || 0;
          turnCachedTokens = event.usage.cachedInputTokens || 0;
          retryState.inputTokens += turnInputTokens;
          retryState.outputTokens += turnOutputTokens;
          retryState.cachedTokens += turnCachedTokens;
        }
        if (event.cost) {
          turnCost = event.cost;
          retryState.cost += turnCost;
        }

        if (flags.verbose) {
          const inputStr = formatTokens(turnInputTokens);
          const outputStr = formatTokens(turnOutputTokens);
          const cachedStr = turnCachedTokens > 0
            ? ` (${formatTokens(turnCachedTokens)} cached)`
            : "";
          const costStr = turnCost >= 0.01
            ? `$${turnCost.toFixed(3)}`
            : `$${turnCost.toFixed(4)}`;
          console.log(`\x1b[2m   ⤷ Retry ${iterState.turnCount}.${turnCount}: ${inputStr} in · ${outputStr} out${cachedStr} · ${costStr}\x1b[0m`);
        }
      }
    });

    // Stream events
    for await (const event of agent.run()) {
      if (event.type === "text") {
        if (flags.verbose) {
          textState.inTextBlock = true;
          out.thinkingChunk(event.content);
        }
      } else if (event.type === "gadget_call") {
        if (flags.verbose) {
          endTextBlock(textState, out);
          const params = event.call.parameters as Record<string, unknown>;
          out.gadgetCall(event.call.gadgetName, params);
        }
      } else if (event.type === "gadget_result") {
        const result = event.result;

        if (flags.verbose) {
          endTextBlock(textState, out);
        }

        if (result.gadgetName === "SysMLWrite" || result.gadgetName === "SysMLCreate") {
          if (result.error) {
            out.gadgetError(result.gadgetName, result.error);
          } else if (result.result) {
            retryState.filesWritten++;

            // Parse the path from result (format: "path=... status=...")
            const pathMatch = result.result.match(/^path=(\S+)/);
            const modeMatch = result.result.match(/mode=(\w+)/);
            const deltaMatch = result.result.match(/delta=([+-]?\d+ bytes)/);
            const writtenPath = pathMatch ? pathMatch[1] : result.result.split("\n")[0];
            let mode = modeMatch ? modeMatch[1] : "";
            if (!mode && result.gadgetName === "SysMLCreate") {
              mode = result.result?.includes("Reset package") ? "reset" : "create";
            }
            const delta = deltaMatch ? deltaMatch[1] : null;

            if (flags.verbose) {
              const modeStr = mode === "create" ? chalk.yellow("[new]") : mode === "reset" ? chalk.magenta("[reset]") : mode === "upsert" ? chalk.blue("[set]") : mode === "delete" ? chalk.red("[del]") : "";
              const deltaStr = delta ? (delta.startsWith("-") ? chalk.red(` (${delta})`) : chalk.dim(` (${delta})`)) : "";
              console.log(`${chalk.green("   ✓")} ${writtenPath} ${modeStr}${deltaStr}`);

              // Display colored diff if available
              const diff = extractDiffFromResult(result.result);
              if (diff) {
                const indentedDiff = diff.split("\n").map((line) => `      ${line}`).join("\n");
                console.log(indentedDiff);
              }
            } else {
              console.log(`  Wrote: ${writtenPath}`);
            }
          }
        } else if (result.gadgetName === "FileViewerNextFileSet") {
          // Parse next files from the gadget call parameters
          const params = result.parameters as { paths?: string };
          nextFiles = parsePathList(params?.paths ?? "");

          if (flags.verbose) {
            if (nextFiles.length > 0) {
              console.log(`\x1b[2m   → Next batch: ${nextFiles.length} files\x1b[0m`);
            } else {
              console.log(`\x1b[2m   → Batch complete, checking coverage\x1b[0m`);
            }
          }

          // If LLM signals completion (empty paths), break out of event loop
          if (nextFiles.length === 0) {
            break;
          }
        } else if (flags.verbose) {
          out.gadgetResult(result.gadgetName);
        }
      }
    }

    if (flags.verbose) {
      endTextBlock(textState, out);
    }

    return { nextFiles, turns: turnCount };
  }

  /**
   * Run a single turn within an iterative cycle.
   * Returns next files to process and summary of what was done.
   */
  private async runSingleCycleTurn(
    client: LLMist,
    systemPrompt: string,
    userMessage: string,
    iterState: CycleIterationState,
    cycleState: CycleState,
    flags: {
      model: string;
      verbose: boolean;
      rpm: number;
      tpm: number;
      "max-iterations": number;
    },
    out: Output,
    // Trailing message context
    trailingContext: {
      expectedCount: number;
      cycle: number;
      language?: string;
      docCoveragePercent: number;
      docMissingFiles: string[];
    }
  ): Promise<{ nextFiles: string[]; summary: string[]; turns: number }> {
    const textState = createTextBlockState();
    const summary: string[] = [];
    let nextFiles: string[] = [];

    // Single turn with limited iterations (allow some multi-step processing within turn)
    const maxTurnIterations = Math.min(flags["max-iterations"], 30);

    // Extract trailing context values
    const { expectedCount, cycle, language, docCoveragePercent, docMissingFiles } = trailingContext;

    // Run full model validation before turn to get semantic errors from previous writes
    // This surfaces errors incrementally so the agent can fix them in subsequent iterations
    let validationErrors: Sysml2MultiDiagnostic[] = [];
    try {
      const validation = await validateModelFull(".sysml");
      validationErrors = validation.semanticErrors;
    } catch {
      // sysml2 not available - skip validation
    }

    let builder = new AgentBuilder(client)
      .withModel(flags.model)
      .withSystem(systemPrompt)
      .withMaxIterations(maxTurnIterations)
      .withGadgetExecutionMode("sequential")
      .withGadgets(
        sysmlCreate,
        sysmlWrite,
        sysmlRead,
        sysmlList,
        projectMetaRead,
        fileDiscoverCustom,
        readFiles,
        readDirs,
        ripGrep,
        fileViewerNextFileSet
      )
      .withTextOnlyHandler("terminate");  // Stop when agent produces text without tool calls

    builder = configureBuilder(builder, out, flags.rpm, flags.tpm)
      .withTrailingMessage((ctx) => {
        return render("sysml/trailing", {
          iteration: ctx.iteration + 1,
          maxIterations: ctx.maxIterations,
          readCount: iterState.readFiles.size,
          expectedCount,
          // Documentation coverage: files with @SourceFile annotations vs manifest sourceFiles
          docCoveragePercent,
          docMissingFiles: docMissingFiles.slice(0, 20),  // Show first 20 missing files
          validationErrors,  // Pass semantic errors from pre-turn validation
        });
      });

    const agent = builder.ask(userMessage);

    // Track usage
    let turnCount = 0;
    let iterationInputTokens = 0;
    let iterationOutputTokens = 0;
    let iterationCachedTokens = 0;
    let iterationCost = 0;

    const tree = agent.getTree();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tree.onAll((event: any) => {
      if (event.type === "llm_call_complete") {
        turnCount++;
        if (event.usage) {
          iterationInputTokens = event.usage.inputTokens || 0;
          iterationOutputTokens = event.usage.outputTokens || 0;
          iterationCachedTokens = event.usage.cachedInputTokens || 0;
          cycleState.inputTokens += iterationInputTokens;
          cycleState.outputTokens += iterationOutputTokens;
          cycleState.cachedTokens += iterationCachedTokens;
        }
        if (event.cost) {
          iterationCost = event.cost;
          cycleState.cost += iterationCost;
        }

        // Show turn stats in verbose mode
        if (flags.verbose) {
          const inputStr = formatTokens(iterationInputTokens);
          const outputStr = formatTokens(iterationOutputTokens);
          const cachedStr = iterationCachedTokens > 0
            ? ` (${formatTokens(iterationCachedTokens)} cached)`
            : "";
          const costStr = iterationCost >= 0.01
            ? `$${iterationCost.toFixed(3)}`
            : `$${iterationCost.toFixed(4)}`;
          console.log(`\x1b[2m   ⤷ Turn ${iterState.turnCount}.${turnCount}: ${inputStr} in · ${outputStr} out${cachedStr} · ${costStr}\x1b[0m`);
          // Coverage is now shown after each SysMLWrite/SysMLCreate gadget result
        }
      }
    });

    // Stream events
    for await (const event of agent.run()) {
      if (event.type === "text") {
        if (flags.verbose) {
          textState.inTextBlock = true;
          out.thinkingChunk(event.content);
        }
      } else if (event.type === "gadget_call") {
        if (flags.verbose) {
          endTextBlock(textState, out);
          const params = event.call.parameters as Record<string, unknown>;
          out.gadgetCall(event.call.gadgetName, params);
        }
      } else if (event.type === "gadget_result") {
        const result = event.result;

        if (flags.verbose) {
          endTextBlock(textState, out);
        }

        if (result.gadgetName === "SysMLWrite" || result.gadgetName === "SysMLCreate") {
          if (result.error) {
            out.gadgetError(result.gadgetName, result.error);
          } else if (result.result) {
            cycleState.filesWritten++;

            // Parse path from result (format: "path=... status=... mode=... delta=...")
            const pathMatch = result.result.match(/^path=(\S+)/);
            const modeMatch = result.result.match(/mode=(\w+)/);
            const deltaMatch = result.result.match(/delta=([+-]?\d+ bytes)/);
            const writtenPath = pathMatch ? pathMatch[1] : result.result.split("\n")[0];
            let mode = modeMatch ? modeMatch[1] : "";
            if (!mode && result.gadgetName === "SysMLCreate") {
              mode = result.result?.includes("Reset package") ? "reset" : "create";
            }
            const delta = deltaMatch ? deltaMatch[1] : null;

            // Extract entities from element content for cross-turn tracking (set mode only)
            const params = result.parameters as { path?: string; element?: string };
            if (params?.element && params?.path) {
              const newEntities = extractEntitiesFromSysml(params.element, params.path);
              iterState.createdEntities.push(...newEntities);
            }

            summary.push(`Wrote ${writtenPath}`);

            if (flags.verbose) {
              const modeStr = mode === "create" ? chalk.yellow("[new]") : mode === "reset" ? chalk.magenta("[reset]") : mode === "upsert" ? chalk.blue("[set]") : mode === "delete" ? chalk.red("[del]") : "";
              const deltaStr = delta ? (delta.startsWith("-") ? chalk.red(` (${delta})`) : chalk.dim(` (${delta})`)) : "";
              console.log(`${chalk.green("   ✓")} ${writtenPath} ${modeStr}${deltaStr}`);

              // Display colored diff if available
              const diff = extractDiffFromResult(result.result);
              if (diff) {
                const indentedDiff = diff.split("\n").map((line) => `      ${line}`).join("\n");
                console.log(indentedDiff);
              }

              // Show real-time coverage based on @SourceFile annotations
              if (expectedCount > 0) {
                const coverage = await checkCycleCoverage(cycle, ".");
                if (coverage.expectedFiles.length > 0) {
                  const coveragePercent = Math.round(coverage.coveragePercent);
                  console.log(`\x1b[2m      📄 Coverage: ${coverage.coveredFiles.length}/${coverage.expectedFiles.length} (${coveragePercent}%)\x1b[0m`);

                  // Show specific missing files to guide agent
                  if (coverage.missingFiles.length > 0) {
                    const sample = coverage.missingFiles.slice(0, 3).map(f => `"${f}"`).join(', ');
                    const moreCount = coverage.missingFiles.length - 3;
                    const moreStr = moreCount > 0 ? ` (+${moreCount} more)` : '';
                    console.log(`\x1b[2m      Still need: ${sample}${moreStr}\x1b[0m`);
                  }
                }
              }
            } else {
              console.log(`  Wrote: ${writtenPath}`);
            }
          }
        } else if (result.gadgetName === "FileViewerNextFileSet") {
          // Parse next files from the gadget call parameters
          const params = result.parameters as { paths?: string };
          // Always parse paths, even if empty string (fixes falsy check bug)
          nextFiles = parsePathList(params?.paths ?? "");

          if (flags.verbose) {
            if (nextFiles.length > 0) {
              console.log(`\x1b[2m   → Next batch: ${nextFiles.length} files\x1b[0m`);
            } else {
              console.log(`\x1b[2m   → Cycle section complete\x1b[0m`);
            }
          }

          // If LLM signals completion (empty paths), break out of event loop immediately
          if (nextFiles.length === 0) {
            break;
          }
        } else if (flags.verbose) {
          out.gadgetResult(result.gadgetName);
        }
      }
    }

    if (flags.verbose) {
      endTextBlock(textState, out);
    }

    return { nextFiles, summary, turns: turnCount };
  }

  /**
   * Run Cycle 0: Repository Discovery
   * Creates a manifest with file lists and counts for subsequent cycles.
   */
  private async runCycle0(
    client: LLMist,
    state: IngestState,
    flags: {
      model: string;
      verbose: boolean;
      rpm: number;
      tpm: number;
      "max-iterations": number;
    },
    out: Output
  ): Promise<CycleState> {
    const cycle = 0;
    const cycleName = "Repository Discovery";
    const cycleGoal = "Explore repository and create manifest for subsequent cycles";

    // Display cycle header
    if (flags.verbose) {
      console.log();
      console.log(`\x1b[34m━━━ Cycle 0: ${cycleName} ━━━\x1b[0m`);
      console.log(`\x1b[2m   Goal: ${cycleGoal}\x1b[0m`);
    } else {
      console.log(`[Cycle 0] ${cycleName}`);
    }

    // Read repo structure
    const repoMap = await readDirs.execute({
      paths: ".",
      depth: 4,
      includeGitIgnored: false,
    }) as string;

    // Get cycle 0 prompt
    const cyclePrompt = render("sysml/cycle0", {
      metadata: state.metadata,
    });

    // Build system prompt
    const systemPrompt = render("sysml/system", {});

    // Build user message for Cycle 0
    const userMessage = `# Cycle 0: Repository Discovery

${cyclePrompt}

## Repository Structure

\`\`\`
${repoMap}
\`\`\`

## Instructions

1. Explore the repository structure
2. Find and count schema files (Prisma, GraphQL, Protobuf)
3. Find and count modules/services
4. Create a complete manifest using ManifestWrite

The manifest will guide subsequent cycles with exact file lists and counts.
`;

    // Show context composition in verbose mode
    if (flags.verbose) {
      const contextTokens = {
        system: estimateTokens(systemPrompt),
        repoMap: estimateTokens(repoMap),
        task: estimateTokens(cyclePrompt),
      };
      const totalContext = contextTokens.system + contextTokens.repoMap + contextTokens.task;

      console.log(`\x1b[2m   Context: ${formatTokens(totalContext)} tokens\x1b[0m`);
      console.log(`\x1b[2m   ├─ System:   ${formatTokens(contextTokens.system)}\x1b[0m`);
      console.log(`\x1b[2m   ├─ Repo Map: ${formatTokens(contextTokens.repoMap)}\x1b[0m`);
      console.log(`\x1b[2m   └─ Task:     ${formatTokens(contextTokens.task)}\x1b[0m`);
    }

    // Run agent
    const cycleState: CycleState = {
      cycle,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      cost: 0,
      filesWritten: 0,
    };

    const textState = createTextBlockState();

    // Cycle 0 gets more iterations for thorough discovery
    const cycle0Iterations = Math.min(flags["max-iterations"], 25);

    let builder = new AgentBuilder(client)
      .withModel(flags.model)
      .withSystem(systemPrompt)
      .withMaxIterations(cycle0Iterations)
      .withGadgetExecutionMode("sequential")
      .withGadgets(
        manifestWrite,
        manifestRead,
        enumerateDirectories,
        projectMetaRead,
        fileDiscoverCustom,
        readFiles,
        readDirs,
        ripGrep
      )
      .withTextOnlyHandler("terminate");

    builder = configureBuilder(builder, out, flags.rpm, flags.tpm);

    const agent = builder.ask(userMessage);

    // Track usage and iterations
    let currentIteration = 0;
    let iterationInputTokens = 0;
    let iterationOutputTokens = 0;
    let iterationCachedTokens = 0;
    let iterationCost = 0;

    const tree = agent.getTree();
    tree.onAll((event) => {
      if (event.type === "llm_call_complete") {
        if (event.usage) {
          iterationInputTokens = event.usage.inputTokens || 0;
          iterationOutputTokens = event.usage.outputTokens || 0;
          iterationCachedTokens = event.usage.cachedInputTokens || 0;
          cycleState.inputTokens += iterationInputTokens;
          cycleState.outputTokens += iterationOutputTokens;
          cycleState.cachedTokens += iterationCachedTokens;
        }
        if (event.cost) {
          iterationCost = event.cost;
          cycleState.cost += iterationCost;
        }

        // Show iteration stats in verbose mode
        if (flags.verbose) {
          currentIteration++;
          const inputStr = formatTokens(iterationInputTokens);
          const outputStr = formatTokens(iterationOutputTokens);
          const cachedStr = iterationCachedTokens > 0
            ? ` (${formatTokens(iterationCachedTokens)} cached)`
            : "";
          const costStr = iterationCost >= 0.01
            ? `$${iterationCost.toFixed(3)}`
            : `$${iterationCost.toFixed(4)}`;
          console.log(`\x1b[2m   ⤷ Turn ${currentIteration}: ${inputStr} in · ${outputStr} out${cachedStr} · ${costStr}\x1b[0m`);
        }
      }
    });

    // Stream events
    for await (const event of agent.run()) {
      if (event.type === "text") {
        if (flags.verbose) {
          textState.inTextBlock = true;
          out.thinkingChunk(event.content);
        }
      } else if (event.type === "gadget_call") {
        if (flags.verbose) {
          endTextBlock(textState, out);
          const params = event.call.parameters as Record<string, unknown>;
          out.gadgetCall(event.call.gadgetName, params);
        }
      } else if (event.type === "gadget_result") {
        const result = event.result;

        if (flags.verbose) {
          endTextBlock(textState, out);
        }

        if (result.gadgetName === "ManifestWrite") {
          if (result.error) {
            out.gadgetError(result.gadgetName, result.error);
          } else if (result.result) {
            cycleState.filesWritten++;
            if (flags.verbose) {
              console.log(`\x1b[32m   ✓ Manifest written\x1b[0m`);
            } else {
              console.log(`  Wrote: .sysml/_manifest.json`);
            }
          }
        } else if (flags.verbose) {
          out.gadgetResult(result.gadgetName);
        }
      }
    }

    if (flags.verbose) {
      endTextBlock(textState, out);

      // Display cycle summary
      const totalTokens = cycleState.inputTokens + cycleState.outputTokens;
      const tokensStr = formatTokens(totalTokens);
      const cachedStr = cycleState.cachedTokens > 0
        ? ` (${formatTokens(cycleState.cachedTokens)} cached)`
        : "";
      const costStr = cycleState.cost >= 0.01
        ? `$${cycleState.cost.toFixed(3)}`
        : `$${cycleState.cost.toFixed(4)}`;
      const turnsStr = currentIteration === 1 ? "1 turn" : `${currentIteration} turns`;

      console.log();
      console.log(`\x1b[32m✓ Cycle 0 complete: ${turnsStr} · ${tokensStr} tokens${cachedStr} · ${costStr}\x1b[0m`);

      // Show manifest summary if available
      const manifest = await loadManifest();
      if (manifest) {
        console.log(`\x1b[2m   Manifest summary:\x1b[0m`);
        // Sort cycle keys handling both "1" and "cycle1" formats
        const getCycleNum = (key: string) => key.startsWith("cycle") ? parseInt(key.slice(5), 10) : parseInt(key, 10);
        const sortedEntries = Object.entries(manifest.cycles).sort(([a], [b]) => getCycleNum(a) - getCycleNum(b));
        for (const [key, cycleData] of sortedEntries) {
          const cycleNum = getCycleNum(key);
          const sourceFilesStr = cycleData.sourceFiles
            ? `${cycleData.sourceFiles.length} patterns`
            : "";
          console.log(`\x1b[2m   ${cycleNum}. ${cycleData.name}: ${cycleData.files?.length ?? 0} files${sourceFilesStr ? ` (${sourceFilesStr})` : ""}\x1b[0m`);
        }
      }
    }

    return cycleState;
  }

  private printSummary(state: IngestState, verbose: boolean): void {
    console.log();

    if (verbose) {
      console.log("\x1b[34m━━━ Summary ━━━\x1b[0m");
      console.log(`Project: ${state.metadata?.name ?? "unknown"}`);
      console.log(`Language: ${state.metadata?.primaryLanguage ?? "unknown"}`);
      console.log(`Cycles completed: ${state.cycleHistory.length}`);
      console.log(`Files written: ${state.totalFilesWritten}`);

      const totalTokens = state.totalInputTokens + state.totalOutputTokens;
      const tokensStr = formatTokens(totalTokens);
      const cachedStr = state.totalCachedTokens > 0
        ? ` (${formatTokens(state.totalCachedTokens)} cached)`
        : "";
      console.log(`Tokens: ${tokensStr}${cachedStr}`);

      if (state.totalCost > 0) {
        const costStr = state.totalCost >= 1
          ? `$${state.totalCost.toFixed(2)}`
          : state.totalCost >= 0.01
            ? `$${state.totalCost.toFixed(3)}`
            : `$${state.totalCost.toFixed(4)}`;
        console.log(`Cost: ${costStr}`);
      }

      console.log();
      console.log("Cycle breakdown:");
      for (const cycleState of state.cycleHistory) {
        const cycleName = cycleState.cycle === 0
          ? "Repository Discovery"
          : (cycleNames[cycleState.cycle] ?? `Cycle ${cycleState.cycle}`);
        const cycleCost = cycleState.cost >= 0.01
          ? `$${cycleState.cost.toFixed(3)}`
          : `$${cycleState.cost.toFixed(4)}`;
        console.log(`  ${cycleState.cycle}. ${cycleName}: ${cycleState.filesWritten} files, ${cycleCost}`);
      }
    } else {
      const costStr = state.totalCost >= 0.01
        ? `$${state.totalCost.toFixed(2)}`
        : `$${state.totalCost.toFixed(4)}`;
      console.log(`Done. Generated SysML model in .sysml/ (${state.totalFilesWritten} files). Cost: ${costStr}`);
    }

    console.log();
    console.log("SysML model location: .sysml/");
    console.log("Entry point: .sysml/_model.sysml");
  }
}
