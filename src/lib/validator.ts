import { readdir, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { createHash } from "node:crypto";
import fg from "fast-glob";
import {
  findAuFiles,
  getSourceFromAuPath,
  isDirectoryAuFile,
  isSourceFileAuFile,
} from "./au-paths.js";
import { createFileFilter, FileFilter } from "./file-filter.js";
import { GlobPatterns } from "./constants.js";

export interface ContentsIssue {
  path: string;
  missing: string[];
  extra: string[];
}

export interface ValidationResult {
  uncovered: string[];
  contentsIssues: ContentsIssue[];
  orphans: string[];
  stale: string[];
}

export class Validator {
  private filter: FileFilter | null = null;
  private basePath: string = ".";
  private auFiles: string[] = [];

  /**
   * Run all validations and return consolidated results.
   */
  async validate(basePath: string = "."): Promise<ValidationResult> {
    this.basePath = basePath;
    this.filter = await createFileFilter(basePath);
    this.auFiles = await findAuFiles(basePath, true);

    const [uncovered, contentsIssues, orphans, stale] = await Promise.all([
      this.findUncovered(),
      this.validateContents(),
      this.findOrphans(),
      this.findStale(),
    ]);

    return { uncovered, contentsIssues, orphans, stale };
  }

  /**
   * Find all source files and directories that don't have .au files.
   */
  private async findUncovered(): Promise<string[]> {
    const uncovered: string[] = [];

    // Find all source files
    const sourceFiles = await fg([...GlobPatterns.sourceFiles], {
      cwd: this.basePath,
      ignore: [...GlobPatterns.sourceIgnore],
      absolute: false,
      dot: false,
    });

    // Find all directories containing source files
    const directories = new Set<string>();
    for (const file of sourceFiles) {
      const parts = file.split("/");
      for (let i = 1; i < parts.length; i++) {
        directories.add(parts.slice(0, i).join("/"));
      }
    }

    // Use cached .au files
    const documented = new Set(this.auFiles.map(getSourceFromAuPath));

    // Check files
    for (const file of sourceFiles) {
      if (!documented.has(file) && this.filter!.accepts(file)) {
        uncovered.push(file);
      }
    }

    // Check directories
    for (const dir of directories) {
      if (!documented.has(dir) && this.filter!.accepts(dir)) {
        uncovered.push(dir + "/");
      }
    }

    return uncovered.sort();
  }

  /**
   * Validate that each directory .au file's contents field matches actual directory contents.
   */
  private async validateContents(): Promise<ContentsIssue[]> {
    const issues: ContentsIssue[] = [];

    // Filter to directory .au files only
    const dirAuFiles = this.auFiles.filter(isDirectoryAuFile);

    for (const auFile of dirAuFiles) {
      const issue = await this.checkDirectoryContents(auFile);
      if (issue && (issue.missing.length > 0 || issue.extra.length > 0)) {
        issues.push(issue);
      }
    }

    return issues;
  }

  /**
   * Check a single directory .au file's contents against actual directory.
   */
  private async checkDirectoryContents(
    auPath: string
  ): Promise<ContentsIssue | null> {
    const dirPath = getSourceFromAuPath(auPath);
    const fullAuPath = join(this.basePath, auPath);
    const fullDirPath = dirPath === "." ? this.basePath : join(this.basePath, dirPath);

    try {
      // Read the .au file
      const content = await readFile(fullAuPath, "utf-8");
      const doc = parse(content);

      if (!doc) {
        return null;
      }

      // Get declared contents - can be strings or objects with 'name' property
      const rawContents: unknown[] = doc.contents || [];
      const declaredContents: string[] = rawContents.map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && "name" in item) {
          return String((item as { name: unknown }).name);
        }
        return String(item);
      });
      const declaredSet = new Set(declaredContents);

      // Get actual directory contents
      const entries = await readdir(fullDirPath, { withFileTypes: true });
      const actualContents: string[] = [];

      for (const entry of entries) {
        const entryPath = dirPath === "." ? entry.name : `${dirPath}/${entry.name}`;

        // Skip if filtered out (gitignored, .au files, etc.)
        if (!this.filter!.accepts(entryPath)) {
          continue;
        }

        actualContents.push(entry.name);
      }

      const actualSet = new Set(actualContents);

      // Find missing (in actual but not declared)
      const missing = actualContents.filter((item) => !declaredSet.has(item));

      // Find extra (in declared but not actual)
      const extra = declaredContents.filter((item) => !actualSet.has(item));

      if (missing.length > 0 || extra.length > 0) {
        return {
          path: auPath,
          missing,
          extra,
        };
      }

      return null;
    } catch {
      // File doesn't exist or can't be read
      return null;
    }
  }

  /**
   * Find .au files whose source no longer exists.
   */
  private async findOrphans(): Promise<string[]> {
    const orphans: string[] = [];

    for (const auFile of this.auFiles) {
      const sourcePath = getSourceFromAuPath(auFile);
      const fullPath =
        sourcePath === "."
          ? this.basePath
          : join(this.basePath, sourcePath);

      try {
        await stat(fullPath);
      } catch {
        // Source doesn't exist
        orphans.push(auFile);
      }
    }

    return orphans.sort();
  }

  /**
   * Find .au files where the source file hash has changed (stale understanding).
   */
  private async findStale(): Promise<string[]> {
    const stale: string[] = [];

    // Only check source file .au files (not directory .au or root .au)
    const fileAuFiles = this.auFiles.filter(isSourceFileAuFile);

    for (const auFile of fileAuFiles) {
      const sourcePath = getSourceFromAuPath(auFile);
      const fullAuPath = join(this.basePath, auFile);
      const fullSourcePath = join(this.basePath, sourcePath);

      try {
        // Read .au file and get stored hash
        const auContent = await readFile(fullAuPath, "utf-8");
        const doc = parse(auContent);
        const storedHash = doc?.meta?.analyzed_hash;

        if (!storedHash) continue; // No hash to compare

        // Compute current source hash
        const sourceContent = await readFile(fullSourcePath, "utf-8");
        const currentHash = createHash("md5")
          .update(sourceContent)
          .digest("hex");

        if (storedHash !== currentHash) {
          stale.push(auFile);
        }
      } catch {
        // Can't read one of the files, skip
      }
    }

    return stale.sort();
  }

  /**
   * Get total issue count from a validation result.
   */
  static getIssueCount(result: ValidationResult): number {
    return (
      result.uncovered.length +
      result.contentsIssues.reduce(
        (sum, issue) => sum + issue.missing.length + issue.extra.length,
        0
      ) +
      result.orphans.length +
      result.stale.length
    );
  }
}
