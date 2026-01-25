/**
 * SysML Write Gadget
 * Modifies existing SysML v2 files in the .sysml/ directory.
 * Supports two modes:
 * 1. Set mode: Upsert elements into existing files via CLI (atomic)
 * 2. Delete mode: Remove elements from files via CLI
 *
 * For creating new files, use SysMLCreate gadget.
 */

import { createGadget, z } from "llmist";
import { writeFile, readFile, stat, readdir, unlink } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import {
  setElement,
  deleteElements,
} from "../lib/sysml/sysml2-cli.js";
import { GADGET_REASON_DESCRIPTION } from "../lib/constants.js";

/**
 * Clean up stale .tmp files for a given target file.
 *
 * The sysml2 CLI creates temp files with format: <filename>.tmp.<pid>
 * These get left behind if the process is killed or errors occur.
 *
 * @param targetPath - The target file path (e.g., .sysml/context/boundaries.sysml)
 */
async function cleanupStaleTmpFiles(targetPath: string): Promise<void> {
  try {
    const dir = dirname(targetPath);
    const base = basename(targetPath);
    const tmpPattern = `${base}.tmp.`;

    const entries = await readdir(dir);
    const staleTmpFiles = entries.filter(e => e.startsWith(tmpPattern));

    for (const tmpFile of staleTmpFiles) {
      try {
        await unlink(join(dir, tmpFile));
      } catch {
        // Ignore cleanup errors - file may have been cleaned up by another process
      }
    }
  } catch {
    // Ignore errors - directory may not exist yet
  }
}

/** Format byte delta as "+N bytes" or "-N bytes" */
function formatByteDelta(before: number, after: number): string {
  const delta = after - before;
  const sign = delta >= 0 ? "+" : "";
  return `${sign}${delta} bytes`;
}

export const sysmlWrite = createGadget({
  name: "SysMLWrite",
  maxConcurrent: 1,
  description: `Modify existing SysML v2 files in the .sysml/ directory.

**Two modes:**

1. **SET mode** (upsert elements - atomic):
   SysMLWrite(
     path="data/entities.sysml",
     element="item def User :> BaseEntity { attribute email : String; }",
     at="DataModel::Entities"
   )
   - element: SysML fragment to insert or replace
   - at: Qualified scope path (e.g., "DataModel::Entities")
   - createScope=true: Create scope hierarchy if missing
   - UPSERT semantics: replaces if element exists, adds if new
   - ATOMIC: On failure, file is restored to original state

2. **DELETE mode** (remove elements):
   SysMLWrite(path="data/entities.sysml", delete="DataModel::Entities::OldUser")

**To create new files, use SysMLCreate:**
   SysMLCreate(path="...", package="PackageName")
   SysMLCreate(path="...", package="PackageName", force=true)  // reset corrupted`,
  schema: z.object({
    reason: z.string().describe(GADGET_REASON_DESCRIPTION),
    path: z
      .string()
      .describe("File path relative to .sysml/ (e.g., 'context/requirements.sysml')"),

    // Mode 1: CLI upsert (for edits)
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

    // Mode 2: CLI delete
    delete: z
      .string()
      .optional()
      .describe("Element path to delete (e.g., 'DataModel::Entities::OldUser')"),

    // Common options
    dryRun: z
      .boolean()
      .optional()
      .describe("Preview changes without writing (default: false)"),
  }),
  execute: async ({ reason: _reason, path, element, at, createScope = false, delete: deletePattern, dryRun = false }) => {
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

    // Count active modes
    const activeModes = [isCliUpsert, isCliDelete].filter(Boolean).length;

    // Validate mode selection
    if (activeModes === 0) {
      return `Error: Must provide one of:
- 'element' + 'at' (upsert element into existing file)
- 'delete' (delete element from file)

To create new files, use SysMLCreate instead.`;
    }

    if (activeModes > 1) {
      return `Error: Cannot use multiple modes. Choose one of: element+at or delete`;
    }

    // Mode 1: CLI upsert - use sysml2 --set --at (atomic)
    if (isCliUpsert) {
      // Validate: Reject double-redefinition syntax (:>> name :>> name)
      // This pattern occurs when LLM sees existing :>> and tries to redefine again
      if (/:>>\s*\w+\s*:>>/.test(element!)) {
        return `path=${fullPath} status=error mode=upsert

INVALID SYNTAX: Double-redefinition detected (':>> name :>> name').

This happens when trying to redefine an already-redefined element.
Use either:
  - Declaration: 'port httpApi : HTTPPort { ... }'
  - OR Redefinition: ':>> httpApi { ... }' (no type, no extra :>>)

Do NOT combine both: ':>> httpApi : HTTPPort' or ':>> name :>> name'`;
      }

      // Check if file exists - CLI upsert requires existing file to parse
      const fileExists = await stat(fullPath).then(() => true).catch(() => false);

      if (!fileExists) {
        return `path=${fullPath} status=error mode=upsert

File does not exist. Create it first:
  SysMLCreate(path="${path}", package="PackageName")`;
      }

      // Clean up any stale .tmp files from previous failed writes
      await cleanupStaleTmpFiles(fullPath);

      // Read original content before modification (for atomic rollback)
      const originalContent = await readFile(fullPath, "utf-8");

      try {
        const result = await setElement(fullPath, element!, at!, {
          createScope,
          dryRun,
          parseOnly: true,  // Only check syntax, allow semantic issues
        });

        // Only fail on syntax errors (exit code 1), allow semantic errors (exit code 2)
        if (!result.syntaxValid) {
          // ATOMIC ROLLBACK: Restore original content on syntax errors
          await writeFile(fullPath, originalContent, "utf-8");

          const errorDiags = result.diagnostics.filter((d) => d.severity === "error");

          // Show parse error details with context
          const parseErrors = errorDiags.filter((d) => !d.code || !d.code.startsWith("E3"));
          if (parseErrors.length > 0) {
            const firstError = parseErrors[0];
            // Try to read the modified file to show the error in context
            let context = "";
            try {
              const modifiedContent = await readFile(fullPath, "utf-8");
              const lines = modifiedContent.split("\n");
              const badLine = lines[firstError.line - 1] || "";
              const lineNumWidth = String(firstError.line).length;
              const pointer = " ".repeat(lineNumWidth + 3 + firstError.column - 1) + "^";
              context = `\n${firstError.line} | ${badLine}\n${pointer}`;
            } catch {
              // Couldn't read modified file, just show error without context
            }

            return `path=${fullPath} status=error mode=upsert (rolled back)

SYNTAX ERROR - the fragment could not be parsed.

Line ${firstError.line}:${firstError.column}: ${firstError.message}${context}

Check the element syntax and try again.`;
          }

          // Default: show all errors
          const errors = errorDiags
            .map((d) => `  Line ${d.line}:${d.column}: ${d.message}`)
            .join("\n");
          return `path=${fullPath} status=error mode=upsert (rolled back)\n\nSyntax error:\n${errors || result.stderr || "Unknown error"}`;
        }

        const actionDesc = result.replaced > 0 ? "replaced" : "added";
        const dryRunNote = dryRun ? " (dry run)" : "";

        // Get new file size for delta calculation
        const newContent = await readFile(fullPath, "utf-8");
        const originalBytes = Buffer.byteLength(originalContent, "utf-8");
        const newBytes = Buffer.byteLength(newContent, "utf-8");
        const delta = formatByteDelta(originalBytes, newBytes);

        return `path=${fullPath} status=success mode=upsert${dryRunNote} delta=${delta}
Element ${actionDesc} at scope: ${at}
Added: ${result.added}, Replaced: ${result.replaced}`;
      } catch (err) {
        // ATOMIC ROLLBACK: Restore original content on exception
        await writeFile(fullPath, originalContent, "utf-8");
        return `path=${fullPath} status=error mode=upsert (rolled back)\n\nError: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    // Mode 2: CLI delete - use sysml2 --delete
    if (isCliDelete) {
      // Read original content for size tracking
      const originalContent = await readFile(fullPath, "utf-8");
      const originalBytes = Buffer.byteLength(originalContent, "utf-8");

      try {
        const result = await deleteElements(fullPath, [deletePattern!], { dryRun });

        if (!result.success) {
          const errors = result.diagnostics
            .filter((d) => d.severity === "error")
            .map((d) => `  Line ${d.line}:${d.column}: ${d.message}`)
            .join("\n");
          return `path=${fullPath} status=error mode=delete\n\nCLI delete failed:\n${errors || result.stderr || "Unknown error"}`;
        }

        const dryRunNote = dryRun ? " (dry run)" : "";
        if (result.deleted === 0) {
          return `path=${fullPath} status=success mode=delete${dryRunNote} delta=+0 bytes
Element not found: ${deletePattern}
(Nothing was deleted)`;
        }

        // Get new file size for delta calculation
        const newContent = await readFile(fullPath, "utf-8");
        const newBytes = Buffer.byteLength(newContent, "utf-8");
        const delta = formatByteDelta(originalBytes, newBytes);

        return `path=${fullPath} status=success mode=delete${dryRunNote} delta=${delta}
Deleted: ${result.deleted} element(s) matching: ${deletePattern}`;
      } catch (err) {
        return `path=${fullPath} status=error mode=delete\n\nError: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    // Should not reach here - all modes are handled above
    return `Error: Internal error - no mode matched`;
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
