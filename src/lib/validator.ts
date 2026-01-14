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
  isRootAuFile,
} from "./au-paths.js";
import { createFileFilter, FileFilter } from "./file-filter.js";
import { GlobPatterns } from "./constants.js";

export interface ContentsIssue {
  path: string;
  missing: string[];
  extra: string[];
}

export interface StaleReference {
  auFile: string;
  field: string;
  ref: string;
}

export interface FileIssue {
  path: string;
  issues: string[];
}

export interface ValidationResult {
  uncovered: string[];
  contentsIssues: ContentsIssue[];
  orphans: string[];
  stale: string[];
  staleReferences: StaleReference[];
  incompleteFiles: FileIssue[];
}

export interface ScanData {
  sourceFiles: string[];
  directories: Set<string>;
  auFiles: string[];
  documented: Set<string>;
}

export interface ValidateOptions {
  /** Glob patterns to include (e.g., ["*.tsx", "*.jsx"]). Replaces default patterns when provided. */
  includePatterns?: string[];
}

export class Validator {
  private filter: FileFilter | null = null;
  private basePath: string = ".";
  private auFiles: string[] = [];
  private sourceFiles: string[] = [];
  private directories: Set<string> = new Set();
  private includePatterns?: string[];

  /**
   * Run all validations and return consolidated results.
   * Also caches scan data for reuse by other components.
   */
  async validate(basePath: string = ".", options: ValidateOptions = {}): Promise<ValidationResult> {
    this.basePath = basePath;
    this.includePatterns = options.includePatterns;
    this.filter = await createFileFilter(basePath);
    this.auFiles = await findAuFiles(basePath, true);

    // Scan source files once and cache
    await this.scanSourceFiles();

    const [uncovered, contentsIssues, orphans, stale, staleReferences, incompleteFiles] = await Promise.all([
      this.findUncovered(),
      this.validateContents(),
      this.findOrphans(),
      this.findStale(),
      this.findStaleReferences(),
      this.findIncomplete(),
    ]);

    return { uncovered, contentsIssues, orphans, stale, staleReferences, incompleteFiles };
  }

  /**
   * Get scan data for reuse by ProgressTracker.
   * Must call validate() first.
   */
  getScanData(): ScanData {
    const documented = new Set(this.auFiles.map(getSourceFromAuPath));
    return {
      sourceFiles: this.sourceFiles,
      directories: this.directories,
      auFiles: this.auFiles,
      documented,
    };
  }

  /**
   * Scan source files and directories once, caching results.
   * Respects .gitignore via FileFilter.
   */
  private async scanSourceFiles(): Promise<void> {
    // Use custom include patterns or fall back to defaults
    let patterns: string[];
    if (this.includePatterns && this.includePatterns.length > 0) {
      // Ensure patterns match deeply by adding **/ prefix if not present
      patterns = this.includePatterns.map(p => {
        if (p.startsWith("**/") || p.startsWith("/")) return p;
        return `**/${p}`;
      });
    } else {
      patterns = [...GlobPatterns.sourceFiles];
    }

    const files = await fg(patterns, {
      cwd: this.basePath,
      ignore: [...GlobPatterns.sourceIgnore],
      absolute: false,
      dot: false,
    });

    this.sourceFiles = [];
    this.directories = new Set();

    for (const file of files) {
      // Skip files that don't pass the filter (respects .gitignore)
      if (!this.filter!.accepts(file)) {
        continue;
      }

      // Skip empty files
      try {
        const fileStat = await stat(join(this.basePath, file));
        if (fileStat.size === 0) continue;
      } catch {
        continue;
      }

      this.sourceFiles.push(file);

      // Extract directories (only if they pass the filter)
      const parts = file.split("/");
      for (let i = 1; i < parts.length; i++) {
        const dirPath = parts.slice(0, i).join("/");
        if (this.filter!.accepts(dirPath)) {
          this.directories.add(dirPath);
        }
      }
    }
  }

  /**
   * Find all source files and directories that don't have .au files.
   */
  private async findUncovered(): Promise<string[]> {
    const uncovered: string[] = [];
    const documented = new Set(this.auFiles.map(getSourceFromAuPath));

    // Check files
    for (const file of this.sourceFiles) {
      if (!documented.has(file) && this.filter!.accepts(file)) {
        uncovered.push(file);
      }
    }

    // Check directories
    for (const dir of this.directories) {
      if (!documented.has(dir) && this.filter!.accepts(dir)) {
        uncovered.push(dir + "/");
      }
    }

    return uncovered.sort();
  }

  /**
   * Find .au files with missing required fields.
   */
  private async findIncomplete(): Promise<FileIssue[]> {
    const incompleteFiles: FileIssue[] = [];

    for (const auFile of this.auFiles) {
      const issue = await this.checkFileCompleteness(auFile);
      if (issue && issue.issues.length > 0) {
        incompleteFiles.push(issue);
      }
    }

    return incompleteFiles;
  }

  /**
   * Check a single .au file for missing required fields.
   */
  private async checkFileCompleteness(auPath: string): Promise<FileIssue | null> {
    const sourcePath = getSourceFromAuPath(auPath);
    const issues: string[] = [];

    try {
      const content = await readFile(join(this.basePath, auPath), "utf-8");
      const doc = parse(content);

      if (!doc) {
        return { path: sourcePath, issues: ["empty file"] };
      }

      // Determine file type
      const isRoot = isRootAuFile(auPath);
      const isDirectory = isDirectoryAuFile(auPath);
      const isSourceFile = !isDirectory;
      const isService = sourcePath.includes("/services/");
      const isUtil = sourcePath.includes("/utils/");

      // Check common required fields
      if (!doc.layer) {
        issues.push("missing layer");
      }

      // Check understanding fields
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
        return { path: sourcePath, issues };
      }

      return null;
    } catch (error) {
      return { path: sourcePath, issues: [`parse error: ${error instanceof Error ? error.message : "unknown"}`] };
    }
  }

  /**
   * Validate that each directory .au file's contents field matches actual directory contents.
   */
  private async validateContents(): Promise<ContentsIssue[]> {
    const issues: ContentsIssue[] = [];
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
  private async checkDirectoryContents(auPath: string): Promise<ContentsIssue | null> {
    const dirPath = getSourceFromAuPath(auPath);
    const fullAuPath = join(this.basePath, auPath);
    const fullDirPath = dirPath === "." ? this.basePath : join(this.basePath, dirPath);

    try {
      const content = await readFile(fullAuPath, "utf-8");
      const doc = parse(content);

      if (!doc) {
        return null;
      }

      // Get declared contents
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
        if (!this.filter!.accepts(entryPath)) {
          continue;
        }
        actualContents.push(entry.name);
      }

      const actualSet = new Set(actualContents);
      const missing = actualContents.filter((item) => !declaredSet.has(item));
      const extra = declaredContents.filter((item) => !actualSet.has(item));

      if (missing.length > 0 || extra.length > 0) {
        return { path: auPath, missing, extra };
      }

      return null;
    } catch {
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
      const fullPath = sourcePath === "." ? this.basePath : join(this.basePath, sourcePath);

      try {
        await stat(fullPath);
      } catch {
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
    const fileAuFiles = this.auFiles.filter(isSourceFileAuFile);

    for (const auFile of fileAuFiles) {
      const sourcePath = getSourceFromAuPath(auFile);
      const fullAuPath = join(this.basePath, auFile);
      const fullSourcePath = join(this.basePath, sourcePath);

      try {
        const auContent = await readFile(fullAuPath, "utf-8");
        const doc = parse(auContent);
        const storedHash = doc?.meta?.analyzed_hash;

        if (!storedHash) continue;

        const sourceContent = await readFile(fullSourcePath, "utf-8");
        const currentHash = createHash("md5").update(sourceContent).digest("hex");

        if (storedHash !== currentHash) {
          stale.push(auFile);
        }
      } catch {
        // Can't read file, skip
      }
    }

    return stale.sort();
  }

  /**
   * Find stale references in .au files.
   */
  private async findStaleReferences(): Promise<StaleReference[]> {
    const staleRefs: StaleReference[] = [];

    for (const auFile of this.auFiles) {
      const fullAuPath = join(this.basePath, auFile);

      try {
        const content = await readFile(fullAuPath, "utf-8");
        const doc = parse(content);

        if (!doc) continue;

        // Check depends_on references
        const dependsOn = doc?.relationships?.depends_on || [];
        for (const dep of dependsOn) {
          if (dep.ref) {
            const targetPath = dep.ref.replace(/^au:/, "");
            if (!(await this.pathExists(targetPath))) {
              staleRefs.push({ auFile, field: "depends_on", ref: dep.ref });
            }
          }
        }

        // Check collaborates_with references
        const collaborates = doc?.understanding?.collaborates_with || [];
        for (const collab of collaborates) {
          if (collab.path) {
            const targetPath = collab.path.replace(/^au:/, "");
            if (!(await this.pathExists(targetPath))) {
              staleRefs.push({ auFile, field: "collaborates_with", ref: collab.path });
            }
          }
        }
      } catch {
        // Can't read file, skip
      }
    }

    return staleRefs;
  }

  /**
   * Check if a path exists relative to basePath.
   */
  private async pathExists(relativePath: string): Promise<boolean> {
    try {
      await stat(join(this.basePath, relativePath));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get total issue count from a validation result.
   */
  static getIssueCount(result: ValidationResult): number {
    return (
      result.uncovered.length +
      result.contentsIssues.reduce((sum, issue) => sum + issue.missing.length + issue.extra.length, 0) +
      result.orphans.length +
      result.stale.length +
      result.staleReferences.length +
      result.incompleteFiles.length
    );
  }
}
