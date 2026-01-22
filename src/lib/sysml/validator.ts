/**
 * SysML v2 syntax validation.
 * Uses sysml-parser for full grammar-based validation with fallback to basic checks.
 */

import { validateDocument } from "sysml-parser";
import type { ValidationResult as SysmlParserResult } from "sysml-parser";

export interface ValidationIssue {
  line: number;
  column: number;
  message: string;
  severity: "error" | "warning" | "info";
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

/**
 * Suppress Chevrotain parser warnings during execution.
 * These "Ambiguous Alternatives Detected" warnings are internal parser details.
 */
function suppressParserWarnings<T>(fn: () => T): T {
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    const msg = args[0];
    if (typeof msg === "string" && msg.includes("Ambiguous Alternatives Detected")) {
      return; // Suppress Chevrotain grammar warnings
    }
    originalWarn.apply(console, args);
  };
  try {
    return fn();
  } finally {
    console.warn = originalWarn;
  }
}

/**
 * Validate SysML v2 content using sysml-parser.
 * Falls back to basic validation if sysml-parser fails.
 */
export async function validateSysml(content: string): Promise<ValidationResult> {
  try {
    const result: SysmlParserResult = await suppressParserWarnings(() => validateDocument(content));

    const issues: ValidationIssue[] = (await result).diagnostics.map((d) => ({
      line: (d.range?.start?.line ?? 0) + 1, // 0-indexed to 1-indexed
      column: (d.range?.start?.character ?? 0) + 1,
      message: d.message,
      severity: d.severity === 1 ? "error" : d.severity === 2 ? "warning" : "info",
    }));

    return {
      valid: (await result).isValid,
      issues,
    };
  } catch (error) {
    // Fallback to basic validation if sysml-parser fails
    console.warn("sysml-parser validation failed, falling back to basic validation:", error);
    return validateSysmlBasic(content);
  }
}

/**
 * Basic SysML v2 keywords and constructs.
 */
const KEYWORDS = new Set([
  "package",
  "part",
  "port",
  "item",
  "action",
  "state",
  "constraint",
  "requirement",
  "verification",
  "analysis",
  "import",
  "alias",
  "attribute",
  "enum",
  "flow",
  "connect",
  "bind",
  "interface",
  "metadata",
  "doc",
  "comment",
  "standard",
  "library",
  "private",
  "public",
  "protected",
  "abstract",
  "ref",
  "redefines",
  "subsets",
  "specializes",
  "def",
  "in",
  "out",
  "inout",
  "entry",
  "exit",
  "do",
  "transition",
  "from",
  "to",
  "on",
  "if",
  "then",
  "else",
  "first",
  "succession",
  "datatype",
  "objective",
  "subject",
  "results",
  "return",
]);

/**
 * Check for balanced braces.
 */
function checkBalancedBraces(content: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const stack: { char: string; line: number; column: number }[] = [];

  let line = 1;
  let column = 1;
  let inString = false;
  let inComment = false;
  let inBlockComment = false;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    const nextChar = content[i + 1];

    // Track position
    if (char === "\n") {
      line++;
      column = 1;
      inComment = false;
      continue;
    }

    // Handle comments
    if (!inString && !inBlockComment && char === "/" && nextChar === "/") {
      inComment = true;
    }
    if (!inString && !inComment && char === "/" && nextChar === "*") {
      inBlockComment = true;
      i++;
      column += 2;
      continue;
    }
    if (inBlockComment && char === "*" && nextChar === "/") {
      inBlockComment = false;
      i++;
      column += 2;
      continue;
    }

    if (inComment || inBlockComment) {
      column++;
      continue;
    }

    // Handle strings
    if (char === '"' && content[i - 1] !== "\\") {
      inString = !inString;
      column++;
      continue;
    }

    if (inString) {
      column++;
      continue;
    }

    // Check braces
    if (char === "{" || char === "(" || char === "[") {
      stack.push({ char, line, column });
    } else if (char === "}" || char === ")" || char === "]") {
      const expected = char === "}" ? "{" : char === ")" ? "(" : "[";
      const last = stack.pop();

      if (!last) {
        issues.push({
          line,
          column,
          message: `Unmatched closing '${char}'`,
          severity: "error",
        });
      } else if (last.char !== expected) {
        issues.push({
          line,
          column,
          message: `Mismatched braces: expected '${expected === "{" ? "}" : expected === "(" ? ")" : "]"}' but found '${char}'`,
          severity: "error",
        });
      }
    }

    column++;
  }

  // Check for unclosed braces
  for (const unclosed of stack) {
    issues.push({
      line: unclosed.line,
      column: unclosed.column,
      message: `Unclosed '${unclosed.char}'`,
      severity: "error",
    });
  }

  return issues;
}

/**
 * Check for common syntax patterns.
 */
function checkSyntaxPatterns(content: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const lines = content.split("\n");

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum];
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
      continue;
    }

    // Check for missing semicolons on attribute definitions
    if (trimmed.match(/^attribute\s+\w+\s*:\s*\w+.*[^;{]$/)) {
      // Allow multi-line definitions
      if (!trimmed.endsWith("{") && !trimmed.endsWith(",")) {
        issues.push({
          line: lineNum + 1,
          column: line.length,
          message: "Attribute definition may be missing a semicolon",
          severity: "warning",
        });
      }
    }

    // Check for invalid identifiers
    const identifierMatch = trimmed.match(/^(package|part|item|action|state|enum|interface|port)\s+def\s+(\S+)/);
    if (identifierMatch) {
      const identifier = identifierMatch[2];
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
        issues.push({
          line: lineNum + 1,
          column: line.indexOf(identifier) + 1,
          message: `Invalid identifier: '${identifier}'`,
          severity: "error",
        });
      }
    }

    // Check for double colons (common typo)
    if (trimmed.includes("::") && !trimmed.includes("import ") && !trimmed.includes("alias ")) {
      const colonIndex = trimmed.indexOf("::");
      if (colonIndex > 0 && trimmed[colonIndex - 1] !== " " && !trimmed.substring(0, colonIndex).includes("import")) {
        issues.push({
          line: lineNum + 1,
          column: line.indexOf("::") + 1,
          message: "Unexpected '::' - did you mean ':' for type annotation?",
          severity: "warning",
        });
      }
    }
  }

  return issues;
}

/**
 * Check for import/reference validity.
 */
function checkImports(content: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const lines = content.split("\n");
  const definedPackages = new Set<string>();
  const importedPackages = new Set<string>();

  // First pass: collect defined packages
  for (const line of lines) {
    const packageMatch = line.match(/^\s*(?:standard\s+library\s+)?package\s+(\w+)/);
    if (packageMatch) {
      definedPackages.add(packageMatch[1]);
    }
  }

  // Second pass: check imports
  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum];
    const importMatch = line.match(/^\s*import\s+(\S+)/);
    if (importMatch) {
      const importPath = importMatch[1].replace(";", "");
      const parts = importPath.split("::");
      const rootPackage = parts[0];

      importedPackages.add(rootPackage);

      // Check for self-import (warning)
      if (definedPackages.has(rootPackage) && parts.length === 1) {
        issues.push({
          line: lineNum + 1,
          column: line.indexOf(rootPackage) + 1,
          message: `Importing package '${rootPackage}' that is defined in the same file`,
          severity: "info",
        });
      }
    }
  }

  return issues;
}

/**
 * Basic fallback validation (used when sysml-parser is unavailable).
 */
function validateSysmlBasic(content: string): ValidationResult {
  const issues: ValidationIssue[] = [];

  // Run all checks
  issues.push(...checkBalancedBraces(content));
  issues.push(...checkSyntaxPatterns(content));
  issues.push(...checkImports(content));

  // Sort by line number
  issues.sort((a, b) => a.line - b.line || a.column - b.column);

  return {
    valid: issues.filter((i) => i.severity === "error").length === 0,
    issues,
  };
}

/**
 * Semantic issue detected by duplicate checking.
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
 * Check for duplicate definitions within a SysML file.
 * Returns warnings for any duplicates found.
 */
export function checkDuplicatesInFile(content: string): SemanticIssue[] {
  const issues: SemanticIssue[] = [];
  const lines = content.split("\n");

  // Track definitions by type
  const itemDefs = new Map<string, { line: number; column: number }>();
  const enumDefs = new Map<string, { line: number; column: number }>();
  const requirementDefs = new Map<string, { line: number; column: number }>();

  // Track attributes within blocks
  let currentBlockStart = -1;
  let currentBlockName = "";
  let currentBlockAttrs = new Map<string, { line: number; column: number }>();

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum];
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
      continue;
    }

    // Detect item definitions: "item def Name" or "part def Name"
    const itemMatch = trimmed.match(/^(item|part|action|state|analysis)\s+def\s+(\w+)/);
    if (itemMatch) {
      const name = itemMatch[2];
      const column = line.indexOf(name) + 1;

      if (itemDefs.has(name)) {
        const first = itemDefs.get(name)!;
        issues.push({
          line: lineNum + 1,
          column,
          message: `Duplicate ${itemMatch[1]} definition: '${name}' (first defined at line ${first.line})`,
          severity: "warning",
          type: "duplicate-item",
          name,
          firstOccurrence: first,
        });
      } else {
        itemDefs.set(name, { line: lineNum + 1, column });
      }

      // Start tracking attributes for this block
      currentBlockStart = lineNum + 1;
      currentBlockName = name;
      currentBlockAttrs = new Map();
    }

    // Detect enum definitions: "enum def Name"
    const enumMatch = trimmed.match(/^enum\s+def\s+(\w+)/);
    if (enumMatch) {
      const name = enumMatch[1];
      const column = line.indexOf(name) + 1;

      if (enumDefs.has(name)) {
        const first = enumDefs.get(name)!;
        issues.push({
          line: lineNum + 1,
          column,
          message: `Duplicate enum definition: '${name}' (first defined at line ${first.line})`,
          severity: "warning",
          type: "duplicate-enum",
          name,
          firstOccurrence: first,
        });
      } else {
        enumDefs.set(name, { line: lineNum + 1, column });
      }
    }

    // Detect requirement definitions: "requirement def Name"
    const reqMatch = trimmed.match(/^requirement\s+def\s+(\w+)/);
    if (reqMatch) {
      const name = reqMatch[1];
      const column = line.indexOf(name) + 1;

      if (requirementDefs.has(name)) {
        const first = requirementDefs.get(name)!;
        issues.push({
          line: lineNum + 1,
          column,
          message: `Duplicate requirement definition: '${name}' (first defined at line ${first.line})`,
          severity: "warning",
          type: "duplicate-requirement",
          name,
          firstOccurrence: first,
        });
      } else {
        requirementDefs.set(name, { line: lineNum + 1, column });
      }
    }

    // Detect attributes within a block: "attribute name : Type"
    const attrMatch = trimmed.match(/^attribute\s+(\w+)\s*:/);
    if (attrMatch && currentBlockStart > 0) {
      const name = attrMatch[1];
      const column = line.indexOf(name) + 1;

      if (currentBlockAttrs.has(name)) {
        const first = currentBlockAttrs.get(name)!;
        issues.push({
          line: lineNum + 1,
          column,
          message: `Duplicate attribute '${name}' in '${currentBlockName}' (first defined at line ${first.line})`,
          severity: "warning",
          type: "duplicate-attribute",
          name,
          firstOccurrence: first,
        });
      } else {
        currentBlockAttrs.set(name, { line: lineNum + 1, column });
      }
    }

    // Reset block tracking on closing brace at start of line (end of definition)
    if (trimmed === "}") {
      // Only reset if we're likely at the end of a major block
      // This is a heuristic - we check if there's no indentation
      if (!line.startsWith(" ") && !line.startsWith("\t")) {
        currentBlockStart = -1;
        currentBlockName = "";
        currentBlockAttrs = new Map();
      }
    }
  }

  return issues;
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
