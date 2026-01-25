/**
 * SysML v2 Parser
 *
 * Uses the sysml2 CLI for parsing and validation.
 */

import {
  runSysml2,
  type Sysml2Result,
} from "../lib/sysml/sysml2-cli.js";

// Re-export types for compatibility
export * from "./ast/types.js";

/** Diagnostic severity levels (LSP-compatible) */
export type DiagnosticSeverity = 1 | 2 | 3 | 4; // 1=error, 2=warning, 3=info, 4=hint

/** Position in source text */
export interface DiagnosticPosition {
  line: number;
  character: number;
}

/** Range in source text */
export interface DiagnosticRange {
  start: DiagnosticPosition;
  end: DiagnosticPosition;
}

/** A diagnostic message */
export interface Diagnostic {
  message: string;
  severity: DiagnosticSeverity;
  range?: DiagnosticRange;
}

/** Result of parsing a document */
export interface ParseResult {
  ast?: unknown;
  lexerErrors: Array<{ message: string; line: number; column: number }>;
  parserErrors: Array<{ message: string; line: number; column: number }>;
  hasErrors: boolean;
}

/** Result of validating a document */
export interface ValidationResult {
  ast?: unknown;
  diagnostics: Diagnostic[];
  errors: Diagnostic[];
  warnings: Diagnostic[];
  hints: Diagnostic[];
  isValid: boolean;
}

/**
 * Validate a SysML v2 document using sysml2 CLI.
 *
 * @param content - The SysML source text
 * @param _uri - Optional document URI (for error messages)
 * @returns Validation result with diagnostics
 */
export async function validateDocument(
  content: string,
  _uri?: string
): Promise<ValidationResult> {
  try {
    const result = await runSysml2(content);
    return convertSysml2Result(result);
  } catch (error) {
    // Fallback to basic validation if sysml2 is unavailable
    console.warn("sysml2 unavailable:", error);
    return validateDocumentBasic(content);
  }
}

/**
 * Parse a SysML v2 document using sysml2 CLI.
 *
 * @param content - The SysML source text
 * @param _uri - Optional document URI (for error messages)
 * @returns Parse result with any errors
 */
export async function parseDocument(
  content: string,
  _uri?: string
): Promise<ParseResult> {
  const validation = await validateDocument(content, _uri);
  return {
    ast: undefined,
    lexerErrors: [],
    parserErrors: validation.errors.map((e) => ({
      message: e.message,
      line: e.range?.start.line || 1,
      column: e.range?.start.character || 1,
    })),
    hasErrors: !validation.isValid,
  };
}

/**
 * Convert sysml2 result to ValidationResult.
 */
function convertSysml2Result(result: Sysml2Result): ValidationResult {
  const diagnostics: Diagnostic[] = result.diagnostics.map((d) => ({
    message: d.code ? `[${d.code}] ${d.message}` : d.message,
    severity: d.severity === "error" ? 1 : 2,
    range: {
      start: { line: d.line, character: d.column },
      end: { line: d.line, character: d.column + 1 },
    },
  }));

  return {
    ast: undefined,
    diagnostics,
    errors: diagnostics.filter((d) => d.severity === 1),
    warnings: diagnostics.filter((d) => d.severity === 2),
    hints: [],
    isValid: result.success,
  };
}

/**
 * Basic fallback validation when sysml2 is unavailable.
 * Performs simple syntax checks.
 */
function validateDocumentBasic(content: string): ValidationResult {
  const diagnostics: Diagnostic[] = [];

  // Check for basic syntax issues
  const lines = content.split("\n");
  let braceCount = 0;
  let inString = false;
  let inComment = false;
  let inBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    for (let j = 0; j < line.length; j++) {
      const char = line[j];
      const nextChar = line[j + 1];
      const prevChar = j > 0 ? line[j - 1] : "";

      // Handle strings
      if (char === '"' && prevChar !== "\\") {
        inString = !inString;
        continue;
      }

      if (inString) continue;

      // Handle block comments
      if (char === "/" && nextChar === "*") {
        inBlockComment = true;
        j++;
        continue;
      }
      if (char === "*" && nextChar === "/") {
        inBlockComment = false;
        j++;
        continue;
      }

      if (inBlockComment) continue;

      // Handle line comments
      if (char === "/" && nextChar === "/") {
        break; // Rest of line is comment
      }

      // Count braces
      if (char === "{") braceCount++;
      if (char === "}") braceCount--;

      if (braceCount < 0) {
        diagnostics.push({
          message: "Unmatched closing brace '}'",
          severity: 1,
          range: {
            start: { line: i + 1, character: j + 1 },
            end: { line: i + 1, character: j + 2 },
          },
        });
        braceCount = 0;
      }
    }
  }

  if (braceCount > 0) {
    diagnostics.push({
      message: `Unclosed brace - ${braceCount} opening brace(s) without matching close`,
      severity: 1,
      range: {
        start: { line: lines.length, character: 1 },
        end: { line: lines.length, character: 2 },
      },
    });
  }

  if (inString) {
    diagnostics.push({
      message: "Unterminated string literal",
      severity: 1,
      range: {
        start: { line: lines.length, character: 1 },
        end: { line: lines.length, character: 2 },
      },
    });
  }

  if (inBlockComment) {
    diagnostics.push({
      message: "Unterminated block comment",
      severity: 1,
      range: {
        start: { line: lines.length, character: 1 },
        end: { line: lines.length, character: 2 },
      },
    });
  }

  return {
    ast: undefined,
    diagnostics,
    errors: diagnostics.filter((d) => d.severity === 1),
    warnings: diagnostics.filter((d) => d.severity === 2),
    hints: [],
    isValid: diagnostics.filter((d) => d.severity === 1).length === 0,
  };
}
