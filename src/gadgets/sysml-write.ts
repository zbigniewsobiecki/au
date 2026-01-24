/**
 * SysML Write Gadget
 * Writes SysML v2 packages to the .sysml/ directory.
 * Supports two modes:
 * 1. Full content mode: Write entire file content (for new files)
 * 2. Search/Replace mode: Find and replace specific content (for edits)
 */

import { createGadget, z } from "llmist";
import { writeFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as Diff from "diff";
import {
  validateSysml,
  checkDuplicatesInFile,
  checkSemanticIssuesWithSysml2,
  formatSemanticIssues,
} from "../lib/sysml/validator.js";
import {
  setElement,
  deleteElements,
} from "../lib/sysml/sysml2-cli.js";
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

/**
 * Compute diff lines between old and new content.
 */
function computeDiffLines(
  oldContent: string,
  newContent: string,
  contextLines: number = 1
): Array<{ type: "add" | "del" | "ctx"; line: string }> {
  const changes = Diff.diffLines(oldContent, newContent);
  const diffLines: Array<{ type: "add" | "del" | "ctx"; line: string }> = [];

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

  // Filter to only show changes + context
  return filterWithContext(diffLines, contextLines);
}

export const sysmlWrite = createGadget({
  name: "SysMLWrite",
  maxConcurrent: 1,
  description: `Write SysML v2 content to the .sysml/ directory.

**Three modes:**

1. **Full content mode** (for new files):
   SysMLWrite(path="context/requirements.sysml", content="package SystemRequirements { ... }")

2. **CLI upsert mode** (PREFERRED for editing existing files):
   SysMLWrite(
     path="data/entities.sysml",
     element="item def User :> BaseEntity { attribute email : String; }",
     at="DataModel::Entities"
   )
   - element: SysML fragment to insert or replace
   - at: Qualified scope path (e.g., "DataModel::Entities")
   - createScope=true: Create scope hierarchy if missing
   - UPSERT semantics: replaces if element exists, adds if new

3. **CLI delete mode** (for removing elements):
   SysMLWrite(path="data/entities.sysml", delete="DataModel::Entities::OldUser")

**Tips:**
- Use CLI upsert mode (element + at) for semantic edits on existing files
- Use content mode only for creating new files
- Use createScope=true if parent scope doesn't exist yet`,
  schema: z.object({
    reason: z.string().describe(GADGET_REASON_DESCRIPTION),
    path: z
      .string()
      .describe("File path relative to .sysml/ (e.g., 'context/requirements.sysml')"),

    // Mode 1: Full content (for new files)
    content: z
      .string()
      .optional()
      .describe("Full SysML v2 content to write (use for new files)"),

    // Mode 2: CLI upsert (for edits)
    element: z
      .string()
      .optional()
      .describe("SysML fragment to upsert (e.g., 'item def User { attribute name : String; }')"),
    at: z
      .string()
      .optional()
      .describe("Scope path where element should be placed (e.g., 'DataModel::Entities')"),
    createScope: z
      .boolean()
      .optional()
      .describe("Create scope hierarchy if it doesn't exist (default: false)"),

    // Mode 3: CLI delete
    delete: z
      .string()
      .optional()
      .describe("Element path to delete (e.g., 'DataModel::Entities::OldUser')"),

    // Common options
    dryRun: z
      .boolean()
      .optional()
      .describe("Preview changes without writing (default: false)"),
    validate: z
      .boolean()
      .optional()
      .describe("Whether to validate SysML syntax before writing (default: true)"),
  }),
  execute: async ({ reason: _reason, path, content, element, at, createScope = false, delete: deletePattern, dryRun = false, validate = true }) => {
    // Ensure path ends with .sysml
    if (!path.endsWith(".sysml")) {
      return `Error: File path must end with .sysml extension`;
    }

    // Block writes to manifest files - manifest counts are authoritative
    // The fix phase should generate missing SysML content, not edit manifests
    if (path.endsWith("/manifest.sysml") || path === "manifest.sysml") {
      return `Error: Cannot edit manifest files via SysMLWrite.

Manifest counts reflect what EXISTS in the codebase - they are correct.
The SysML model is incomplete, not the manifest wrong.

To fix count mismatches:
1. Use ReadFiles/RipGrep to find entities in the codebase
2. Use SysMLWrite to create SysML definitions (item def, part def, etc.)
3. The manifest counts will match once SysML content is complete`;
    }

    const fullPath = join(".sysml", path);

    // Determine mode
    const isCliUpsert = element !== undefined && at !== undefined;
    const isCliDelete = deletePattern !== undefined;
    const isFullContent = content !== undefined;

    // Count active modes
    const activeModes = [isCliUpsert, isCliDelete, isFullContent].filter(Boolean).length;

    // Validate mode selection
    if (activeModes === 0) {
      return `Error: Must provide one of:
- 'content' (full content mode for new files)
- 'element' + 'at' (CLI upsert mode for edits)
- 'delete' (CLI delete mode)`;
    }

    if (activeModes > 1) {
      return `Error: Cannot use multiple modes. Choose one of: content, element+at, or delete`;
    }

    // Mode 2: CLI upsert - use sysml2 --set --at
    if (isCliUpsert) {
      try {
        const result = await setElement(fullPath, element!, at!, {
          createScope,
          dryRun,
        });

        if (!result.success) {
          const errors = result.diagnostics
            .filter((d) => d.severity === "error")
            .map((d) => `  Line ${d.line}:${d.column}: ${d.message}`)
            .join("\n");
          return `path=${fullPath} status=error mode=upsert\n\nCLI upsert failed:\n${errors || "Unknown error"}`;
        }

        const actionDesc = result.replaced > 0 ? "replaced" : "added";
        const dryRunNote = dryRun ? " (dry run)" : "";
        return `path=${fullPath} status=success mode=upsert${dryRunNote}
Element ${actionDesc} at scope: ${at}
Added: ${result.added}, Replaced: ${result.replaced}`;
      } catch (err) {
        return `path=${fullPath} status=error mode=upsert\n\nError: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    // Mode 3: CLI delete - use sysml2 --delete
    if (isCliDelete) {
      try {
        const result = await deleteElements(fullPath, [deletePattern!], { dryRun });

        if (!result.success) {
          const errors = result.diagnostics
            .filter((d) => d.severity === "error")
            .map((d) => `  Line ${d.line}:${d.column}: ${d.message}`)
            .join("\n");
          return `path=${fullPath} status=error mode=delete\n\nCLI delete failed:\n${errors || "Unknown error"}`;
        }

        const dryRunNote = dryRun ? " (dry run)" : "";
        if (result.deleted === 0) {
          return `path=${fullPath} status=success mode=delete${dryRunNote}
Element not found: ${deletePattern}
(Nothing was deleted)`;
        }
        return `path=${fullPath} status=success mode=delete${dryRunNote}
Deleted: ${result.deleted} element(s) matching: ${deletePattern}`;
      } catch (err) {
        return `path=${fullPath} status=error mode=delete\n\nError: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    // Mode 1: Full content mode - for creating new files
    // Read existing content if file exists (for diff computation)
    let existingContent = "";
    let oldBytes = 0;
    let isNew = true;

    try {
      existingContent = await readFile(fullPath, "utf-8");
      oldBytes = Buffer.byteLength(existingContent, "utf-8");
      isNew = false;
    } catch {
      // File doesn't exist - this is expected for new files
    }

    const newContent = content!;

    // Validate SysML syntax if requested
    if (validate) {
      const validationResult = await validateSysml(newContent);
      if (!validationResult.valid) {
        const errors = validationResult.issues
          .filter((i) => i.severity === "error")
          .map((i) => `  Line ${i.line}:${i.column}: ${i.message}`)
          .join("\n");
        return `Error: Invalid SysML syntax:\n${errors}`;
      }
    }

    // Check for semantic issues (duplicates) using sysml2, with fallback to regex
    let semanticIssues = await checkSemanticIssuesWithSysml2(newContent);
    if (semanticIssues.length === 0) {
      // Fallback to regex-based check if sysml2 didn't find issues or isn't available
      semanticIssues = checkDuplicatesInFile(newContent);
    }
    let semanticWarnings = "";
    if (semanticIssues.length > 0) {
      semanticWarnings = `\n⚠ Semantic warnings:\n${formatSemanticIssues(semanticIssues, path)}`;
    }

    // Create directory if needed
    const dir = dirname(fullPath);
    if (dir && dir !== ".") {
      await mkdir(dir, { recursive: true });
    }

    // Write file
    await writeFile(fullPath, newContent, "utf-8");

    const newBytes = Buffer.byteLength(newContent, "utf-8");
    const marker: "new" | "upd" = isNew ? "new" : "upd";

    // Compute diff lines for updates
    let diffLines: SysMLWriteResult["diffLines"] = null;
    if (!isNew && existingContent !== newContent) {
      diffLines = computeDiffLines(existingContent, newContent, 1);
    }

    // Build result
    const result: SysMLWriteResult = {
      path: fullPath,
      marker,
      oldBytes,
      newBytes,
      diffLines,
    };

    // DEBUG: Check why output is so large
    const jsonResult = JSON.stringify(result);
    const resultBytes = Buffer.byteLength(jsonResult, "utf-8");
    const resultLines = diffLines?.length ?? 0;

    if (resultBytes > 100000) {
      // Log debug info
      console.error(`[SysMLWrite DEBUG] Large output detected:`);
      console.error(`  path: ${fullPath}`);
      console.error(`  marker: ${marker}`);
      console.error(`  oldBytes: ${oldBytes}, newBytes: ${newBytes}`);
      console.error(`  diffLines count: ${resultLines}`);
      console.error(`  total JSON bytes: ${resultBytes}`);

      if (diffLines && diffLines.length > 0) {
        const addCount = diffLines.filter(l => l.type === "add").length;
        const delCount = diffLines.filter(l => l.type === "del").length;
        const ctxCount = diffLines.filter(l => l.type === "ctx").length;
        console.error(`  diffLines breakdown: ${addCount} adds, ${delCount} dels, ${ctxCount} ctx`);
        console.error(`  first 3 diffLines: ${JSON.stringify(diffLines.slice(0, 3))}`);
        console.error(`  last 3 diffLines: ${JSON.stringify(diffLines.slice(-3))}`);
      }

      // Return truncated result for now
      const truncatedResult: SysMLWriteResult = {
        path: fullPath,
        marker,
        oldBytes,
        newBytes,
        diffLines: diffLines ? diffLines.slice(0, 50) : null, // Only first 50 lines
      };
      if (diffLines && diffLines.length > 50) {
        return JSON.stringify(truncatedResult) + `\n[TRUNCATED: ${diffLines.length - 50} more diff lines]${semanticWarnings}`;
      }
    }

    return jsonResult + semanticWarnings;
  },
});

export const sysmlRead = createGadget({
  name: "SysMLRead",
  description: `Read SysML v2 content from the .sysml/ directory.

**Usage:**
SysMLRead(path="context/requirements.sysml")

Returns the file content with line numbers for easy reference when using search/replace.`,
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
      const lines = content.split("\n");
      const lineNumWidth = String(lines.length).length;

      // Format with line numbers for easy reference
      const numberedContent = lines
        .map((line, i) => {
          const lineNum = String(i + 1).padStart(lineNumWidth, " ");
          return `${lineNum} | ${line}`;
        })
        .join("\n");

      return `=== ${path} (${bytes} bytes, ${lines.length} lines) ===\n${numberedContent}`;
    } catch {
      return `Error: File not found: ${fullPath}`;
    }
  },
});

/**
 * Extract a summary from SysML file content.
 * Looks for the first doc comment (/** ... *\/) or the package description.
 */
function extractFileSummary(content: string): string | null {
  // Try to find a doc comment at the start
  const docMatch = content.match(/^\s*\/\*\*\s*([\s\S]*?)\s*\*\//);
  if (docMatch) {
    const docText = docMatch[1]
      .replace(/^\s*\*\s?/gm, "")
      .trim()
      .split("\n")[0]; // First line only
    if (docText.length > 0) {
      return docText.length > 80 ? docText.slice(0, 77) + "..." : docText;
    }
  }

  // Try to find package name and description from package declaration
  const pkgMatch = content.match(/package\s+(\w+)\s*\{/);
  if (pkgMatch) {
    // Look for a doc comment right before the package
    const beforePkg = content.slice(0, content.indexOf(pkgMatch[0]));
    const lastDocMatch = beforePkg.match(/\/\*\*\s*([\s\S]*?)\s*\*\/\s*$/);
    if (lastDocMatch) {
      const docText = lastDocMatch[1]
        .replace(/^\s*\*\s?/gm, "")
        .trim()
        .split("\n")[0];
      if (docText.length > 0) {
        return docText.length > 80 ? docText.slice(0, 77) + "..." : docText;
      }
    }
    return `Package: ${pkgMatch[1]}`;
  }

  return null;
}

export const sysmlList = createGadget({
  name: "SysMLList",
  description: `List all SysML files in the .sysml/ directory with summaries.

**Usage:**
SysMLList()

Returns a list of all .sysml files with their sizes and brief descriptions extracted from doc comments.`,
  schema: z.object({
    reason: z.string().describe(GADGET_REASON_DESCRIPTION),
  }),
  execute: async ({ reason: _reason }) => {
    const { readdir } = await import("node:fs/promises");
    const { join } = await import("node:path");

    const files: { path: string; bytes: number; summary?: string }[] = [];

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
            let summary: string | undefined;

            try {
              const content = await readFile(fullPath, "utf-8");
              summary = extractFileSummary(content) ?? undefined;
            } catch {
              // Couldn't read file for summary
            }

            files.push({
              path: relativePath,
              bytes: statResult.size,
              summary,
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

    const lines = files.map((f) => {
      const base = `${f.path} (${f.bytes} bytes)`;
      return f.summary ? `${base}\n  → ${f.summary}` : base;
    });
    const totalBytes = files.reduce((sum, f) => sum + f.bytes, 0);

    return `SysML Model Files:\n${lines.join("\n")}\n\nTotal: ${files.length} files, ${totalBytes} bytes`;
  },
});
