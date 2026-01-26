import { describe, it, expect } from "vitest";
import {
  prioritizeSysml2Diagnostics,
  prioritizeAgenticFindings,
  sortIssuesByPriority,
  groupByPriority,
  getPriorityLabel,
  getPrioritySummary,
  type PrioritizedIssue,
} from "./issue-priority.js";
import type { Sysml2MultiDiagnostic } from "./sysml/sysml2-cli.js";
import type { VerificationFinding } from "../gadgets/verify-finding.js";

describe("issue-priority", () => {
  describe("getPriorityLabel", () => {
    it("maps priority levels to labels", () => {
      expect(getPriorityLabel(1)).toBe("BLOCKING");
      expect(getPriorityLabel(2)).toBe("CRITICAL");
      expect(getPriorityLabel(3)).toBe("HIGH");
      expect(getPriorityLabel(4)).toBe("MEDIUM");
      expect(getPriorityLabel(5)).toBe("LOW");
    });
  });

  describe("prioritizeSysml2Diagnostics", () => {
    it("returns empty array for no diagnostics", () => {
      const issues = prioritizeSysml2Diagnostics(0, []);
      expect(issues).toEqual([]);
    });

    it("assigns P1 BLOCKING to syntax errors (exit code 1)", () => {
      const diagnostics: Sysml2MultiDiagnostic[] = [
        {
          file: "data/entities.sysml",
          line: 5,
          column: 10,
          severity: "error",
          code: "",
          message: "Missing semicolon",
        },
      ];
      const issues = prioritizeSysml2Diagnostics(1, diagnostics);

      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({
        priority: 1,
        priorityLabel: "BLOCKING",
        category: "sysml2-error",
        file: "data/entities.sysml",
        line: 5,
      });
    });

    it("assigns P2 CRITICAL to semantic errors (exit code 2)", () => {
      const diagnostics: Sysml2MultiDiagnostic[] = [
        {
          file: "structure/modules.sysml",
          line: 15,
          column: 1,
          severity: "error",
          code: "E3001",
          message: "Undefined reference 'DataModels'",
        },
      ];
      const issues = prioritizeSysml2Diagnostics(2, diagnostics);

      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({
        priority: 2,
        priorityLabel: "CRITICAL",
        category: "sysml2-error",
        file: "structure/modules.sysml",
        line: 15,
      });
      expect(issues[0].description).toContain("[E3001]");
    });

    it("assigns P3 HIGH to warnings", () => {
      const diagnostics: Sysml2MultiDiagnostic[] = [
        {
          file: "data/entities.sysml",
          line: 10,
          column: 5,
          severity: "warning",
          code: "W1001",
          message: "Unused import",
        },
      ];
      const issues = prioritizeSysml2Diagnostics(0, diagnostics);

      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({
        priority: 3,
        priorityLabel: "HIGH",
        category: "sysml2-warning",
        file: "data/entities.sysml",
      });
    });

    it("handles mixed errors and warnings", () => {
      const diagnostics: Sysml2MultiDiagnostic[] = [
        {
          file: "a.sysml",
          line: 1,
          column: 1,
          severity: "error",
          code: "E3001",
          message: "Error 1",
        },
        {
          file: "b.sysml",
          line: 2,
          column: 1,
          severity: "warning",
          code: "",
          message: "Warning 1",
        },
      ];
      const issues = prioritizeSysml2Diagnostics(2, diagnostics);

      expect(issues).toHaveLength(2);
      expect(issues[0].priority).toBe(2); // Error with exit code 2 = CRITICAL
      expect(issues[1].priority).toBe(3); // Warning = HIGH
    });
  });

  describe("prioritizeAgenticFindings", () => {
    it("returns empty array for no findings", () => {
      const issues = prioritizeAgenticFindings([]);
      expect(issues).toEqual([]);
    });

    it("assigns P3 HIGH to error findings in data domain", () => {
      const findings: VerificationFinding[] = [
        {
          category: "error",
          domain: "data",
          file: "data/entities.sysml",
          issue: "Missing User entity",
          recommendation: "Add User item def",
        },
      ];
      const issues = prioritizeAgenticFindings(findings);

      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({
        priority: 3,
        priorityLabel: "HIGH",
        category: "agentic-error",
        file: "data/entities.sysml",
      });
    });

    it("assigns P3 HIGH to error findings in structure domain", () => {
      const findings: VerificationFinding[] = [
        {
          category: "error",
          domain: "structure",
          issue: "Missing module definition",
        },
      ];
      const issues = prioritizeAgenticFindings(findings);

      expect(issues[0]).toMatchObject({
        priority: 3,
        priorityLabel: "HIGH",
      });
    });

    it("assigns P4 MEDIUM to error findings in other domains", () => {
      const findings: VerificationFinding[] = [
        {
          category: "error",
          domain: "behavior",
          issue: "Missing action definition",
        },
      ];
      const issues = prioritizeAgenticFindings(findings);

      expect(issues[0]).toMatchObject({
        priority: 4,
        priorityLabel: "MEDIUM",
      });
    });

    it("assigns P4 MEDIUM to warning findings", () => {
      const findings: VerificationFinding[] = [
        {
          category: "warning",
          domain: "data",
          issue: "Incomplete attribute list",
        },
      ];
      const issues = prioritizeAgenticFindings(findings);

      expect(issues[0]).toMatchObject({
        priority: 4,
        priorityLabel: "MEDIUM",
        category: "agentic-warning",
      });
    });

    it("assigns P5 LOW to suggestion findings", () => {
      const findings: VerificationFinding[] = [
        {
          category: "suggestion",
          domain: "quality",
          issue: "Consider adding documentation",
        },
      ];
      const issues = prioritizeAgenticFindings(findings);

      expect(issues[0]).toMatchObject({
        priority: 5,
        priorityLabel: "LOW",
        category: "agentic-suggestion",
      });
    });
  });

  describe("sortIssuesByPriority", () => {
    it("sorts by priority level first", () => {
      const issues: PrioritizedIssue[] = [
        { priority: 3, priorityLabel: "HIGH", category: "a", description: "high" },
        { priority: 1, priorityLabel: "BLOCKING", category: "a", description: "blocking" },
        { priority: 5, priorityLabel: "LOW", category: "a", description: "low" },
        { priority: 2, priorityLabel: "CRITICAL", category: "a", description: "critical" },
      ];

      const sorted = sortIssuesByPriority(issues);

      expect(sorted.map((i) => i.priority)).toEqual([1, 2, 3, 5]);
    });

    it("sorts by category within same priority", () => {
      const issues: PrioritizedIssue[] = [
        { priority: 1, priorityLabel: "BLOCKING", category: "syntax-error", description: "a" },
        { priority: 1, priorityLabel: "BLOCKING", category: "manifest-error", description: "b" },
      ];

      const sorted = sortIssuesByPriority(issues);

      expect(sorted.map((i) => i.category)).toEqual(["manifest-error", "syntax-error"]);
    });

    it("sorts by file within same category", () => {
      const issues: PrioritizedIssue[] = [
        { priority: 1, priorityLabel: "BLOCKING", category: "syntax-error", description: "a", file: "z.sysml" },
        { priority: 1, priorityLabel: "BLOCKING", category: "syntax-error", description: "b", file: "a.sysml" },
      ];

      const sorted = sortIssuesByPriority(issues);

      expect(sorted.map((i) => i.file)).toEqual(["a.sysml", "z.sysml"]);
    });

    it("handles issues without file", () => {
      const issues: PrioritizedIssue[] = [
        { priority: 1, priorityLabel: "BLOCKING", category: "a", description: "no file" },
        { priority: 1, priorityLabel: "BLOCKING", category: "a", description: "has file", file: "x.sysml" },
      ];

      const sorted = sortIssuesByPriority(issues);
      expect(sorted).toHaveLength(2);
    });

    it("does not mutate original array", () => {
      const issues: PrioritizedIssue[] = [
        { priority: 5, priorityLabel: "LOW", category: "a", description: "low" },
        { priority: 1, priorityLabel: "BLOCKING", category: "a", description: "blocking" },
      ];

      sortIssuesByPriority(issues);

      expect(issues[0].priority).toBe(5);
    });
  });

  describe("groupByPriority", () => {
    it("groups issues by priority level", () => {
      const issues: PrioritizedIssue[] = [
        { priority: 1, priorityLabel: "BLOCKING", category: "a", description: "blocking 1" },
        { priority: 1, priorityLabel: "BLOCKING", category: "b", description: "blocking 2" },
        { priority: 3, priorityLabel: "HIGH", category: "c", description: "high" },
        { priority: 5, priorityLabel: "LOW", category: "d", description: "low" },
      ];

      const grouped = groupByPriority(issues);

      expect(grouped.get(1)).toHaveLength(2);
      expect(grouped.get(2)).toHaveLength(0);
      expect(grouped.get(3)).toHaveLength(1);
      expect(grouped.get(4)).toHaveLength(0);
      expect(grouped.get(5)).toHaveLength(1);
    });

    it("returns all priority levels even if empty", () => {
      const grouped = groupByPriority([]);

      expect(grouped.has(1)).toBe(true);
      expect(grouped.has(2)).toBe(true);
      expect(grouped.has(3)).toBe(true);
      expect(grouped.has(4)).toBe(true);
      expect(grouped.has(5)).toBe(true);
    });
  });

  describe("getPrioritySummary", () => {
    it("returns summary string for issues", () => {
      const issues: PrioritizedIssue[] = [
        { priority: 1, priorityLabel: "BLOCKING", category: "a", description: "a" },
        { priority: 1, priorityLabel: "BLOCKING", category: "b", description: "b" },
        { priority: 3, priorityLabel: "HIGH", category: "c", description: "c" },
        { priority: 5, priorityLabel: "LOW", category: "d", description: "d" },
      ];

      const summary = getPrioritySummary(issues);

      expect(summary).toBe("2 blocking, 1 high, 1 low");
    });

    it("returns 'no issues' for empty array", () => {
      expect(getPrioritySummary([])).toBe("no issues");
    });
  });
});
