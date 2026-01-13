import fg from "fast-glob";
import { getSourceFromAuPath, findAuFiles } from "./au-paths.js";
import { GlobPatterns } from "./constants.js";

export interface ProgressCounts {
  total: number;
  documented: number;
  pending: number;
}

export class ProgressTracker {
  private allItems: Set<string> = new Set();
  private documentedItems: Set<string> = new Set();

  /**
   * Scan the filesystem for all source files that should be documented.
   * Uses fast-glob to find all .ts files (excluding node_modules, tests, etc.)
   */
  async scanSourceFiles(basePath: string = "."): Promise<void> {
    const sourceFiles = await fg([...GlobPatterns.sourceFiles], {
      cwd: basePath,
      ignore: [...GlobPatterns.sourceIgnore],
      absolute: false,
      dot: false,
    });

    for (const file of sourceFiles) {
      this.allItems.add(file);
    }
  }

  /**
   * Scan for existing .au files to determine what's already documented.
   */
  async scanExistingAuFiles(basePath: string = "."): Promise<void> {
    const auFiles = await findAuFiles(basePath, false);

    for (const auFile of auFiles) {
      const sourcePath = getSourceFromAuPath(auFile);
      this.documentedItems.add(sourcePath);
    }
  }

  /**
   * Mark an item as documented (called when AUUpdate succeeds).
   */
  markDocumented(filePath: string): void {
    this.documentedItems.add(filePath);
  }

  /**
   * Get progress percentage.
   */
  getProgressPercent(): number {
    if (this.allItems.size === 0) return 100;
    return Math.round((this.documentedItems.size / this.allItems.size) * 100);
  }

  /**
   * Get list of pending items (not yet documented).
   * @param limit Maximum number of items to return
   */
  getPendingItems(limit: number = 10): string[] {
    const pending: string[] = [];
    for (const item of this.allItems) {
      if (!this.documentedItems.has(item)) {
        pending.push(item);
        if (pending.length >= limit) break;
      }
    }
    return pending;
  }

  /**
   * Get total counts for display.
   * Only counts documented items that are actual source files (ignores directory .au files).
   */
  getCounts(): ProgressCounts {
    let documented = 0;
    for (const item of this.documentedItems) {
      if (this.allItems.has(item)) {
        documented++;
      }
    }
    return {
      total: this.allItems.size,
      documented,
      pending: this.allItems.size - documented,
    };
  }
}
