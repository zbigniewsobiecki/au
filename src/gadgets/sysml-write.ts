/**
 * SysML Write Gadget
 * Writes SysML v2 packages to the .sysml/ directory.
 */

import { createGadget, z } from "llmist";
import { writeFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as Diff from "diff";
import { validateSysml } from "../lib/sysml/validator.js";
import { GADGET_REASON_DESCRIPTION } from "../lib/constants.js";

export interface SysMLWriteResult {
  path: string;
  marker: "new" | "upd";
  oldBytes: number;
  newBytes: number;
  diffLines: Array<{ type: "add" | "del" | "ctx"; line: string }> | null;
}

/**
 * Filter diff lines to only show changes with surrounding context.
 */
function filterWithContext(
  lines: Array<{ type: "add" | "del" | "ctx"; line: string }>,
  contextLines: number
): Array<{ type: "add" | "del" | "ctx"; line: string }> {
  if (lines.length === 0) return [];

  // Mark which indices should be included (changes + context)
  const include = new Array(lines.length).fill(false);

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].type !== "ctx") {
      // Mark this line and surrounding context
      for (let j = Math.max(0, i - contextLines); j <= Math.min(lines.length - 1, i + contextLines); j++) {
        include[j] = true;
      }
    }
  }

  return lines.filter((_, i) => include[i]);
}

export const sysmlWrite = createGadget({
  name: "SysMLWrite",
  maxConcurrent: 1,
  description: `Write SysML v2 content to the .sysml/ directory.

**Usage:**
SysMLWrite(path="context/requirements.sysml", content="package SystemRequirements { ... }")

The path is relative to .sysml/ directory.
Content must be valid SysML v2 syntax.
Will create directories as needed.`,
  schema: z.object({
    reason: z.string().describe(GADGET_REASON_DESCRIPTION),
    path: z
      .string()
      .describe("File path relative to .sysml/ (e.g., 'context/requirements.sysml')"),
    content: z.string().describe("SysML v2 content to write"),
    validate: z
      .boolean()
      .optional()
      .describe("Whether to validate SysML syntax before writing (default: true)"),
  }),
  execute: async ({ reason: _reason, path, content, validate = true }) => {
    // Ensure path ends with .sysml
    if (!path.endsWith(".sysml")) {
      return `Error: File path must end with .sysml extension`;
    }

    // Validate SysML syntax if requested
    if (validate) {
      const validationResult = await validateSysml(content);
      if (!validationResult.valid) {
        const errors = validationResult.issues
          .filter((i) => i.severity === "error")
          .map((i) => `  Line ${i.line}:${i.column}: ${i.message}`)
          .join("\n");
        return `Error: Invalid SysML syntax:\n${errors}`;
      }
    }

    const fullPath = join(".sysml", path);

    // Check if file exists and get old content
    let oldBytes = 0;
    let isNew = true;
    let existingContent = "";
    try {
      existingContent = await readFile(fullPath, "utf-8");
      oldBytes = Buffer.byteLength(existingContent, "utf-8");
      isNew = false;
    } catch {
      // New file
    }

    // Create directory if needed
    const dir = dirname(fullPath);
    if (dir && dir !== ".") {
      await mkdir(dir, { recursive: true });
    }

    // Write file
    await writeFile(fullPath, content, "utf-8");

    const newBytes = Buffer.byteLength(content, "utf-8");
    const marker: "new" | "upd" = isNew ? "new" : "upd";

    // Compute diff for updates
    let diffLines: SysMLWriteResult["diffLines"] = null;
    if (!isNew && existingContent !== content) {
      const changes = Diff.diffLines(existingContent, content);
      diffLines = [];
      for (const change of changes) {
        const lines = change.value.split("\n").filter((l, i, arr) => i < arr.length - 1 || l !== "");
        for (const line of lines) {
          if (change.added) {
            diffLines.push({ type: "add", line });
          } else if (change.removed) {
            diffLines.push({ type: "del", line });
          } else {
            diffLines.push({ type: "ctx", line });
          }
        }
      }
      // Filter to only show changes + 1 line context
      diffLines = filterWithContext(diffLines, 1);
    }

    const result: SysMLWriteResult = {
      path: fullPath,
      marker,
      oldBytes,
      newBytes,
      diffLines,
    };

    return JSON.stringify(result);
  },
});

export const sysmlRead = createGadget({
  name: "SysMLRead",
  description: `Read SysML v2 content from the .sysml/ directory.

**Usage:**
SysMLRead(path="context/requirements.sysml")

Returns the file content or an error if not found.`,
  schema: z.object({
    reason: z.string().describe(GADGET_REASON_DESCRIPTION),
    path: z
      .string()
      .describe("File path relative to .sysml/ (e.g., 'context/requirements.sysml')"),
  }),
  execute: async ({ reason: _reason, path }) => {
    const fullPath = join(".sysml", path);

    try {
      const content = await readFile(fullPath, "utf-8");
      const bytes = Buffer.byteLength(content, "utf-8");
      return `=== ${path} (${bytes} bytes) ===\n${content}`;
    } catch {
      return `Error: File not found: ${fullPath}`;
    }
  },
});

export const sysmlList = createGadget({
  name: "SysMLList",
  description: `List all SysML files in the .sysml/ directory.

**Usage:**
SysMLList()

Returns a list of all .sysml files with their sizes.`,
  schema: z.object({
    reason: z.string().describe(GADGET_REASON_DESCRIPTION),
  }),
  execute: async ({ reason: _reason }) => {
    const { readdir } = await import("node:fs/promises");
    const { join } = await import("node:path");

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
            const statResult = await stat(fullPath);
            files.push({
              path: relativePath,
              bytes: statResult.size,
            });
          }
        }
      } catch {
        // Directory doesn't exist
      }
    }

    await scanDir(".sysml");

    if (files.length === 0) {
      return "No .sysml files found. Run sysml-ingest to generate the model.";
    }

    // Sort by path
    files.sort((a, b) => a.path.localeCompare(b.path));

    const lines = files.map((f) => `${f.path} (${f.bytes} bytes)`);
    const totalBytes = files.reduce((sum, f) => sum + f.bytes, 0);

    return `SysML Model Files:\n${lines.join("\n")}\n\nTotal: ${files.length} files, ${totalBytes} bytes`;
  },
});
