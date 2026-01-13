import { ScanData } from "./validator.js";

export interface ProgressCounts {
  total: number;
  documented: number;
  pending: number;
}

export class ProgressTracker {
  private allItems: Set<string> = new Set();
  private documentedItems: Set<string> = new Set();

  /**
   * Initialize from pre-scanned data (from Validator).
   * This avoids duplicate filesystem scanning.
   */
  initFromScanData(scanData: ScanData): void {
    this.allItems.clear();
    this.documentedItems.clear();

    // Add source files
    for (const file of scanData.sourceFiles) {
      this.allItems.add(file);
    }

    // Add directories
    for (const dir of scanData.directories) {
      this.allItems.add(dir);
    }

    // Add root if there are any items
    if (this.allItems.size > 0) {
      this.allItems.add(".");
    }

    // Copy documented items
    for (const doc of scanData.documented) {
      this.documentedItems.add(doc);
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
    const documented = this.getDocumentedCount();
    return Math.round((documented / this.allItems.size) * 100);
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
   */
  getCounts(): ProgressCounts {
    const documented = this.getDocumentedCount();
    return {
      total: this.allItems.size,
      documented,
      pending: this.allItems.size - documented,
    };
  }

  /**
   * Count documented items that are in allItems.
   */
  private getDocumentedCount(): number {
    let count = 0;
    for (const item of this.documentedItems) {
      if (this.allItems.has(item)) {
        count++;
      }
    }
    return count;
  }
}
