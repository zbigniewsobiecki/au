/**
 * Issue Priority System
 * Prioritizes validation issues for the fix workflow.
 */

import type { VerificationFinding } from "../gadgets/verify-finding.js";
import type { Sysml2MultiDiagnostic } from "./sysml/sysml2-cli.js";

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
  /** Whether the fix agent should attempt to fix this issue. Defaults to true. */
  actionable?: boolean;
  /** For coverage-mismatch issues: list of uncovered files to add @SourceFile metadata for. */
  uncoveredFiles?: string[];
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
 * Convert sysml2 diagnostics to prioritized issues.
 *
 * Priority mapping:
 * - P1 BLOCKING: syntax errors (exit code 1)
 * - P2 CRITICAL: semantic errors (exit code 2)
 * - P3 HIGH: warnings (exit code 0 with warnings)
 */
export function prioritizeSysml2Diagnostics(
  exitCode: number,
  diagnostics: Sysml2MultiDiagnostic[]
): PrioritizedIssue[] {
  const issues: PrioritizedIssue[] = [];

  for (const diag of diagnostics) {
    let priority: PriorityLevel;
    let priorityLabel: PriorityLabel;

    if (diag.severity === "error") {
      if (exitCode === 1) {
        // Syntax errors are blocking
        priority = 1;
        priorityLabel = "BLOCKING";
      } else {
        // Semantic errors (exit code 2) are critical
        priority = 2;
        priorityLabel = "CRITICAL";
      }
    } else {
      // Warnings
      priority = 3;
      priorityLabel = "HIGH";
    }

    const codeInfo = diag.code ? ` [${diag.code}]` : "";
    issues.push({
      priority,
      priorityLabel,
      category: `sysml2-${diag.severity}`,
      description: `${diag.message}${codeInfo}`,
      file: diag.file,
      line: diag.line,
      actionable: true,
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
      actionable: true,
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
