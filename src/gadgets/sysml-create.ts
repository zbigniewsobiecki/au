/**
 * SysML Create Gadget
 * Creates new SysML v2 files with package scaffolds.
 * Supports optional initial content and force option for recovery.
 */

import { createGadget, z } from "llmist";
import { writeFile, mkdir, stat, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { GADGET_REASON_DESCRIPTION } from "../lib/constants.js";
import { runSysml2 } from "../lib/sysml/sysml2-cli.js";
import { generateColoredDiff } from "../lib/diff-utils.js";
import {
  isDebugEnabled,
  writeEditDebug,
  type EditDebugMetadata,
} from "../lib/edit-debug.js";

/** Format byte delta as "+N bytes" or "-N bytes" */
function formatByteDelta(before: number, after: number): string {
  const delta = after - before;
  const sign = delta >= 0 ? "+" : "";
  return `${sign}${delta} bytes`;
}

export const sysmlCreate = createGadget({
  name: "SysMLCreate",
  maxConcurrent: 1,
  description: `Create a new SysML file with a package scaffold.

Use force=true to reset a corrupted file (overwrites existing).

Examples:
  SysMLCreate(path="context/boundaries.sysml", package="SystemContext")
  → Creates: package SystemContext { }

  SysMLCreate(path="data/entities.sysml", package="Entities", content="item def User { attribute name : String; }")
  → Creates: package Entities { item def User { attribute name : String; } }`,
  schema: z.object({
    reason: z.string().describe(GADGET_REASON_DESCRIPTION),
    path: z
      .string()
      .describe("File path relative to .sysml/ (e.g., 'context/boundaries.sysml')"),
    package: z.string().describe("Package name to create"),
    content: z
      .string()
      .optional()
      .describe("Initial content to place inside the package (SysML elements)"),
    force: z
      .boolean()
      .optional()
      .describe("Overwrite existing file (for recovery from syntax errors)"),
  }),
  execute: async ({ reason: _reason, path, package: pkgName, content, force = false }) => {
    // Ensure path ends with .sysml
    if (!path.endsWith(".sysml")) {
      return `Error: File path must end with .sysml extension`;
    }

    // Block writes to manifest files
    if (path.endsWith("/manifest.sysml") || path === "manifest.sysml") {
      return `Error: Cannot create manifest files via SysMLCreate.`;
    }

    const fullPath = join(".sysml", path);
    const fileExists = await stat(fullPath).then(() => true).catch(() => false);

    if (fileExists && !force) {
      // Check if existing file has the same package - if so, this is idempotent
      try {
        const existingContent = await readFile(fullPath, "utf-8");
        const existingPkgMatch = existingContent.match(/package\s+(\w+)\s*\{/);
        if (existingPkgMatch && existingPkgMatch[1] === pkgName) {
          // Same package already exists - this is idempotent, return success
          const bytes = Buffer.byteLength(existingContent, "utf-8");
          return `path=${fullPath} status=success delta=+0 bytes
Package ${pkgName} already exists (no changes needed)`;
        }
      } catch {
        // Couldn't read existing file, fall through to error
      }
      return `Error: File already exists: ${fullPath}

→ To ADD/UPDATE elements in this file, use SysMLWrite:
  SysMLWrite(path="${path}", element="...", at="${pkgName}")

→ To RESET a corrupted file, use SysMLCreate with force=true:
  SysMLCreate(path="${path}", package="${pkgName}", force=true)

NEVER use SysMLCreate on existing files without force=true.`;
    }

    // Track original content for delta and diff (if file exists)
    let originalBytes = 0;
    let originalContent = "";
    if (fileExists) {
      originalContent = await readFile(fullPath, "utf-8");
      originalBytes = Buffer.byteLength(originalContent, "utf-8");
    }

    // Prepare debug metadata
    const debugEnabled = isDebugEnabled();
    const baseDebugMetadata: Partial<EditDebugMetadata> = debugEnabled
      ? {
          timestamp: new Date().toISOString(),
          operation: "create",
          gadget: "SysMLCreate",
          path: fullPath,
          bytesOriginal: originalBytes,
          dryRun: false,
        }
      : {};

    // Create directory if needed
    const dir = dirname(fullPath);
    if (dir && dir !== ".") {
      await mkdir(dir, { recursive: true });
    }

    // Write package with optional content
    let finalContent: string;
    if (content) {
      // Check if content is already a full package definition
      const pkgMatch = content.match(/^package\s+(\w+)\s*\{([\s\S]*)\}\s*$/);
      if (pkgMatch) {
        // Content is already a full package - use it directly (ignore package param)
        finalContent = content.endsWith("\n") ? content : content + "\n";
      } else {
        // Content is inner elements - wrap in package
        const indented = content.split("\n").join("\n    ");
        finalContent = `package ${pkgName} {\n    ${indented}\n}\n`;
      }
    } else {
      // No content - create empty package
      finalContent = `package ${pkgName} {\n}\n`;
    }

    // Validate content before writing to prevent syntax errors
    // Only reject on PARSE errors (no error code), not semantic errors (E3001 undefined type, etc.)
    // Semantic errors are expected during incremental model building - cross-package
    // references fail until all files exist
    try {
      const validation = await runSysml2(finalContent);
      if (!validation.success) {
        // Parse errors have no code, semantic errors have codes like E3001
        const parseErrors = validation.diagnostics
          .filter((d) => d.severity === "error" && !d.code);

        if (parseErrors.length > 0) {
          const errors = parseErrors
            .map((d) => {
              const lines = finalContent.split("\n");
              const badLine = lines[d.line - 1] || "";
              return `Line ${d.line}:${d.column}: ${d.message}\n  ${d.line} | ${badLine}`;
            })
            .join("\n\n");

          // Debug logging for syntax error
          if (debugEnabled) {
            writeEditDebug({
              metadata: {
                ...baseDebugMetadata,
                status: "error",
                bytesResult: originalBytes,
                byteDelta: 0,
                errorMessage: parseErrors[0]?.message || "Syntax error",
                diagnostics: parseErrors.map((d) => ({
                  severity: d.severity,
                  message: d.message,
                  line: d.line,
                  column: d.column,
                })),
              } as EditDebugMetadata,
              original: originalContent,
              fragment: content || `package ${pkgName} {}`,
              result: originalContent,
            }).catch(() => {});
          }

          return `path=${fullPath} status=error (syntax error)

INVALID SYSML SYNTAX - refusing to write corrupted file.

${errors}

Fix the syntax errors and try again.`;
        }
        // Semantic errors (undefined types) are OK - stdlib may not be fully loaded
      }
    } catch {
      // sysml2 not available - skip validation (allow write)
      // This matches the behavior in validator.ts
    }

    await writeFile(fullPath, finalContent, "utf-8");

    const newBytes = Buffer.byteLength(finalContent, "utf-8");
    const delta = formatByteDelta(originalBytes, newBytes);

    // Debug logging for successful create
    if (debugEnabled) {
      writeEditDebug({
        metadata: {
          ...baseDebugMetadata,
          status: "success",
          bytesResult: newBytes,
          byteDelta: newBytes - originalBytes,
        } as EditDebugMetadata,
        original: originalContent,
        fragment: content || `package ${pkgName} {}`,
        result: finalContent,
      }).catch(() => {});
    }

    // Generate diff for force overwrite cases (shows what was replaced)
    let diffOutput = "";
    if (fileExists && originalContent !== finalContent) {
      diffOutput = "\n\n" + generateColoredDiff(originalContent, finalContent);
    }

    return `path=${fullPath} status=success delta=${delta}
${fileExists ? "Reset" : "Created"} package: ${pkgName}${diffOutput}`;
  },
});
