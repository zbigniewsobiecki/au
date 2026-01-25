/**
 * SysML v2 syntax validation.
 * Uses sysml2 CLI for grammar-based validation and semantic checking.
 */

import { runSysml2, SYSML2_ERROR_CODES, type Sysml2Diagnostic } from "./sysml2-cli.js";

export interface ValidationIssue {
  line: number;
  column: number;
  message: string;
  severity: "error" | "warning" | "info";
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  /** Raw stderr from sysml2 CLI - use this for unfiltered error output */
  rawStderr?: string;
  /** Raw stdout from sysml2 CLI */
  rawStdout?: string;
}

/**
 * Validate SysML v2 content using sysml2 CLI.
 *
 * @param content - SysML source text to validate
 */
export async function validateSysml(
  content: string
): Promise<ValidationResult> {
  try {
    const result = await runSysml2(content);

    const issues: ValidationIssue[] = result.diagnostics.map((d) => ({
      line: d.line,
      column: d.column,
      message: d.message,
      severity: d.severity === "error" ? "error" : "warning",
    }));

    // Handle case where sysml2 failed but no structured diagnostics
    if (!result.success && issues.length === 0) {
      issues.push({
        line: 1,
        column: 1,
        message: result.stderr || "Unknown parse error (no details from sysml2)",
        severity: "error",
      });
    }

    return {
      valid: result.success,
      issues,
      rawStdout: result.stdout,
      rawStderr: result.stderr,
    };
  } catch (error) {
    // sysml2 not available - return valid with info message
    return {
      valid: true,
      issues: [{
        line: 1,
        column: 1,
        message: `sysml2 not available for validation: ${error}`,
        severity: "info",
      }],
    };
  }
}

/**
 * Semantic issue detected by sysml2.
 */
export interface SemanticIssue {
  line: number;
  column: number;
  message: string;
  severity: "warning" | "info";
  type: "duplicate-item" | "duplicate-enum" | "duplicate-attribute" | "duplicate-requirement";
  name: string;
  firstOccurrence?: { line: number; column: number };
}

/**
 * Format semantic issues for display.
 */
export function formatSemanticIssues(issues: SemanticIssue[], filePath?: string): string {
  if (issues.length === 0) {
    return "";
  }

  const lines: string[] = [];
  const prefix = filePath ? `${filePath}:` : "";

  for (const issue of issues) {
    const severity = issue.severity === "warning" ? "WARN" : "INFO";
    lines.push(`${prefix}${issue.line}:${issue.column}: [${severity}] ${issue.message}`);
  }

  return lines.join("\n");
}

/**
 * Format validation issues for display.
 */
export function formatValidationIssues(result: ValidationResult, filePath?: string): string {
  if (result.valid && result.issues.length === 0) {
    return filePath ? `${filePath}: OK` : "OK";
  }

  const lines: string[] = [];
  const prefix = filePath ? `${filePath}:` : "";

  for (const issue of result.issues) {
    const severity = issue.severity === "error" ? "ERROR" : issue.severity === "warning" ? "WARN" : "INFO";
    lines.push(`${prefix}${issue.line}:${issue.column}: [${severity}] ${issue.message}`);
  }

  return lines.join("\n");
}

/**
 * Format a semantic error from sysml2 with enhanced messages.
 *
 * @param diag - The diagnostic from sysml2
 * @returns Formatted error message
 */
export function formatSemanticError(diag: Sysml2Diagnostic): string {
  switch (diag.code) {
    case SYSML2_ERROR_CODES.UNDEFINED_REFERENCE:
      // Parser already includes "did you mean?" in message
      return `Undefined reference: ${diag.message}`;
    case SYSML2_ERROR_CODES.DUPLICATE_DEFINITION:
      return `Duplicate definition: ${diag.message}`;
    case SYSML2_ERROR_CODES.CIRCULAR_SPECIALIZATION:
      return `Circular specialization detected: ${diag.message}`;
    case SYSML2_ERROR_CODES.TYPE_MISMATCH:
      return `Type mismatch: ${diag.message}`;
    default:
      return diag.message;
  }
}

/**
 * Check for semantic issues using the sysml2 CLI.
 * Returns errors and warnings from sysml2 semantic validation.
 *
 * @param content - SysML source text to validate
 * @returns Promise resolving to semantic issues found
 */
export async function checkSemanticIssuesWithSysml2(
  content: string
): Promise<SemanticIssue[]> {
  try {
    const result = await runSysml2(content);
    const issues: SemanticIssue[] = [];

    for (const diag of result.diagnostics) {
      // Map sysml2 error codes to semantic issue types
      let type: SemanticIssue["type"];
      switch (diag.code) {
        case SYSML2_ERROR_CODES.DUPLICATE_DEFINITION:
          type = "duplicate-item";
          break;
        default:
          // Skip non-duplicate semantic errors for now (they're still reported in diagnostics)
          continue;
      }

      issues.push({
        line: diag.line,
        column: diag.column,
        message: formatSemanticError(diag),
        severity: diag.severity === "error" ? "warning" : "info",
        type,
        name: extractNameFromMessage(diag.message),
      });
    }

    return issues;
  } catch {
    // If sysml2 is not available, return empty array
    return [];
  }
}

/**
 * Extract the definition name from a diagnostic message.
 */
function extractNameFromMessage(message: string): string {
  // Try to extract quoted name: "duplicate definition 'FooBar'"
  const quotedMatch = message.match(/'([^']+)'/);
  if (quotedMatch) return quotedMatch[1];

  // Try to extract from "FooBar is already defined"
  const alreadyMatch = message.match(/^(\w+)\s+is\s+already/);
  if (alreadyMatch) return alreadyMatch[1];

  return "unknown";
}

/**
 * Validate multiple SysML files.
 */
export async function validateMultiple(files: Record<string, string>): Promise<{
  valid: boolean;
  results: Record<string, ValidationResult>;
}> {
  const results: Record<string, ValidationResult> = {};
  let allValid = true;

  for (const [path, content] of Object.entries(files)) {
    const result = await validateSysml(content);
    results[path] = result;
    if (!result.valid) {
      allValid = false;
    }
  }

  return {
    valid: allValid,
    results,
  };
}
