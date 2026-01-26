/**
 * SysML Model Validator
 * Validates the SysML model structure and coverage.
 */

import { readFile, readdir, stat, access } from "node:fs/promises";
import { join } from "node:path";
import { validateModelFull } from "./sysml/sysml2-cli.js";
import { loadManifest, type Manifest } from "../gadgets/manifest-write.js";
import { discoverModelPackages } from "./sysml/index.js";
import fg from "fast-glob";

const SYSML_DIR = ".sysml";
const MANIFEST_PATH = ".sysml/_manifest.json";

/** Known system files that are always expected */
const SYSTEM_FILES = new Set([
  "_manifest.json",
  "_model.sysml",
  "_project.sysml",
  "SysMLPrimitives.sysml",
]);

/**
 * Count SysML element definitions in content.
 */
interface ElementCounts {
  itemDefs: number;
  partDefs: number;
  enumDefs: number;
  actionDefs: number;
  requirementDefs: number;
  parts: { name: string; layer?: string }[];
}

function countElements(content: string): ElementCounts {
  const counts: ElementCounts = {
    itemDefs: 0,
    partDefs: 0,
    enumDefs: 0,
    actionDefs: 0,
    requirementDefs: 0,
    parts: [],
  };

  const lines = content.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip comments
    if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
      continue;
    }

    // item def Name
    if (/^\s*item\s+def\s+\w+/.test(trimmed)) {
      counts.itemDefs++;
    }

    // part def Name (not part Name : Type)
    if (/^\s*part\s+def\s+\w+/.test(trimmed)) {
      counts.partDefs++;
    }

    // enum def Name
    if (/^\s*enum\s+def\s+\w+/.test(trimmed)) {
      counts.enumDefs++;
    }

    // action def Name
    if (/^\s*action\s+def\s+\w+/.test(trimmed)) {
      counts.actionDefs++;
    }

    // requirement def Name or requirement Name
    if (/^\s*requirement\s+(def\s+)?\w+/.test(trimmed)) {
      counts.requirementDefs++;
    }

    // part Name : Type { with layer attribute
    const partMatch = trimmed.match(/^\s*part\s+(\w+)\s*:\s*\w+/);
    if (partMatch) {
      const partName = partMatch[1];
      // Look for layer in the following lines (simplified - check same line and content)
      let layer: string | undefined;

      // Check if layer is on the same line (inline redefinition)
      const layerMatch = content.match(
        new RegExp(`part\\s+${partName}[^}]*:>>\\s*layer\\s*=\\s*"([^"]+)"`, "s")
      );
      if (layerMatch) {
        layer = layerMatch[1];
      }

      counts.parts.push({ name: partName, layer });
    }
  }

  return counts;
}

/**
 * Count parts by layer attribute in a SysML file.
 */
function countPartsByLayer(content: string): { services: number; controllers: number; modules: number } {
  const counts = { services: 0, controllers: 0, modules: 0 };

  // Match part definitions with their full block content
  // This regex finds: part name : Module { ... }
  const partBlockRegex = /part\s+(\w+)\s*:\s*Module\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/gs;

  let match;
  while ((match = partBlockRegex.exec(content)) !== null) {
    const blockContent = match[2];
    counts.modules++;

    // Check for layer attribute within the block
    const layerMatch = blockContent.match(/:>>\s*layer\s*=\s*"([^"]+)"/);
    if (layerMatch) {
      const layer = layerMatch[1];
      if (layer === "service") {
        counts.services++;
      } else if (layer === "presentation") {
        counts.controllers++;
      }
    }
  }

  return counts;
}

/**
 * Extract all package and definition names from SysML content.
 */
function extractDefinedNames(content: string): Set<string> {
  const names = new Set<string>();

  // Package definitions
  const packageMatches = content.matchAll(/(?:standard\s+library\s+)?package\s+(\w+)/g);
  for (const match of packageMatches) {
    names.add(match[1]);
  }

  // Datatype definitions (primitives): "datatype Name" or "datatype Name :> Base"
  const datatypeMatches = content.matchAll(/datatype\s+(\w+)/g);
  for (const match of datatypeMatches) {
    names.add(match[1]);
  }

  // Various def types
  const defMatches = content.matchAll(
    /(?:item|part|enum|action|state|requirement|interface|port|attribute|analysis|verification|metadata|constraint|connection|allocation)\s+def\s+(\w+)/g
  );
  for (const match of defMatches) {
    names.add(match[1]);
  }

  return names;
}

/**
 * Extract import references from SysML content.
 */
function extractImports(content: string): { line: number; packageName: string; fullImport: string }[] {
  const imports: { line: number; packageName: string; fullImport: string }[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^\s*import\s+(\w+)(::[^;]+)?;?/);
    if (match) {
      imports.push({
        line: i + 1,
        packageName: match[1],
        fullImport: match[0].trim(),
      });
    }
  }

  return imports;
}

/**
 * Extract specialization references (:> BaseType) from SysML content.
 */
function extractSpecializations(
  content: string
): { line: number; baseType: string; context: string }[] {
  const specializations: { line: number; baseType: string; context: string }[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match :> TypeName (but not :>> which is redefinition)
    const matches = line.matchAll(/:>\s+(\w+)(?!\s*>)/g);
    for (const match of matches) {
      specializations.push({
        line: i + 1,
        baseType: match[1],
        context: line.trim().slice(0, 60),
      });
    }
  }

  return specializations;
}

export interface ExpectedOutputCheck {
  path: string;
  exists: boolean;
}

export interface SyntaxError {
  file: string;
  errors: string[];
}

export interface FileCoverageMismatch {
  cycle: string;
  patterns: string[];      // Original patterns from manifest
  expected: number;        // Expanded file count
  covered: number;         // Files with // Source: comments
  uncoveredFiles: string[]; // Specific files not covered
}

export interface ReferenceMissing {
  file: string;
  line: number;
  type: "import" | "specialization" | "part-reference";
  reference: string;
  context?: string;
}

export interface CoverageIssue {
  cycle: string;
  type: "missing-file" | "missing-directory" | "pattern-no-match";
  path: string;
  detail?: string;
}

export interface ModelIndexMismatch {
  importedButMissing: string[];
  existingButNotImported: string[];
}

export interface SysMLValidationResult {
  manifestExists: boolean;
  manifestErrors: string[];
  expectedOutputs: ExpectedOutputCheck[];
  syntaxErrors: SyntaxError[];
  fileCoverageMismatches: FileCoverageMismatch[];
  orphanedFiles: string[];
  missingReferences: ReferenceMissing[];
  coverageIssues: CoverageIssue[];
  modelIndexMismatches?: ModelIndexMismatch;
  validFileCount: number;
  totalFileCount: number;
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
 * Get all expected output files from manifest.
 */
function getExpectedOutputs(manifest: Manifest): string[] {
  const outputs: string[] = [];
  for (const cycle of Object.values(manifest.cycles)) {
    if (cycle.expectedOutputs) {
      outputs.push(...cycle.expectedOutputs);
    }
  }
  return outputs;
}

/**
 * Get all files referenced in directory patterns for a given cycle.
 */
async function getFilesFromDirectoryPatterns(
  basePath: string,
  manifest: Manifest,
  cycleKey: string
): Promise<string[]> {
  if (!manifest.directories) return [];

  const files: string[] = [];

  for (const dir of manifest.directories) {
    const cycleConfig = dir.cycles[cycleKey];
    if (!cycleConfig) continue;

    for (const pattern of cycleConfig.patterns) {
      const globPattern = join(basePath, dir.path, pattern);
      const matches = await fg(globPattern, { onlyFiles: true });
      files.push(...matches);
    }
  }

  return files;
}

export class SysMLModelValidator {
  /**
   * Validate the SysML model at the given path.
   */
  async validate(basePath: string = "."): Promise<SysMLValidationResult> {
    const result: SysMLValidationResult = {
      manifestExists: false,
      manifestErrors: [],
      expectedOutputs: [],
      syntaxErrors: [],
      fileCoverageMismatches: [],
      orphanedFiles: [],
      missingReferences: [],
      coverageIssues: [],
      validFileCount: 0,
      totalFileCount: 0,
    };

    // Check if .sysml directory exists
    const sysmlDir = join(basePath, SYSML_DIR);
    if (!(await fileExists(sysmlDir))) {
      result.manifestErrors.push("No .sysml directory found. Run 'au sysml-ingest' first.");
      return result;
    }

    // Check manifest exists
    const manifestPath = join(basePath, MANIFEST_PATH);
    result.manifestExists = await fileExists(manifestPath);

    if (!result.manifestExists) {
      result.manifestErrors.push("Manifest not found at .sysml/_manifest.json");
      return result;
    }

    // Load and validate manifest
    let manifest: Manifest;
    try {
      const content = await readFile(manifestPath, "utf-8");
      manifest = JSON.parse(content);
    } catch (error) {
      result.manifestErrors.push(
        `Failed to parse manifest: ${error instanceof Error ? error.message : String(error)}`
      );
      return result;
    }

    // Validate manifest structure
    if (!manifest.version) {
      result.manifestErrors.push("Manifest missing version field");
    }
    if (!manifest.project) {
      result.manifestErrors.push("Manifest missing project field");
    }
    if (!manifest.cycles) {
      result.manifestErrors.push("Manifest missing cycles field");
    }

    // Check expected outputs exist
    const expectedOutputs = getExpectedOutputs(manifest);
    for (const output of expectedOutputs) {
      const fullPath = join(basePath, SYSML_DIR, output);
      result.expectedOutputs.push({
        path: output,
        exists: await fileExists(fullPath),
      });
    }

    // Scan all .sysml files
    const sysmlFiles = await scanSysmlFiles(basePath);
    result.totalFileCount = sysmlFiles.length;

    // Validate syntax using single-file validation via _model.sysml
    // Since _model.sysml imports all packages, sysml2 follows imports transitively
    const sysmlDirPath = join(basePath, SYSML_DIR);
    const modelFile = join(sysmlDirPath, "_model.sysml");
    const validationResult = await validateModelFull(sysmlDirPath, [modelFile]);

    // Map diagnostics to SyntaxError format
    for (const diag of validationResult.syntaxErrors) {
      // Extract relative file path from diagnostic
      const relativeFile = diag.file.startsWith(sysmlDirPath)
        ? diag.file.slice(sysmlDirPath.length + 1)
        : diag.file;

      const existingError = result.syntaxErrors.find(e => e.file === relativeFile);
      if (existingError) {
        existingError.errors.push(`Line ${diag.line}:${diag.column}: ${diag.message}`);
      } else {
        result.syntaxErrors.push({
          file: relativeFile,
          errors: [`Line ${diag.line}:${diag.column}: ${diag.message}`],
        });
      }
    }

    result.validFileCount = sysmlFiles.length - result.syntaxErrors.length;

    // Collect file contents for count validation and reference checking
    const fileContents: Map<string, string> = new Map();
    for (const file of sysmlFiles) {
      const fullPath = join(basePath, SYSML_DIR, file);
      try {
        const content = await readFile(fullPath, "utf-8");
        fileContents.set(file, content);
      } catch {
        // Already reported in syntax errors if file can't be read
      }
    }

    // Check file coverage from manifest cycles
    await this.validateFileCoverage(manifest, fileContents, basePath, result);

    // Check for orphaned files (files not referenced in expectedOutputs)
    this.detectOrphanedFiles(sysmlFiles, expectedOutputs, result);

    // Check reference integrity (imports and specializations)
    this.validateReferences(fileContents, result);

    // Check coverage completeness (target files exist)
    await this.validateCoverage(manifest, basePath, result);

    // Check model index imports match discovered packages
    await this.validateModelIndex(sysmlDirPath, fileContents, result);

    return result;
  }

  /**
   * Get total issue count from validation result.
   */
  static getIssueCount(result: SysMLValidationResult): number {
    let count = result.manifestErrors.length;
    count += result.expectedOutputs.filter((o) => !o.exists).length;
    count += result.syntaxErrors.length;
    count += result.fileCoverageMismatches.length;
    count += result.orphanedFiles.length;
    count += result.missingReferences.length;
    count += result.coverageIssues.length;
    if (result.modelIndexMismatches) {
      count += result.modelIndexMismatches.importedButMissing.length;
      count += result.modelIndexMismatches.existingButNotImported.length;
    }
    return count;
  }

  /**
   * Validate that source files are covered by SysML definitions.
   * Checks for // Source: <path> comments in SysML files.
   */
  private async validateFileCoverage(
    manifest: Manifest,
    fileContents: Map<string, string>,
    basePath: string,
    result: SysMLValidationResult
  ): Promise<void> {
    // Extract all covered files from SysML content (// Source: comments)
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
  private findCoveredFiles(fileContents: Map<string, string>): Set<string> {
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
   * Detect files in .sysml directory not listed in expectedOutputs.
   */
  private detectOrphanedFiles(
    sysmlFiles: string[],
    expectedOutputs: string[],
    result: SysMLValidationResult
  ): void {
    const expectedSet = new Set(expectedOutputs);

    // Add system files to expected set
    for (const systemFile of SYSTEM_FILES) {
      expectedSet.add(systemFile);
    }

    for (const file of sysmlFiles) {
      // Skip system files (starting with _)
      if (file.startsWith("_")) {
        continue;
      }

      // Skip index files (subdirectory/_index.sysml)
      if (file.endsWith("/_index.sysml") || file === "_index.sysml") {
        continue;
      }

      // Check if file is in expected outputs
      if (!expectedSet.has(file)) {
        result.orphanedFiles.push(file);
      }
    }
  }

  /**
   * Validate that imports and specializations reference existing packages/elements.
   */
  private validateReferences(
    fileContents: Map<string, string>,
    result: SysMLValidationResult
  ): void {
    // First, collect all defined names across all files
    const allDefinedNames = new Set<string>();

    // Add standard library packages that are always available
    const standardPackages = new Set([
      "SysMLPrimitives",
      "ISQ",
      "SI",
      "Base",
      "Metaobjects",
      "Links",
      "Objects",
      "Performances",
      "Occurrences",
      "Items",
      "Parts",
      "Ports",
      "Connections",
      "Interfaces",
      "Actions",
      "States",
      "Calculations",
      "Constraints",
      "Requirements",
      "Cases",
      "Analysis",
      "Allocations",
      "Metadata",
      "Views",
      "ScalarValues",
    ]);

    for (const name of standardPackages) {
      allDefinedNames.add(name);
    }

    // Collect definitions from all files
    for (const [, content] of fileContents) {
      const names = extractDefinedNames(content);
      for (const name of names) {
        allDefinedNames.add(name);
      }
    }

    // Check imports in each file
    for (const [file, content] of fileContents) {
      const imports = extractImports(content);
      for (const imp of imports) {
        if (!allDefinedNames.has(imp.packageName)) {
          result.missingReferences.push({
            file,
            line: imp.line,
            type: "import",
            reference: imp.packageName,
            context: imp.fullImport,
          });
        }
      }

      // Check specializations
      const specializations = extractSpecializations(content);
      for (const spec of specializations) {
        // Only check if the base type looks like a user-defined type (capitalized)
        if (/^[A-Z]/.test(spec.baseType) && !allDefinedNames.has(spec.baseType)) {
          result.missingReferences.push({
            file,
            line: spec.line,
            type: "specialization",
            reference: spec.baseType,
            context: spec.context,
          });
        }
      }
    }
  }

  /**
   * Validate coverage completeness - target files in manifest exist.
   */
  private async validateCoverage(
    manifest: Manifest,
    basePath: string,
    result: SysMLValidationResult
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

  /**
   * Validate that _model.sysml imports match discovered packages.
   */
  private async validateModelIndex(
    sysmlDirPath: string,
    fileContents: Map<string, string>,
    result: SysMLValidationResult
  ): Promise<void> {
    // Get _model.sysml content
    const modelContent = fileContents.get("_model.sysml");
    if (!modelContent) {
      return; // No model file to validate
    }

    // Extract imported package names from _model.sysml
    const importedPackages = new Set<string>();
    const importMatches = modelContent.matchAll(/import\s+(\w+)::/g);
    for (const match of importMatches) {
      importedPackages.add(match[1]);
    }

    // Discover all packages that exist in the model
    const discoveredPackages = await discoverModelPackages(sysmlDirPath);
    const discoveredSet = new Set(discoveredPackages);

    // Find mismatches
    const importedButMissing: string[] = [];
    const existingButNotImported: string[] = [];

    // Check for imports that reference non-existent packages
    for (const pkg of importedPackages) {
      if (!discoveredSet.has(pkg)) {
        importedButMissing.push(pkg);
      }
    }

    // Check for packages that exist but aren't imported
    for (const pkg of discoveredPackages) {
      if (!importedPackages.has(pkg)) {
        existingButNotImported.push(pkg);
      }
    }

    // Only set mismatches if there are any
    if (importedButMissing.length > 0 || existingButNotImported.length > 0) {
      result.modelIndexMismatches = {
        importedButMissing,
        existingButNotImported,
      };
    }
  }
}
