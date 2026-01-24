/**
 * sysml2 CLI Wrapper
 *
 * Provides a TypeScript interface to the globally-installed sysml2 CLI tool.
 */

import { spawn } from "node:child_process";

// sysml2 is assumed to be globally installed in PATH
const SYSML2_CMD = "sysml2";

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
  const args = ["--color=never"];
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
