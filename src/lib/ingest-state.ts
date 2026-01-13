import { ProgressTracker } from "./progress-tracker.js";
import { Validator, ContentsIssue, StaleReference, FileIssue } from "./validator.js";

export interface IngestState {
  // Coverage
  totalItems: number;
  documentedItems: number;
  coveragePercent: number;

  // Issues in existing docs
  staleFiles: string[];           // source hash changed
  incompleteFiles: FileIssue[];   // missing required fields
  staleReferences: StaleReference[];
  contentsIssues: ContentsIssue[];
  orphanedAuFiles: string[];      // .au without source

  // Work needed
  pendingItems: string[];         // no .au file or needs update

  // Summary
  hasWork: boolean;               // true if anything needs to be done
  issueCount: number;             // total validation issues
}

export class IngestStateCollector {
  private progressTracker: ProgressTracker;
  private validator: Validator;

  constructor() {
    this.progressTracker = new ProgressTracker();
    this.validator = new Validator();
  }

  /**
   * Collect complete state for ingest command.
   * Uses Validator as single source of truth for scanning.
   */
  async collect(basePath: string = "."): Promise<IngestState> {
    // Run validation (does a single comprehensive scan)
    const validationResult = await this.validator.validate(basePath);

    // Initialize progress tracker from validator's scan data
    const scanData = this.validator.getScanData();
    this.progressTracker.initFromScanData(scanData);

    // Get coverage counts
    const counts = this.progressTracker.getCounts();

    // Combine stale + incomplete + uncovered into pending
    const staleSet = new Set(validationResult.stale.map(s => s.replace(/\.au$/, "").replace(/\/\.au$/, "")));
    const incompleteSet = new Set(validationResult.incompleteFiles.map(f => f.path));

    // Get all pending items (not documented)
    const allPending = this.progressTracker.getPendingItems(1000);

    // Add stale files to pending if not already there
    for (const stale of staleSet) {
      if (!allPending.includes(stale)) {
        allPending.push(stale);
      }
    }

    // Add incomplete files to pending if not already there
    for (const incomplete of incompleteSet) {
      if (!allPending.includes(incomplete)) {
        allPending.push(incomplete);
      }
    }

    const issueCount =
      validationResult.stale.length +
      validationResult.incompleteFiles.length +
      validationResult.staleReferences.length +
      validationResult.contentsIssues.reduce((sum, i) => sum + i.missing.length + i.extra.length, 0) +
      validationResult.orphans.length;

    const hasWork = allPending.length > 0 || issueCount > 0;

    return {
      // Coverage
      totalItems: counts.total,
      documentedItems: counts.documented,
      coveragePercent: this.progressTracker.getProgressPercent(),

      // Issues
      staleFiles: validationResult.stale,
      incompleteFiles: validationResult.incompleteFiles,
      staleReferences: validationResult.staleReferences,
      contentsIssues: validationResult.contentsIssues,
      orphanedAuFiles: validationResult.orphans,

      // Work needed
      pendingItems: allPending,

      // Summary
      hasWork,
      issueCount,
    };
  }

  /**
   * Get the progress tracker for real-time updates during execution.
   */
  getProgressTracker(): ProgressTracker {
    return this.progressTracker;
  }
}

// Re-export types for convenience
export type { FileIssue, ContentsIssue, StaleReference };
