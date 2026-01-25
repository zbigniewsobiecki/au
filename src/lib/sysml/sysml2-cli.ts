/**
 * sysml2 CLI Wrapper
 *
 * Provides a TypeScript interface to the globally-installed sysml2 CLI tool.
 */

import { spawn } from "node:child_process";

// sysml2 is assumed to be globally installed in PATH
const SYSML2_CMD = "sysml2";

/**
 * Semantic error codes from sysml2 parser.
 */
export const SYSML2_ERROR_CODES = {
  UNDEFINED_REFERENCE: "E3001", // "did you mean?" suggestions
  DUPLICATE_DEFINITION: "E3004",
  CIRCULAR_SPECIALIZATION: "E3005",
  TYPE_MISMATCH: "E3006",
} as const;

export interface Sysml2Diagnostic {
  line: number;
  column: number;
  severity: "error" | "warning";
  code: string;
  message: string;
}

export interface Sysml2Element {
  id: string;
  name: string;
  type: string;
  parent: string | null;
}

export interface Sysml2Relationship {
  id: string;
  kind: string;
  source: string;
  target: string;
}

export interface Sysml2Result {
  meta: { version: string; source: string };
  elements: Sysml2Element[];
  relationships: Sysml2Relationship[];
  diagnostics: Sysml2Diagnostic[];
  success: boolean;
}

/**
 * Get library path arguments from SYSML2_LIBRARY_PATH environment variable.
 * Format: colon-separated paths like PATH, e.g., "/path/to/lib1:/path/to/lib2"
 *
 * Also automatically includes the project's .sysml/ directory if it exists,
 * so imports like `import SysMLPrimitives::*` resolve to the project's SysMLPrimitives.sysml.
 */
function getLibraryPathArgs(): string[] {
  const args: string[] = [];

  // Always include the project's .sysml/ directory first (highest priority)
  // This allows project-specific stdlib to override external libraries
  args.push("-I", ".sysml");

  // Add paths from SYSML2_LIBRARY_PATH environment variable
  const libraryPath = process.env.SYSML2_LIBRARY_PATH;
  if (libraryPath) {
    for (const p of libraryPath.split(":").filter(Boolean)) {
      args.push("-I", p);
    }
  }

  return args;
}

/**
 * Run sysml2 on the provided content.
 *
 * @param content - SysML source text to parse
 * @param options - Options for the sysml2 invocation
 * @returns Promise resolving to the sysml2 result
 */
export async function runSysml2(
  content: string,
  options?: { json?: boolean }
): Promise<Sysml2Result> {
  const args = ["--color=never", ...getLibraryPathArgs()];
  if (options?.json) args.push("-f", "json");

  return new Promise((resolve, reject) => {
    const proc = spawn(SYSML2_CMD, args, { stdio: ["pipe", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data;
    });
    proc.stderr.on("data", (data) => {
      stderr += data;
    });

    proc.on("close", (code) => {
      const diagnostics = parseDiagnosticOutput(stderr);
      const success = code === 0;

      if (options?.json && stdout.trim()) {
        try {
          const json = JSON.parse(stdout);
          resolve({ ...json, diagnostics, success });
        } catch {
          resolve({
            meta: { version: "1.0", source: "<stdin>" },
            elements: [],
            relationships: [],
            diagnostics,
            success: false,
          });
        }
      } else {
        resolve({
          meta: { version: "1.0", source: "<stdin>" },
          elements: [],
          relationships: [],
          diagnostics,
          success,
        });
      }
    });

    proc.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error(`sysml2 not found in PATH. Install sysml2 globally.`));
      } else {
        reject(err);
      }
    });

    proc.stdin.write(content);
    proc.stdin.end();
  });
}

export interface Sysml2MultiDiagnostic extends Sysml2Diagnostic {
  file: string;
}

// ============================================================================
// CLI-based Select/Set/Delete Operations
// ============================================================================

export interface SelectResult {
  elements: Sysml2Element[];
  relationships: Sysml2Relationship[];
  success: boolean;
  raw?: string;
}

export interface SetResult {
  success: boolean;
  modifiedFile: string;
  added: number;
  replaced: number;
  diagnostics: Sysml2Diagnostic[];
}

export interface DeleteResult {
  success: boolean;
  modifiedFile: string;
  deleted: number;
  diagnostics: Sysml2Diagnostic[];
}

export interface Sysml2MultiResult {
  meta: { version: string };
  diagnostics: Sysml2MultiDiagnostic[];
  success: boolean;
}

/**
 * Run sysml2 on multiple files together.
 * Enables cross-file validation where imports can resolve across files.
 *
 * @param files - Array of file paths to validate
 * @param options - Options for the sysml2 invocation
 * @returns Promise resolving to the sysml2 result
 */
export async function runSysml2Multi(
  files: string[],
  options?: { json?: boolean }
): Promise<Sysml2MultiResult> {
  if (files.length === 0) {
    return {
      meta: { version: "1.0" },
      diagnostics: [],
      success: true,
    };
  }

  const args = ["--color=never", ...getLibraryPathArgs(), ...files];
  if (options?.json) args.push("-f", "json");

  return new Promise((resolve, reject) => {
    const proc = spawn(SYSML2_CMD, args, { stdio: ["pipe", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data;
    });
    proc.stderr.on("data", (data) => {
      stderr += data;
    });

    proc.on("close", (code) => {
      const diagnostics = parseMultiFileDiagnosticOutput(stderr);
      const success = code === 0;

      if (options?.json && stdout.trim()) {
        try {
          const json = JSON.parse(stdout);
          resolve({ ...json, diagnostics, success });
        } catch {
          resolve({
            meta: { version: "1.0" },
            diagnostics,
            success: false,
          });
        }
      } else {
        resolve({
          meta: { version: "1.0" },
          diagnostics,
          success,
        });
      }
    });

    proc.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error(`sysml2 not found in PATH. Install sysml2 globally.`));
      } else {
        reject(err);
      }
    });

    proc.stdin.end();
  });
}

/**
 * Strip ANSI escape codes from a string.
 */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Parse clang-style diagnostic output from stderr.
 *
 * Format: filename:line:column: error[CODE]: message
 */
function parseDiagnosticOutput(stderr: string): Sysml2Diagnostic[] {
  const diagnostics: Sysml2Diagnostic[] = [];
  // Strip ANSI escape codes first (sysml2 may output colors even with --color=never)
  const cleanStderr = stripAnsi(stderr);
  const pattern =
    /^(.+?):(\d+):(\d+):\s*(error|warning)(?:\[([A-Z]\d+)\])?:\s*(.+)$/gm;

  let match;
  while ((match = pattern.exec(cleanStderr)) !== null) {
    diagnostics.push({
      line: parseInt(match[2], 10),
      column: parseInt(match[3], 10),
      severity: match[4] as "error" | "warning",
      code: match[5] || "",
      message: match[6],
    });
  }

  return diagnostics;
}

/**
 * Parse clang-style diagnostic output from stderr for multi-file validation.
 * Includes file path in each diagnostic.
 *
 * Format: filename:line:column: error[CODE]: message
 */
function parseMultiFileDiagnosticOutput(stderr: string): Sysml2MultiDiagnostic[] {
  const diagnostics: Sysml2MultiDiagnostic[] = [];
  const cleanStderr = stripAnsi(stderr);
  const pattern =
    /^(.+?):(\d+):(\d+):\s*(error|warning)(?:\[([A-Z]\d+)\])?:\s*(.+)$/gm;

  let match;
  while ((match = pattern.exec(cleanStderr)) !== null) {
    diagnostics.push({
      file: match[1],
      line: parseInt(match[2], 10),
      column: parseInt(match[3], 10),
      severity: match[4] as "error" | "warning",
      code: match[5] || "",
      message: match[6],
    });
  }

  return diagnostics;
}

// ============================================================================
// CLI-based Select/Set/Delete Functions
// ============================================================================

/**
 * Select elements from SysML files using the CLI --select option.
 *
 * @param files - Array of file paths to query
 * @param patterns - Array of select patterns (e.g., 'Pkg::*', 'Pkg::**', 'Element')
 * @param options - Options for the select operation
 * @returns Promise resolving to the select result
 */
export async function selectElements(
  files: string[],
  patterns: string[],
  options?: { format?: "json" | "sysml" }
): Promise<SelectResult> {
  if (files.length === 0) {
    return {
      elements: [],
      relationships: [],
      success: true,
    };
  }

  const args = ["--color=never", ...getLibraryPathArgs()];

  // Add select patterns
  for (const pattern of patterns) {
    args.push("--select", pattern);
  }

  // Add format option
  if (options?.format === "json") {
    args.push("-f", "json");
  }

  // Add files
  args.push(...files);

  return new Promise((resolve, reject) => {
    const proc = spawn(SYSML2_CMD, args, { stdio: ["pipe", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data;
    });
    proc.stderr.on("data", (data) => {
      stderr += data;
    });

    proc.on("close", (code) => {
      const success = code === 0;

      if (options?.format === "json" && stdout.trim()) {
        try {
          const json = JSON.parse(stdout);
          resolve({
            elements: json.elements ?? [],
            relationships: json.relationships ?? [],
            success,
            raw: stdout,
          });
        } catch {
          resolve({
            elements: [],
            relationships: [],
            success: false,
            raw: stdout,
          });
        }
      } else {
        resolve({
          elements: [],
          relationships: [],
          success,
          raw: stdout,
        });
      }
    });

    proc.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error(`sysml2 not found in PATH. Install sysml2 globally.`));
      } else {
        reject(err);
      }
    });

    proc.stdin.end();
  });
}

/**
 * Set (upsert) an element in a SysML file using the CLI --set option.
 *
 * @param targetFile - The file to modify
 * @param fragment - SysML source text to insert/replace
 * @param scope - Qualified scope path where the element should be placed
 * @param options - Options for the set operation
 * @returns Promise resolving to the set result
 */
export async function setElement(
  targetFile: string,
  fragment: string,
  scope: string,
  options?: { createScope?: boolean; dryRun?: boolean }
): Promise<SetResult> {
  // Write fragment to a temporary file
  const { writeFile, unlink } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const tmpFile = join(tmpdir(), `sysml2-fragment-${Date.now()}.sysml`);
  await writeFile(tmpFile, fragment, "utf-8");

  try {
    const args = ["--color=never", ...getLibraryPathArgs()];

    // Add set options
    args.push("--set", tmpFile);
    args.push("--at", scope);

    if (options?.createScope) {
      args.push("--create-scope");
    }

    if (options?.dryRun) {
      args.push("--dry-run");
    }

    args.push("-f", "json");
    args.push(targetFile);

    return new Promise((resolve, reject) => {
      const proc = spawn(SYSML2_CMD, args, { stdio: ["pipe", "pipe", "pipe"] });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data) => {
        stdout += data;
      });
      proc.stderr.on("data", (data) => {
        stderr += data;
      });

      proc.on("close", (code) => {
        const diagnostics = parseDiagnosticOutput(stderr);
        const success = code === 0;

        // Try to parse JSON output for details
        let added = 0;
        let replaced = 0;

        if (stdout.trim()) {
          try {
            const json = JSON.parse(stdout);
            added = json.added ?? 0;
            replaced = json.replaced ?? 0;
          } catch {
            // CLI may not output JSON for set operations
            // Infer success from exit code
            if (success) {
              added = 1; // Assume one element was added
            }
          }
        }

        resolve({
          success,
          modifiedFile: targetFile,
          added,
          replaced,
          diagnostics,
        });
      });

      proc.on("error", (err) => {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new Error(`sysml2 not found in PATH. Install sysml2 globally.`));
        } else {
          reject(err);
        }
      });

      proc.stdin.end();
    });
  } finally {
    // Cleanup temp file
    try {
      await unlink(tmpFile);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Delete elements from a SysML file using the CLI --delete option.
 *
 * @param targetFile - The file to modify
 * @param patterns - Array of element paths to delete (e.g., 'Pkg::Element')
 * @param options - Options for the delete operation
 * @returns Promise resolving to the delete result
 */
export async function deleteElements(
  targetFile: string,
  patterns: string[],
  options?: { dryRun?: boolean }
): Promise<DeleteResult> {
  const args = ["--color=never", ...getLibraryPathArgs()];

  // Add delete patterns
  for (const pattern of patterns) {
    args.push("--delete", pattern);
  }

  if (options?.dryRun) {
    args.push("--dry-run");
  }

  args.push("-f", "json");
  args.push(targetFile);

  return new Promise((resolve, reject) => {
    const proc = spawn(SYSML2_CMD, args, { stdio: ["pipe", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data;
    });
    proc.stderr.on("data", (data) => {
      stderr += data;
    });

    proc.on("close", (code) => {
      const diagnostics = parseDiagnosticOutput(stderr);
      const success = code === 0;

      // Try to parse JSON output for details
      let deleted = 0;

      if (stdout.trim()) {
        try {
          const json = JSON.parse(stdout);
          deleted = json.deleted ?? 0;
        } catch {
          // CLI may not output JSON for delete operations
          // Infer from success
          if (success) {
            deleted = patterns.length;
          }
        }
      }

      resolve({
        success,
        modifiedFile: targetFile,
        deleted,
        diagnostics,
      });
    });

    proc.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error(`sysml2 not found in PATH. Install sysml2 globally.`));
      } else {
        reject(err);
      }
    });

    proc.stdin.end();
  });
}
