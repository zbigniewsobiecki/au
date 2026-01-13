import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import {
  getSourceFromAuPath,
  findAuFiles,
  isRootAuFile,
  isDirectoryAuFile,
} from "./au-paths.js";

export interface FileIssue {
  path: string;
  issues: string[];
}

export class ReviewTracker {
  private files: Map<string, FileIssue> = new Map();
  private basePath: string = ".";

  /**
   * Scan all .au files and check for missing required fields.
   */
  async scan(basePath: string = "."): Promise<void> {
    this.basePath = basePath;

    const auFiles = await findAuFiles(basePath, false);

    for (const auFile of auFiles) {
      await this.checkFile(auFile);
    }
  }

  /**
   * Check a single .au file for missing fields.
   */
  private async checkFile(auPath: string): Promise<void> {
    const sourcePath = getSourceFromAuPath(auPath);
    const issues: string[] = [];

    try {
      const content = await readFile(join(this.basePath, auPath), "utf-8");
      const doc = parse(content);

      if (!doc) {
        issues.push("empty file");
        this.files.set(sourcePath, { path: sourcePath, issues });
        return;
      }

      // Determine file type
      const isRoot = isRootAuFile(auPath);
      const isDirectory = isDirectoryAuFile(auPath);
      const isSourceFile = !isDirectory; // directories include root
      const isService = sourcePath.includes("/services/");
      const isUtil = sourcePath.includes("/utils/");

      // Check common required fields
      if (!doc.layer) {
        issues.push("missing layer");
      }

      // Check understanding fields - handle both nested and flattened formats
      const understanding = doc.understanding || {};
      const hasSummary = understanding.summary ||
        Object.keys(doc).some(k => k.startsWith("understanding.summary") || k.startsWith("understanding/summary"));
      const hasPurpose = understanding.purpose ||
        Object.keys(doc).some(k => k.startsWith("understanding.purpose") || k.startsWith("understanding/purpose"));

      if (!hasSummary) {
        issues.push("missing summary");
      }

      if (isSourceFile && !hasPurpose) {
        issues.push("missing purpose");
      }

      // Check source file specific fields
      if (isSourceFile) {
        const hasExports = understanding.exports ||
          Object.keys(doc).some(k => k.startsWith("understanding.exports") || k.startsWith("understanding/exports"));
        const hasDependsOn = doc.relationships?.depends_on ||
          Object.keys(doc).some(k => k.startsWith("relationships.depends_on") || k.startsWith("relationships/depends_on"));

        // We can't know if the file has exports/imports without reading source
        // So we only flag if the file is a .ts file and has NO exports/depends_on at all
        // The agent will do the accurate comparison

        // Check key_logic for services/utils
        if ((isService || isUtil) && !understanding.key_logic) {
          issues.push("missing key_logic");
        }
      }

      // Check directory specific fields
      if (isDirectory) {
        const hasResponsibility = understanding.responsibility ||
          Object.keys(doc).some(k => k.startsWith("understanding.responsibility"));
        const hasContents = doc.contents ||
          Object.keys(doc).some(k => k.startsWith("contents"));

        if (!hasResponsibility) {
          issues.push("missing responsibility");
        }
        if (!hasContents) {
          issues.push("missing contents");
        }
      }

      // Check root specific fields
      if (isRoot) {
        const hasArchitecture = understanding.architecture ||
          Object.keys(doc).some(k => k.startsWith("understanding.architecture"));
        if (!hasArchitecture) {
          issues.push("missing architecture");
        }
      }

      if (issues.length > 0) {
        this.files.set(sourcePath, { path: sourcePath, issues });
      }
    } catch (error) {
      issues.push(`parse error: ${error instanceof Error ? error.message : "unknown"}`);
      this.files.set(sourcePath, { path: sourcePath, issues });
    }
  }

  /**
   * Mark a file as having been reviewed (even if we can't determine fix success).
   */
  markReviewed(path: string): void {
    this.files.delete(path);
  }

  /**
   * Get count of files with issues.
   */
  getIssueCount(): number {
    return this.files.size;
  }

  /**
   * Get issue breakdown as formatted strings.
   */
  getIssueBreakdownStrings(): string[] {
    const breakdown: Record<string, number> = {};

    for (const fileIssue of this.files.values()) {
      for (const issue of fileIssue.issues) {
        breakdown[issue] = (breakdown[issue] || 0) + 1;
      }
    }

    return Object.entries(breakdown)
      .sort((a, b) => b[1] - a[1])
      .map(([issue, count]) => `${count} files ${issue}`);
  }

  /**
   * Get next N files that need work.
   */
  getNextFiles(n: number = 5): FileIssue[] {
    const result: FileIssue[] = [];
    for (const fileIssue of this.files.values()) {
      result.push(fileIssue);
      if (result.length >= n) break;
    }
    return result;
  }

}
