/**
 * Model I/O utilities for reading and writing SysML models.
 */

import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import fg from "fast-glob";

import { SYSML_DIR, CYCLE_SYSML_PATTERNS } from "./constants.js";
import { generateInitialFiles, regenerateModelIndex, CYCLE_OUTPUT_DIRS, type ProjectMetadata } from "../sysml/index.js";
import { runSysml2Multi, formatFile } from "../sysml/sysml2-cli.js";
import { Output } from "../output.js";

/**
 * Read existing SysML files from the model, filtered by cycle.
 * Each cycle only sees output from previous cycles to enforce boundaries.
 * @param cycle - The current cycle number (1-6)
 */
export async function readExistingModel(
  cycle: number,
  includeCurrentCycleOutput: boolean = false,
): Promise<string> {
  const patterns = [...(CYCLE_SYSML_PATTERNS[cycle] ?? ["**/*.sysml"])];

  if (includeCurrentCycleOutput) {
    const currentDir = CYCLE_OUTPUT_DIRS[cycle];
    if (currentDir) {
      const currentPattern = `${currentDir}/**/*.sysml`;
      if (!patterns.includes(currentPattern)) {
        patterns.push(currentPattern);
      }
    }
  }

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
 * Generate initial SysML model structure.
 */
export async function generateInitialModel(
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
  const writtenPaths: string[] = [];
  for (const [path, content] of Object.entries(files)) {
    const fullPath = join(SYSML_DIR, path);
    await writeFile(fullPath, content, "utf-8");
    writtenPaths.push(fullPath);
    if (verbose) {
      console.log(`  Created: ${fullPath}`);
    }
  }

  // Validate and pretty-print all files
  for (const fullPath of writtenPaths) {
    try {
      await formatFile(fullPath);
    } catch {
      // sysml2 not available - skip formatting
    }
  }

  out.success(`Created ${Object.keys(files).length} initial SysML files`);
}

/**
 * Validate initial SysML model files.
 * Returns true if validation passes, false if there are errors.
 */
export async function validateInitialModel(
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

/**
 * Update the _model.sysml file to import all discovered packages.
 * Should be called after each ingestion cycle to ensure the model index
 * reflects the current state of the model.
 */
export async function updateModelIndex(
  metadata: ProjectMetadata | null,
  verbose: boolean
): Promise<void> {
  if (!metadata) {
    return;
  }

  const newContent = await regenerateModelIndex(SYSML_DIR, metadata.name);
  const modelPath = join(SYSML_DIR, "_model.sysml");

  // Read existing content to check if update is needed
  let existingContent = "";
  try {
    existingContent = await readFile(modelPath, "utf-8");
  } catch {
    // File doesn't exist yet, will be created
  }

  // Only write if content has changed (ignoring timestamp in doc comment)
  const normalizeForComparison = (content: string) =>
    content.replace(/Generated: [^*]+\*/, "Generated: TIMESTAMP */");

  if (normalizeForComparison(existingContent) !== normalizeForComparison(newContent)) {
    await writeFile(modelPath, newContent, "utf-8");
    if (verbose) {
      console.log(`\x1b[2m   Updated _model.sysml with current package imports\x1b[0m`);
    }
  }
}
