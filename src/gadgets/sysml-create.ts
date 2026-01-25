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
      return `Error: File already exists: ${fullPath}. Use SysMLWrite for targeted writes, or use force=true to wipe this file clean and overwrite.`;
    }

    // Track original size for delta (if file exists)
    let originalBytes = 0;
    if (fileExists) {
      const originalContent = await readFile(fullPath, "utf-8");
      originalBytes = Buffer.byteLength(originalContent, "utf-8");
    }

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
    // Semantic errors are expected when stdlib isn't fully loaded
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

    return `path=${fullPath} status=success delta=${delta}
${fileExists ? "Reset" : "Created"} package: ${pkgName}`;
  },
});
