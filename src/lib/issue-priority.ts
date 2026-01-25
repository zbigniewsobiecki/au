/**
 * Issue Priority System
 * Prioritizes validation issues for the fix workflow.
 */

import type { SysMLValidationResult } from "./sysml-model-validator.js";
import type { VerificationFinding } from "../gadgets/verify-finding.js";

/**
 * Priority levels from highest (1) to lowest (5).
 */
export type PriorityLevel = 1 | 2 | 3 | 4 | 5;

/**
 * Human-readable priority labels.
 */
export type PriorityLabel = "BLOCKING" | "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

/**
 * A prioritized issue ready for the fix agent.
 */
export interface PrioritizedIssue {
  priority: PriorityLevel;
  priorityLabel: PriorityLabel;
  category: string;
  description: string;
  file?: string;
  line?: number;
  recommendation?: string;
}

/**
 * Map priority level to label.
 */
export function getPriorityLabel(level: PriorityLevel): PriorityLabel {
  const labels: Record<PriorityLevel, PriorityLabel> = {
    1: "BLOCKING",
    2: "CRITICAL",
    3: "HIGH",
    4: "MEDIUM",
    5: "LOW",
  };
  return labels[level];
}

/**
 * Convert static validation results to prioritized issues.
 *
 * Priority mapping:
 * - P1 BLOCKING: manifestErrors, syntaxErrors (prevent parsing)
 * - P2 CRITICAL: missingReferences (broken imports/specializations)
 * - P3 HIGH: missing expectedOutputs (files that should exist)
 * - P4 MEDIUM: fileCoverageMismatches (incomplete coverage)
 * - P5 LOW: orphanedFiles, coverageIssues (cleanup)
 */
export function prioritizeStaticIssues(result: SysMLValidationResult): PrioritizedIssue[] {
  const issues: PrioritizedIssue[] = [];

  // P1 - BLOCKING: Manifest errors
  for (const error of result.manifestErrors) {
    issues.push({
      priority: 1,
      priorityLabel: "BLOCKING",
      category: "manifest-error",
      description: error,
    });
  }

  // P1 - BLOCKING: Syntax errors
  for (const syntaxError of result.syntaxErrors) {
    for (const error of syntaxError.errors) {
      issues.push({
        priority: 1,
        priorityLabel: "BLOCKING",
        category: "syntax-error",
        description: error,
        file: syntaxError.file,
      });
    }
  }

  // P2 - CRITICAL: Missing references (imports/specializations)
  for (const ref of result.missingReferences) {
    issues.push({
      priority: 2,
      priorityLabel: "CRITICAL",
      category: `missing-${ref.type}`,
      description: `Missing ${ref.type} '${ref.reference}'`,
      file: ref.file,
      line: ref.line,
      recommendation: ref.context ? `Context: ${ref.context}` : undefined,
    });
  }

  // P3 - HIGH: Missing expected outputs
  const missingOutputs = result.expectedOutputs.filter((o) => !o.exists);
  for (const output of missingOutputs) {
    issues.push({
      priority: 3,
      priorityLabel: "HIGH",
      category: "missing-output",
      description: `Expected output file does not exist: ${output.path}`,
      file: output.path,
      recommendation: "Create the file with appropriate SysML content",
    });
  }

  // P4 - MEDIUM: File coverage mismatches
  for (const mismatch of result.fileCoverageMismatches) {
    issues.push({
      priority: 4,
      priorityLabel: "MEDIUM",
      category: "coverage-mismatch",
      description: `${mismatch.cycle}: ${mismatch.covered}/${mismatch.expected} source files covered`,
      recommendation: `Uncovered files: ${mismatch.uncoveredFiles.slice(0, 3).join(", ")}${mismatch.uncoveredFiles.length > 3 ? ` (+${mismatch.uncoveredFiles.length - 3} more)` : ""}`,
    });
  }

  // P5 - LOW: Orphaned files
  for (const file of result.orphanedFiles) {
    issues.push({
      priority: 5,
      priorityLabel: "LOW",
      category: "orphaned-file",
      description: `File not listed in manifest expectedOutputs: ${file}`,
      file,
      recommendation: "Either add to manifest expectedOutputs or delete if obsolete",
    });
  }

  // P5 - LOW: Coverage issues
  for (const issue of result.coverageIssues) {
    issues.push({
      priority: 5,
      priorityLabel: "LOW",
      category: `coverage-${issue.type}`,
      description: `${issue.cycle}: ${issue.type} - ${issue.path}`,
      recommendation: issue.detail,
    });
  }

  return issues;
}

/**
 * Convert agentic verification findings to prioritized issues.
 *
 * Priority mapping:
 * - P3 HIGH: error findings in data/structure domains
 * - P4 MEDIUM: warning findings, error findings in other domains
 * - P5 LOW: suggestion findings
 */
export function prioritizeAgenticFindings(findings: VerificationFinding[]): PrioritizedIssue[] {
  const issues: PrioritizedIssue[] = [];

  for (const finding of findings) {
    let priority: PriorityLevel;
    let priorityLabel: PriorityLabel;

    if (finding.category === "error") {
      // Error findings in data/structure are HIGH, others are MEDIUM
      if (finding.domain === "data" || finding.domain === "structure") {
        priority = 3;
        priorityLabel = "HIGH";
      } else {
        priority = 4;
        priorityLabel = "MEDIUM";
      }
    } else if (finding.category === "warning") {
      priority = 4;
      priorityLabel = "MEDIUM";
    } else {
      // suggestion
      priority = 5;
      priorityLabel = "LOW";
    }

    issues.push({
      priority,
      priorityLabel,
      category: `agentic-${finding.category}`,
      description: `[${finding.domain}] ${finding.issue}`,
      file: finding.file,
      recommendation: finding.recommendation,
    });
  }

  return issues;
}

/**
 * Sort issues by priority (highest first), then by category, then by file.
 */
export function sortIssuesByPriority(issues: PrioritizedIssue[]): PrioritizedIssue[] {
  return [...issues].sort((a, b) => {
    // Sort by priority level (lower number = higher priority)
    if (a.priority !== b.priority) {
      return a.priority - b.priority;
    }
    // Then by category
    if (a.category !== b.category) {
      return a.category.localeCompare(b.category);
    }
    // Then by file
    const aFile = a.file ?? "";
    const bFile = b.file ?? "";
    return aFile.localeCompare(bFile);
  });
}

/**
 * Group issues by priority level.
 */
export function groupByPriority(
  issues: PrioritizedIssue[]
): Map<PriorityLevel, PrioritizedIssue[]> {
  const grouped = new Map<PriorityLevel, PrioritizedIssue[]>();

  // Initialize all levels
  for (const level of [1, 2, 3, 4, 5] as PriorityLevel[]) {
    grouped.set(level, []);
  }

  for (const issue of issues) {
    const group = grouped.get(issue.priority)!;
    group.push(issue);
  }

  return grouped;
}

/**
 * Get a summary of issues by priority for display.
 */
export function getPrioritySummary(issues: PrioritizedIssue[]): string {
  const grouped = groupByPriority(issues);
  const parts: string[] = [];

  const levelNames: [PriorityLevel, string][] = [
    [1, "blocking"],
    [2, "critical"],
    [3, "high"],
    [4, "medium"],
    [5, "low"],
  ];

  for (const [level, name] of levelNames) {
    const count = grouped.get(level)?.length ?? 0;
    if (count > 0) {
      parts.push(`${count} ${name}`);
    }
  }

  return parts.length > 0 ? parts.join(", ") : "no issues";
}
