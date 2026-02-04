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
import { generatePlainDiff } from "../lib/diff-utils.js";
import {
  isDebugEnabled,
  writeEditDebug,
  type EditDebugMetadata,
} from "../lib/edit-debug.js";
import { getCoverageContext } from "./file-viewer-next.js";
import { checkCycleCoverage, type CoverageResult } from "../lib/sysml/index.js";

/** Tracks repeated delete failures per file:pattern to break retry loops */
const deleteFailureTracker = new Map<string, number>();

// ---------------------------------------------------------------------------
// Coverage cache (avoids re-scanning hundreds of files on every SysMLWrite)
// ---------------------------------------------------------------------------
let cachedCoverage: CoverageResult | null = null;
let cachedCoverageTime = 0;
const COVERAGE_CACHE_TTL_MS = 10_000; // 10 seconds

async function getCachedCoverage(): Promise<CoverageResult | null> {
  const ctx = getCoverageContext();
  if (!ctx) return null;

  const now = Date.now();
  if (cachedCoverage && now - cachedCoverageTime < COVERAGE_CACHE_TTL_MS) {
    return cachedCoverage;
  }

  try {
    cachedCoverage = await checkCycleCoverage(ctx.cycle, ctx.basePath, ctx.readFiles);
    cachedCoverageTime = now;
    return cachedCoverage;
  } catch {
    return null;
  }
}

/** Invalidate the coverage cache (call after coverage refresh in cycle-runner). */
export function invalidateCoverageCache(): void {
  cachedCoverage = null;
  cachedCoverageTime = 0;
}

// ---------------------------------------------------------------------------
// Stall state shared with cycle-runner (for write rejection at severe stall)
// ---------------------------------------------------------------------------
let sysmlWriteStallState: {
  writesWithoutIncrease: number;
  missingFiles: string[];
  coveragePercent?: number;
} | null = null;

/**
 * Set the stall state for SysMLWrite rejection logic.
 * Call from cycle-runner to make stall info visible to the gadget.
 */
export function setSysmlWriteStallState(state: typeof sysmlWriteStallState): void {
  sysmlWriteStallState = state;
}

// ---------------------------------------------------------------------------
// @SourceFile path extraction from SysML element text
// ---------------------------------------------------------------------------
const SOURCE_FILE_REGEX = /@SourceFile\s*\{\s*(?::>>\s*)?path\s*=\s*"([^"]+)"/g;

/** Extract @SourceFile paths from a SysML element string. */
function extractSourceFilePaths(element: string): string[] {
  const paths: string[] = [];
  let match;
  SOURCE_FILE_REGEX.lastIndex = 0;
  while ((match = SOURCE_FILE_REGEX.exec(element)) !== null) {
    const p = match[1].trim();
    if (p) paths.push(p);
  }
  SOURCE_FILE_REGEX.lastIndex = 0;
  return paths;
}

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
   - replaceScope=true: Clear scope before inserting (preserves fragment order)
   - UPSERT semantics: replaces if element exists, adds if new
   - ATOMIC: On failure, file is restored to original state

   ⚠️ **IMPORTANT**: Do NOT wrap your element in a package matching the \`at\` scope!

   WRONG: element="package Foo { item def X; }", at="Foo"
   RIGHT: element="item def X;", at="Foo"

   The \`at\` parameter specifies WHERE to place the element - don't duplicate the scope.

   **When to use replaceScope=true (DANGER - READ CAREFULLY!):**

   ⚠️ **DATA LOSS WARNING**: replaceScope=true CLEARS the entire scope first!
   You MUST include ALL existing elements in your element parameter, not just the
   ones you're modifying. If you only provide partial content, the rest will be
   PERMANENTLY DELETED.

   Use this when fixing E3002 "feature not found" errors caused by wrong element order:
   1. First, use \`SysMLRead\` to see all elements in the file
   2. Include ALL existing elements in your element parameter
   3. Reorder them correctly (declarations before redefinitions)
   4. Then use replaceScope=true

   \`\`\`
   // WRONG - Only includes 2 elements - everything else in the scope will be DELETED!
   SysMLWrite(element="part def B;\\npart def C :> B;", at="Pkg", replaceScope=true)

   // CORRECT - Includes ALL elements from the scope, in correct order:
   SysMLWrite(
     element="part def A;\\npart def B;\\npart def C :> B;\\npart def D;\\npart def E;",
     at="Pkg",
     replaceScope=true
   )
   \`\`\`

   Example - replacing all scope children:
   \`\`\`
   SysMLWrite(
     path="data/entities.sysml",
     element="item def User { attribute name : String; }\\nitem def Order { attribute total : Real; }",
     at="DataEntities",
     replaceScope=true
   )
   \`\`\`

2. **DELETE mode** (remove elements):
   SysMLWrite(path="data/entities.sysml", delete="DataModel::Entities::OldUser")

**Validation:**
   - Full validation (syntax + semantic) runs on every write
   - Syntax errors block writes and trigger rollback
   - Semantic errors (E3xxx) are reported as warnings but do NOT block writes
     (during incremental ingestion, cross-file type errors are expected)

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
    replaceScope: z
      .boolean()
      .optional()
      .describe("Clear target scope before inserting (preserves fragment element order)"),

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
  execute: async ({ reason: _reason, path, element, at, createScope = false, replaceScope = false, delete: deletePattern, dryRun = false }) => {
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

      // Guard: reject replaceScope on large elements to prevent token bombs
      if (replaceScope && element) {
        const elementBytes = Buffer.byteLength(element, "utf-8");
        if (elementBytes > 10_000) {
          return `path=${fullPath} status=error mode=upsert

ELEMENT TOO LARGE FOR replaceScope (${elementBytes} bytes).

replaceScope=true rewrites the entire scope and outputs all content as tokens.
For large scopes, use targeted SysMLWrite operations instead:
1. Use SysMLWrite with delete to remove broken elements
2. Use SysMLWrite upsert to add/update specific elements
3. Only use replaceScope=true on small scopes (< 10KB)

Do NOT rewrite entire packages — fix individual elements.`;
        }
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

      // Prepare debug metadata
      const debugEnabled = isDebugEnabled();
      const baseDebugMetadata: Partial<EditDebugMetadata> = debugEnabled
        ? {
            timestamp: new Date().toISOString(),
            operation: "upsert",
            gadget: "SysMLWrite",
            path: fullPath,
            scope: at,
            createScope,
            replaceScope,
            bytesOriginal: Buffer.byteLength(originalContent, "utf-8"),
            dryRun,
          }
        : {};

      try {
        const result = await setElement(fullPath, element!, at!, {
          createScope,
          dryRun,
          parseOnly: false,  // Always run full validation (syntax + semantic)
          replaceScope,
          forceReplace: replaceScope,  // The gadget description already warns about data loss; suppress the CLI's redundant guard
          allowSemanticErrors: true,
        });

        // Check for "target scope not found" error from stderr
        if (result.stderr?.includes("target scope") && result.stderr?.includes("not found")) {
          // Extract the scope name from the error message
          const scopeMatch = result.stderr.match(/target scope '([^']+)' not found/);
          const missingScope = scopeMatch ? scopeMatch[1] : at;

          // Debug logging
          if (debugEnabled) {
            writeEditDebug({
              metadata: {
                ...baseDebugMetadata,
                status: "error",
                bytesResult: Buffer.byteLength(originalContent, "utf-8"),
                byteDelta: 0,
                errorMessage: `Target scope '${missingScope}' not found`,
              } as EditDebugMetadata,
              original: originalContent,
              fragment: element!,
              result: originalContent,
            }).catch(() => {});
          }

          return `path=${fullPath} status=error mode=upsert

TARGET SCOPE NOT FOUND: '${missingScope}'

The scope '${missingScope}' does not exist in the file.

Available behavioral scopes in SystemBehavior:
  - SystemBehavior::Operations
  - SystemBehavior::StateMachines
  - SystemBehavior::EventHandlers
  - SystemBehavior::SystemOperations
  - SystemBehavior::ServiceBehaviors
  - SystemBehavior::EntityStateMachines
  - SystemBehavior::DomainEvents

To create a new scope, use createScope=true:
  SysMLWrite(
    path="${path}",
    element="${element!.slice(0, 100)}${element!.length > 100 ? '...' : ''}",
    at="${at}",
    createScope=true
  )`;
        }

        // Only fail on syntax errors (exit code 1), allow semantic errors (exit code 2)
        if (!result.syntaxValid) {
          // ATOMIC ROLLBACK: Restore original content on syntax errors
          await writeFile(fullPath, originalContent, "utf-8");

          // Debug logging for rollback
          if (debugEnabled) {
            const errorDiags = result.diagnostics.filter((d) => d.severity === "error");
            writeEditDebug({
              metadata: {
                ...baseDebugMetadata,
                status: "rollback",
                bytesResult: Buffer.byteLength(originalContent, "utf-8"),
                byteDelta: 0,
                added: result.added,
                replaced: result.replaced,
                errorMessage: errorDiags[0]?.message || "Syntax error",
                diagnostics: errorDiags.map((d) => ({
                  severity: d.severity,
                  message: d.message,
                  line: d.line,
                  column: d.column,
                })),
              } as EditDebugMetadata,
              original: originalContent,
              fragment: element!,
              result: originalContent,
            }).catch(() => {});
          }

          return `path=${fullPath} status=error mode=upsert (rolled back)

SYNTAX ERROR - the fragment could not be parsed.

${result.stderr || "Unknown parse error"}

Check the element syntax and try again.`;
        }

        const dryRunNote = dryRun ? " (dry run)" : "";

        // Get new file size for delta calculation
        const newContent = await readFile(fullPath, "utf-8");
        const originalBytes = Buffer.byteLength(originalContent, "utf-8");
        const newBytes = Buffer.byteLength(newContent, "utf-8");
        const delta = formatByteDelta(originalBytes, newBytes);

        // Debug logging for success
        if (debugEnabled) {
          writeEditDebug({
            metadata: {
              ...baseDebugMetadata,
              status: "success",
              bytesResult: newBytes,
              byteDelta: newBytes - originalBytes,
              added: result.added,
              replaced: result.replaced,
              diagnostics: result.diagnostics
                .filter((d) => d.severity === "error")
                .map((d) => ({
                  severity: d.severity,
                  message: d.message,
                  line: d.line,
                  column: d.column,
                })),
            } as EditDebugMetadata,
            original: originalContent,
            fragment: element!,
            result: newContent,
          }).catch(() => {});
        }

        // Check if content is unchanged - tell LLM clearly so it doesn't keep retrying
        if (originalContent === newContent) {
          return `path=${fullPath} status=unchanged mode=upsert delta=+0 bytes
Content identical - no changes made. All elements in your fragment already exist in this file.
Do NOT re-send the same elements. Focus on uncovered source files instead.
Use SysMLRead to inspect file contents, or SysMLList to see all files.`;
        }

        // Reject zero-coverage writes at severe stall
        if (sysmlWriteStallState && sysmlWriteStallState.writesWithoutIncrease >= 6
            && result.added === 0 && result.replaced > 0) {
          const pct = sysmlWriteStallState.coveragePercent ?? 0;
          const stalls = sysmlWriteStallState.writesWithoutIncrease;
          const uncoveredSample = sysmlWriteStallState.missingFiles.slice(0, 10);
          const fileList = uncoveredSample.map(f => `- ${f}`).join("\n");
          const moreCount = sysmlWriteStallState.missingFiles.length - uncoveredSample.length;
          const moreNote = moreCount > 0 ? `\n- ... and ${moreCount} more` : "";

          return `path=${fullPath} status=error mode=upsert

ERROR: Write rejected — coverage stalled at ${pct}% (${stalls} writes without increase).
All @SourceFile paths in this write are already covered. You MUST write elements
for UNCOVERED source files instead.

Uncovered files to document:
${fileList}${moreNote}`;
        }

        // Generate diff for CLI display (colors for human, plain +/- for LLM)
        // Suppress or limit diff for pure-replacement writes (no new content — diff is noise)
        const diffLineLimit = (result.added === 0 && result.replaced > 0) ? 0
          : (result.added > 0 && result.replaced > 0 && result.added < result.replaced * 0.1) ? 5
          : 50;
        const diffOutput = diffLineLimit === 0 ? "" : "\n\n" + generatePlainDiff(originalContent, newContent, diffLineLimit);

        // Warn if no changes were made but element was provided
        if (result.added === 0 && result.replaced === 0 && element && element.trim()) {
          return `path=${fullPath} status=warning mode=upsert delta=${delta}
WARNING: No elements were added or replaced.
The element may already exist, or the scope '${at}' was not found.
Use SysMLRead to inspect file contents, or SysMLList to see all files.`;
        }

        const actionDesc = result.replaced > 0 ? "replaced" : "added";

        // Hard warning when all elements already existed — coverage is not increasing
        let efficiencyNote = "";
        if (result.replaced > 0 && result.added === 0) {
          const coverage = await getCachedCoverage();
          if (coverage && coverage.missingFiles.length > 0) {
            const pct = coverage.coveragePercent;
            const missing = coverage.missingFiles.length;
            const sourcePaths = extractSourceFilePaths(element!);
            const alreadyCoveredList = sourcePaths.length > 0
              ? sourcePaths.map(p => `  - ${p}`).join("\n")
              : "  (could not extract @SourceFile paths from element)";
            const suggestedFiles = coverage.missingFiles.slice(0, 8);
            const suggestedPaths = suggestedFiles.map(f => `  "${f}"`).join("\n");
            const moreCount = missing - suggestedFiles.length;
            const moreNote = moreCount > 0 ? `\n  ... and ${moreCount} more uncovered files` : "";

            efficiencyNote = `\n\nSTOP — COVERAGE NOT INCREASING (${pct}%, ${missing} files still missing)
All ${result.replaced} elements ALREADY EXISTED. The files you wrote about are already covered:
${alreadyCoveredList}

You MUST request UNCOVERED files instead. Use FileViewerNextFileSet with these paths:
${suggestedPaths}${moreNote}`;
          } else {
            efficiencyNote = `\nNOTE: All ${result.replaced} elements already existed and were updated. No new content added.`;
          }
        }

        // Include validation status based on exit code
        // Exit 0 = all good, Exit 2 = semantic errors remain
        let validationNote = "";
        if (result.exitCode === 0) {
          validationNote = "\n✓ Model validation passed";
        } else if (result.exitCode === 2) {
          const stderrLines = (result.stderr || "").split("\n").filter(l => l.trim());
          if (stderrLines.length > 0) {
            const preview = stderrLines.slice(0, 8).join("\n");
            const more = stderrLines.length > 8 ? `\n  ... and more (${stderrLines.length} lines total)` : "";
            validationNote = "\n⚠ Semantic errors remain:\n" + preview + more;
          }
        }

        return `path=${fullPath} status=success mode=upsert${dryRunNote} delta=${delta}
Element ${actionDesc} at scope: ${at}
Added: ${result.added}, Replaced: ${result.replaced}${efficiencyNote}${validationNote}${diffOutput}`;
      } catch (err) {
        // ATOMIC ROLLBACK: Restore original content on exception
        await writeFile(fullPath, originalContent, "utf-8");

        // Debug logging for error
        if (debugEnabled) {
          writeEditDebug({
            metadata: {
              ...baseDebugMetadata,
              status: "error",
              bytesResult: Buffer.byteLength(originalContent, "utf-8"),
              byteDelta: 0,
              errorMessage: err instanceof Error ? err.message : String(err),
            } as EditDebugMetadata,
            original: originalContent,
            fragment: element!,
            result: originalContent,
          }).catch(() => {});
        }

        return `path=${fullPath} status=error mode=upsert (rolled back)\n\nError: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    // Mode 2: CLI delete - use sysml2 --delete
    if (isCliDelete) {
      // Clean up any stale .tmp files from previous failed writes
      await cleanupStaleTmpFiles(fullPath);

      // Read original content for size tracking
      const originalContent = await readFile(fullPath, "utf-8");
      const originalBytes = Buffer.byteLength(originalContent, "utf-8");

      // Prepare debug metadata
      const debugEnabled = isDebugEnabled();
      const baseDebugMetadata: Partial<EditDebugMetadata> = debugEnabled
        ? {
            timestamp: new Date().toISOString(),
            operation: "delete",
            gadget: "SysMLWrite",
            path: fullPath,
            scope: deletePattern,
            bytesOriginal: originalBytes,
            dryRun,
          }
        : {};

      try {
        const result = await deleteElements(fullPath, [deletePattern!], {
          dryRun,
          allowSemanticErrors: true,
        });

        if (!result.success) {
          const errorDiags = result.diagnostics.filter((d) => d.severity === "error");
          const errors = errorDiags
            .map((d) => `  Line ${d.line}:${d.column}: ${d.message}`)
            .join("\n");

          // Debug logging for delete error
          if (debugEnabled) {
            writeEditDebug({
              metadata: {
                ...baseDebugMetadata,
                status: "error",
                bytesResult: originalBytes,
                byteDelta: 0,
                deleted: 0,
                errorMessage: errorDiags[0]?.message || result.stderr || "Unknown error",
                diagnostics: errorDiags.map((d) => ({
                  severity: d.severity,
                  message: d.message,
                  line: d.line,
                  column: d.column,
                })),
              } as EditDebugMetadata,
              original: originalContent,
              fragment: deletePattern!,
              result: originalContent,
            }).catch(() => {});
          }

          return `path=${fullPath} status=error mode=delete\n\nCLI delete failed:\n${errors || result.stderr || "Unknown error"}`;
        }

        const dryRunNote = dryRun ? " (dry run)" : "";
        if (result.deleted === 0) {
          // Circuit breaker: track repeated failures to prevent retry loops
          const failKey = `${fullPath}:${deletePattern}`;
          const failCount = (deleteFailureTracker.get(failKey) ?? 0) + 1;
          deleteFailureTracker.set(failKey, failCount);

          // Debug logging for no-op delete
          if (debugEnabled) {
            writeEditDebug({
              metadata: {
                ...baseDebugMetadata,
                status: "success",
                bytesResult: originalBytes,
                byteDelta: 0,
                deleted: 0,
              } as EditDebugMetadata,
              original: originalContent,
              fragment: deletePattern!,
              result: originalContent,
            }).catch(() => {});
          }

          if (failCount >= 3) {
            deleteFailureTracker.delete(failKey);
            return `path=${fullPath} status=error mode=delete

REPEATED FAILURE (${failCount} attempts): Cannot delete '${deletePattern}'.

**Do NOT retry this delete.** Instead:
1. Use SysMLWrite to upsert a corrected version of the element
2. Or use SysMLCreate(path="...", force=true) to recreate the file`;
          }

          return `path=${fullPath} status=success mode=delete${dryRunNote} delta=+0 bytes
Element not found: ${deletePattern}
(Nothing was deleted)`;
        }

        // Successful delete — clear any failure tracking
        deleteFailureTracker.delete(`${fullPath}:${deletePattern}`);

        // Get new file size for delta calculation
        const newContent = await readFile(fullPath, "utf-8");
        const newBytes = Buffer.byteLength(newContent, "utf-8");
        const delta = formatByteDelta(originalBytes, newBytes);

        // Debug logging for successful delete
        if (debugEnabled) {
          writeEditDebug({
            metadata: {
              ...baseDebugMetadata,
              status: "success",
              bytesResult: newBytes,
              byteDelta: newBytes - originalBytes,
              deleted: result.deleted,
            } as EditDebugMetadata,
            original: originalContent,
            fragment: deletePattern!,
            result: newContent,
          }).catch(() => {});
        }

        const diffOutput = "\n\n" + generatePlainDiff(originalContent, newContent, Infinity);

        return `path=${fullPath} status=success mode=delete${dryRunNote} delta=${delta}
Deleted: ${result.deleted} element(s) matching: ${deletePattern}${diffOutput}`;
      } catch (err) {
        // Debug logging for delete exception
        if (debugEnabled) {
          writeEditDebug({
            metadata: {
              ...baseDebugMetadata,
              status: "error",
              bytesResult: originalBytes,
              byteDelta: 0,
              deleted: 0,
              errorMessage: err instanceof Error ? err.message : String(err),
            } as EditDebugMetadata,
            original: originalContent,
            fragment: deletePattern!,
            result: originalContent,
          }).catch(() => {});
        }

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
SysMLRead(path="context/requirements.sysml")              — full file
SysMLRead(path="context/requirements.sysml", offset=100, limit=50) — lines 100-149

Returns the file content with line numbers for easy reference when using search/replace.`,
  schema: z.object({
    reason: z.string().describe(GADGET_REASON_DESCRIPTION),
    path: z
      .string()
      .describe("File path relative to .sysml/ (e.g., 'context/requirements.sysml')"),
    offset: z.number().optional().describe("Line number to start reading from (1-based, default: 1)"),
    limit: z.number().optional().describe("Maximum number of lines to return (default: all lines)"),
  }),
  execute: async ({ reason: _reason, path, offset, limit }) => {
    const fullPath = join(".sysml", path);

    try {
      const content = await readFile(fullPath, "utf-8");
      const bytes = Buffer.byteLength(content, "utf-8");
      const lines = content.split("\n");

      const startLine = Math.max(1, offset ?? 1);
      const startIdx = startLine - 1;
      const selectedLines =
        limit != null ? lines.slice(startIdx, startIdx + limit) : lines.slice(startIdx);

      const lineNumWidth = String(lines.length).length;
      const numberedContent = selectedLines
        .map((line, i) => {
          const lineNum = String(startIdx + i + 1).padStart(lineNumWidth, " ");
          return `${lineNum} | ${line}`;
        })
        .join("\n");

      const endLine = startIdx + selectedLines.length;
      const rangeNote =
        startLine > 1 || limit != null ? ` [lines ${startLine}-${endLine} of ${lines.length}]` : "";

      return `=== ${path} (${bytes} bytes, ${lines.length} lines)${rangeNote} ===\n${numberedContent}`;
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
