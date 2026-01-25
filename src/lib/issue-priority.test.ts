import { describe, it, expect } from "vitest";
import {
  prioritizeStaticIssues,
  prioritizeAgenticFindings,
  sortIssuesByPriority,
  groupByPriority,
  getPriorityLabel,
  getPrioritySummary,
  type PrioritizedIssue,
} from "./issue-priority.js";
import type { SysMLValidationResult } from "./sysml-model-validator.js";
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

  describe("prioritizeStaticIssues", () => {
    const emptyResult: SysMLValidationResult = {
      manifestExists: true,
      manifestErrors: [],
      expectedOutputs: [],
      syntaxErrors: [],
      fileCoverageMismatches: [],
      orphanedFiles: [],
      missingReferences: [],
      coverageIssues: [],
      validFileCount: 0,
      totalFileCount: 0,
    };

    it("returns empty array for clean result", () => {
      const issues = prioritizeStaticIssues(emptyResult);
      expect(issues).toEqual([]);
    });

    it("assigns P1 BLOCKING to manifest errors", () => {
      const result: SysMLValidationResult = {
        ...emptyResult,
        manifestErrors: ["Manifest not found"],
      };
      const issues = prioritizeStaticIssues(result);

      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({
        priority: 1,
        priorityLabel: "BLOCKING",
        category: "manifest-error",
        description: "Manifest not found",
      });
    });

    it("assigns P1 BLOCKING to syntax errors", () => {
      const result: SysMLValidationResult = {
        ...emptyResult,
        syntaxErrors: [
          {
            file: "data/entities.sysml",
            errors: ["Line 5:10: Missing semicolon"],
          },
        ],
      };
      const issues = prioritizeStaticIssues(result);

      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({
        priority: 1,
        priorityLabel: "BLOCKING",
        category: "syntax-error",
        file: "data/entities.sysml",
      });
    });

    it("assigns P2 CRITICAL to missing references", () => {
      const result: SysMLValidationResult = {
        ...emptyResult,
        missingReferences: [
          {
            file: "structure/modules.sysml",
            line: 15,
            type: "import",
            reference: "DataModels",
            context: "import DataModels::*;",
          },
        ],
      };
      const issues = prioritizeStaticIssues(result);

      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({
        priority: 2,
        priorityLabel: "CRITICAL",
        category: "missing-import",
        file: "structure/modules.sysml",
        line: 15,
      });
    });

    it("assigns P3 HIGH to missing expected outputs", () => {
      const result: SysMLValidationResult = {
        ...emptyResult,
        expectedOutputs: [
          { path: "data/entities.sysml", exists: true },
          { path: "data/enums.sysml", exists: false },
        ],
      };
      const issues = prioritizeStaticIssues(result);

      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({
        priority: 3,
        priorityLabel: "HIGH",
        category: "missing-output",
        file: "data/enums.sysml",
      });
    });

    it("assigns P4 MEDIUM to file coverage mismatches", () => {
      const result: SysMLValidationResult = {
        ...emptyResult,
        fileCoverageMismatches: [
          {
            cycle: "cycle3",
            patterns: ["src/models/*.ts"],
            expected: 10,
            covered: 7,
            uncoveredFiles: ["src/models/User.ts", "src/models/Order.ts", "src/models/Product.ts"],
          },
        ],
      };
      const issues = prioritizeStaticIssues(result);

      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({
        priority: 4,
        priorityLabel: "MEDIUM",
        category: "coverage-mismatch",
      });
      expect(issues[0].description).toContain("7/10 source files covered");
    });

    it("assigns P5 LOW to orphaned files", () => {
      const result: SysMLValidationResult = {
        ...emptyResult,
        orphanedFiles: ["old/legacy.sysml"],
      };
      const issues = prioritizeStaticIssues(result);

      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({
        priority: 5,
        priorityLabel: "LOW",
        category: "orphaned-file",
        file: "old/legacy.sysml",
      });
    });

    it("assigns P5 LOW to coverage issues", () => {
      const result: SysMLValidationResult = {
        ...emptyResult,
        coverageIssues: [
          {
            cycle: "cycle2",
            type: "missing-directory",
            path: "src/legacy",
            detail: "Directory does not exist",
          },
        ],
      };
      const issues = prioritizeStaticIssues(result);

      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({
        priority: 5,
        priorityLabel: "LOW",
        category: "coverage-missing-directory",
      });
    });

    it("handles multiple syntax errors in same file", () => {
      const result: SysMLValidationResult = {
        ...emptyResult,
        syntaxErrors: [
          {
            file: "data/entities.sysml",
            errors: ["Line 5: error 1", "Line 10: error 2"],
          },
        ],
      };
      const issues = prioritizeStaticIssues(result);

      expect(issues).toHaveLength(2);
      expect(issues[0].file).toBe("data/entities.sysml");
      expect(issues[1].file).toBe("data/entities.sysml");
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
