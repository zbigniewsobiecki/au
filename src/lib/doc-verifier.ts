import { readFile, stat, readdir } from "node:fs/promises";
import { join, dirname, relative } from "node:path";
import { parse } from "yaml";
import type { DocPlanStructure, DocumentOutline } from "../gadgets/doc-gadgets.js";

/**
 * Issue severity levels for verification results.
 */
export type IssueSeverity = "error" | "warning" | "info";

/**
 * Issue categories for classification.
 */
export type IssueCategory = "missing" | "outdated" | "inaccurate" | "incomplete" | "structural";

/**
 * A single verification issue found in documentation.
 */
export interface VerificationIssue {
  documentPath: string;
  severity: IssueSeverity;
  category: IssueCategory;
  description: string;
  suggestion?: string;
}

/**
 * Result of deterministic verification for a single document.
 */
export interface DocumentVerificationResult {
  path: string;
  exists: boolean;
  issues: VerificationIssue[];
}

/**
 * Overall verification result.
 */
export interface VerificationResult {
  totalDocuments: number;
  documentsChecked: number;
  passed: number;
  warnings: number;
  errors: number;
  documents: DocumentVerificationResult[];
}

/**
 * Parsed frontmatter from a markdown document.
 */
interface ParsedFrontmatter {
  title?: string;
  description?: string;
  sidebar?: {
    order?: number;
  };
  [key: string]: unknown;
}

/**
 * DocVerifier performs deterministic checks on generated documentation.
 * It validates document structure, frontmatter, cross-references, and source paths.
 */
export class DocVerifier {
  constructor(
    private targetDir: string,
    private projectPath: string = "."
  ) {}

  /**
   * Run all deterministic checks against the documentation plan.
   */
  async runDeterministicChecks(plan: DocPlanStructure): Promise<VerificationResult> {
    const allDocs = plan.structure.flatMap((dir) =>
      dir.documents.map((doc) => ({
        ...doc,
        directory: dir.directory,
      }))
    );

    const results: DocumentVerificationResult[] = [];
    let passed = 0;
    let warnings = 0;
    let errors = 0;

    for (const doc of allDocs) {
      const docResult = await this.verifyDocument(doc);
      results.push(docResult);

      // Count issues by severity
      const docErrors = docResult.issues.filter((i) => i.severity === "error").length;
      const docWarnings = docResult.issues.filter((i) => i.severity === "warning").length;

      if (docErrors > 0) {
        errors += docErrors;
      } else if (docWarnings > 0) {
        warnings += docWarnings;
      }

      if (docResult.exists && docErrors === 0) {
        passed++;
      }
    }

    return {
      totalDocuments: allDocs.length,
      documentsChecked: results.filter((r) => r.exists).length,
      passed,
      warnings,
      errors,
      documents: results,
    };
  }

  /**
   * Verify a single document with all deterministic checks.
   */
  private async verifyDocument(
    doc: DocumentOutline & { directory: string }
  ): Promise<DocumentVerificationResult> {
    const issues: VerificationIssue[] = [];
    const fullPath = join(this.targetDir, doc.path);

    // Check 1: Document exists
    const existsIssues = await this.checkDocumentExists(doc.path);
    issues.push(...existsIssues);

    if (existsIssues.length > 0) {
      // Document doesn't exist, can't do other checks
      return { path: doc.path, exists: false, issues };
    }

    // Read document content for further checks
    let content: string;
    try {
      content = await readFile(fullPath, "utf-8");
    } catch {
      return { path: doc.path, exists: false, issues };
    }

    // Check 2: Frontmatter validity
    const frontmatterIssues = this.checkFrontmatter(doc.path, content);
    issues.push(...frontmatterIssues);

    // Check 3: Required sections presence
    if (doc.sections && doc.sections.length > 0) {
      const sectionIssues = this.checkSections(doc.path, content, doc.sections);
      issues.push(...sectionIssues);
    }

    // Check 4: Cross-reference link validity
    const crossRefIssues = await this.checkCrossReferences(doc.path, content);
    issues.push(...crossRefIssues);

    // Check 5: Source/SysML paths existence
    const pathIssues = await this.checkSourcePathsExist(doc);
    issues.push(...pathIssues);

    return { path: doc.path, exists: true, issues };
  }

  /**
   * Check if a document exists.
   */
  private async checkDocumentExists(docPath: string): Promise<VerificationIssue[]> {
    const fullPath = join(this.targetDir, docPath);
    try {
      await stat(fullPath);
      return [];
    } catch {
      return [
        {
          documentPath: docPath,
          severity: "error",
          category: "missing",
          description: `Document does not exist: ${docPath}`,
          suggestion: `Run 'au document --target ${this.targetDir}' to generate missing documents`,
        },
      ];
    }
  }

  /**
   * Check frontmatter validity.
   */
  private checkFrontmatter(docPath: string, content: string): VerificationIssue[] {
    const issues: VerificationIssue[] = [];

    // Check for frontmatter presence
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!frontmatterMatch) {
      issues.push({
        documentPath: docPath,
        severity: "error",
        category: "structural",
        description: "Missing frontmatter",
        suggestion: "Add YAML frontmatter with title, description, and sidebar order",
      });
      return issues;
    }

    // Parse frontmatter
    let frontmatter: ParsedFrontmatter;
    try {
      frontmatter = parse(frontmatterMatch[1]) || {};
    } catch (error) {
      issues.push({
        documentPath: docPath,
        severity: "error",
        category: "structural",
        description: `Invalid YAML frontmatter: ${error instanceof Error ? error.message : "parse error"}`,
      });
      return issues;
    }

    // Check required fields
    if (!frontmatter.title) {
      issues.push({
        documentPath: docPath,
        severity: "warning",
        category: "incomplete",
        description: "Frontmatter missing 'title' field",
      });
    }

    if (!frontmatter.description) {
      issues.push({
        documentPath: docPath,
        severity: "warning",
        category: "incomplete",
        description: "Frontmatter missing 'description' field",
      });
    }

    if (!frontmatter.sidebar?.order && frontmatter.sidebar?.order !== 0) {
      issues.push({
        documentPath: docPath,
        severity: "info",
        category: "incomplete",
        description: "Frontmatter missing 'sidebar.order' field",
      });
    }

    return issues;
  }

  /**
   * Check if required sections are present in the document.
   */
  private checkSections(docPath: string, content: string, expectedSections: string[]): VerificationIssue[] {
    const issues: VerificationIssue[] = [];

    // Extract headings from content (## and ### level)
    const headingMatches = content.matchAll(/^#{2,3}\s+(.+)$/gm);
    const actualHeadings = new Set(
      Array.from(headingMatches).map((m) =>
        m[1]
          .toLowerCase()
          .trim()
          .replace(/[^\w\s]/g, "")
      )
    );

    for (const section of expectedSections) {
      const normalizedSection = section
        .toLowerCase()
        .trim()
        .replace(/[^\w\s]/g, "");

      // Check for exact or close match
      let found = false;
      for (const heading of actualHeadings) {
        if (heading.includes(normalizedSection) || normalizedSection.includes(heading)) {
          found = true;
          break;
        }
      }

      if (!found) {
        issues.push({
          documentPath: docPath,
          severity: "warning",
          category: "incomplete",
          description: `Missing section: "${section}"`,
          suggestion: `Add a section with heading "## ${section}"`,
        });
      }
    }

    return issues;
  }

  /**
   * Check if cross-reference links are valid (point to existing documents).
   */
  private async checkCrossReferences(docPath: string, content: string): Promise<VerificationIssue[]> {
    const issues: VerificationIssue[] = [];

    // Find markdown links that are relative paths to .md files
    const linkMatches = content.matchAll(/\[([^\]]+)\]\(([^)]+\.md)\)/g);

    for (const match of linkMatches) {
      const [, linkText, linkPath] = match;

      // Skip external links
      if (linkPath.startsWith("http://") || linkPath.startsWith("https://")) {
        continue;
      }

      // Resolve the path relative to the document's directory
      const docDir = dirname(docPath);
      const resolvedPath = join(docDir, linkPath).replace(/^\.\//, "");
      const fullPath = join(this.targetDir, resolvedPath);

      try {
        await stat(fullPath);
      } catch {
        issues.push({
          documentPath: docPath,
          severity: "warning",
          category: "structural",
          description: `Broken cross-reference link: "${linkText}" -> ${linkPath}`,
          suggestion: `Check if the target document exists at ${resolvedPath}`,
        });
      }
    }

    return issues;
  }

  /**
   * Check if sourcePaths and mustCoverPaths actually exist.
   */
  private async checkSourcePathsExist(doc: DocumentOutline): Promise<VerificationIssue[]> {
    const issues: VerificationIssue[] = [];

    // Check sourcePaths
    if (doc.sourcePaths) {
      for (const sourcePath of doc.sourcePaths) {
        const fullPath = join(this.projectPath, sourcePath);
        try {
          await stat(fullPath);
        } catch {
          issues.push({
            documentPath: doc.path,
            severity: "warning",
            category: "outdated",
            description: `Referenced source path does not exist: ${sourcePath}`,
            suggestion: "Update the documentation plan to remove or fix this path",
          });
        }
      }
    }

    // Check mustCoverPaths (these reference SysML paths, check if source exists)
    if (doc.mustCoverPaths) {
      for (const coverPath of doc.mustCoverPaths) {
        const fullPath = join(this.projectPath, coverPath);
        try {
          await stat(fullPath);
        } catch {
          issues.push({
            documentPath: doc.path,
            severity: "info",
            category: "outdated",
            description: `mustCoverPath does not exist: ${coverPath}`,
            suggestion: "The source code may have been moved or deleted",
          });
        }
      }
    }

    // Check validationFiles
    if (doc.validationFiles) {
      for (const valFile of doc.validationFiles) {
        const fullPath = join(this.projectPath, valFile);
        try {
          await stat(fullPath);
        } catch {
          issues.push({
            documentPath: doc.path,
            severity: "warning",
            category: "outdated",
            description: `Validation file does not exist: ${valFile}`,
            suggestion: "Update the documentation plan to fix this path",
          });
        }
      }
    }

    return issues;
  }

  /**
   * Get a summary of verification results for console output.
   */
  static getSummary(result: VerificationResult): string {
    const lines: string[] = [];
    lines.push(`Documents: ${result.totalDocuments}`);
    lines.push(`Checked: ${result.documentsChecked}`);
    lines.push(`Passed: ${result.passed}`);
    lines.push(`Warnings: ${result.warnings}`);
    lines.push(`Errors: ${result.errors}`);
    return lines.join(" | ");
  }
}

/**
 * Module-level storage for issues collected during agentic verification.
 * Reset before each verification run.
 */
let collectedIssues: VerificationIssue[] = [];

/**
 * Reset the collected issues (call before starting verification).
 */
export function resetCollectedIssues(): void {
  collectedIssues = [];
}

/**
 * Add an issue to the collection (called by ReportIssue gadget).
 */
export function addCollectedIssue(issue: VerificationIssue): void {
  collectedIssues.push(issue);
}

/**
 * Get all collected issues.
 */
export function getCollectedIssues(): VerificationIssue[] {
  return [...collectedIssues];
}
