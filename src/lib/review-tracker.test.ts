import { describe, it, expect, beforeEach, vi } from "vitest";
import { ReviewTracker } from "./review-tracker.js";

// Mock findAuFiles from au-paths
vi.mock("./au-paths.js", async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    findAuFiles: vi.fn(),
  };
});

// Mock fs/promises
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

import { findAuFiles } from "./au-paths.js";
import { readFile } from "node:fs/promises";

describe("ReviewTracker", () => {
  let tracker: ReviewTracker;

  beforeEach(() => {
    tracker = new ReviewTracker();
    vi.clearAllMocks();
  });

  describe("scan", () => {
    it("finds and checks all .au files", async () => {
      vi.mocked(findAuFiles).mockResolvedValue([
        "src/index.ts.au",
        "src/lib/utils.ts.au",
      ]);
      vi.mocked(readFile).mockResolvedValue(`
layer: core
understanding:
  summary: A test file
  purpose: Does something
`);

      await tracker.scan(".");

      expect(findAuFiles).toHaveBeenCalledWith(".", false);
      expect(tracker.getIssueCount()).toBe(0);
    });

    it("detects missing layer", async () => {
      vi.mocked(findAuFiles).mockResolvedValue(["src/index.ts.au"]);
      vi.mocked(readFile).mockResolvedValue(`
understanding:
  summary: A test file
`);

      await tracker.scan(".");

      expect(tracker.getIssueCount()).toBe(1);
      const issues = tracker.getNextFiles(1);
      expect(issues[0].issues).toContain("missing layer");
    });

    it("detects missing summary", async () => {
      vi.mocked(findAuFiles).mockResolvedValue(["src/index.ts.au"]);
      vi.mocked(readFile).mockResolvedValue(`
layer: core
understanding:
  purpose: Does something
`);

      await tracker.scan(".");

      expect(tracker.getIssueCount()).toBe(1);
      const issues = tracker.getNextFiles(1);
      expect(issues[0].issues).toContain("missing summary");
    });

    it("detects missing purpose for source files", async () => {
      vi.mocked(findAuFiles).mockResolvedValue(["src/index.ts.au"]);
      vi.mocked(readFile).mockResolvedValue(`
layer: core
understanding:
  summary: A test file
`);

      await tracker.scan(".");

      expect(tracker.getIssueCount()).toBe(1);
      const issues = tracker.getNextFiles(1);
      expect(issues[0].issues).toContain("missing purpose");
    });

    it("does not require purpose for directory .au files", async () => {
      vi.mocked(findAuFiles).mockResolvedValue(["src/.au"]);
      vi.mocked(readFile).mockResolvedValue(`
layer: core
understanding:
  summary: Source directory
  responsibility: Contains source code
contents:
  - index.ts
`);

      await tracker.scan(".");

      expect(tracker.getIssueCount()).toBe(0);
    });

    it("detects missing responsibility for directories", async () => {
      vi.mocked(findAuFiles).mockResolvedValue(["src/.au"]);
      vi.mocked(readFile).mockResolvedValue(`
layer: core
understanding:
  summary: Source directory
contents:
  - index.ts
`);

      await tracker.scan(".");

      expect(tracker.getIssueCount()).toBe(1);
      const issues = tracker.getNextFiles(1);
      expect(issues[0].issues).toContain("missing responsibility");
    });

    it("detects missing contents for directories", async () => {
      vi.mocked(findAuFiles).mockResolvedValue(["src/.au"]);
      vi.mocked(readFile).mockResolvedValue(`
layer: core
understanding:
  summary: Source directory
  responsibility: Contains code
`);

      await tracker.scan(".");

      const issues = tracker.getNextFiles(1);
      expect(issues[0].issues).toContain("missing contents");
    });

    it("detects missing architecture for root .au", async () => {
      vi.mocked(findAuFiles).mockResolvedValue([".au"]);
      vi.mocked(readFile).mockResolvedValue(`
layer: repository
understanding:
  summary: A project
`);

      await tracker.scan(".");

      const issues = tracker.getNextFiles(1);
      expect(issues[0].issues).toContain("missing architecture");
    });

    it("detects missing key_logic for service files", async () => {
      vi.mocked(findAuFiles).mockResolvedValue(["src/services/auth.ts.au"]);
      vi.mocked(readFile).mockResolvedValue(`
layer: service
understanding:
  summary: Auth service
  purpose: Handles authentication
`);

      await tracker.scan(".");

      const issues = tracker.getNextFiles(1);
      expect(issues[0].issues).toContain("missing key_logic");
    });

    it("detects missing key_logic for util files", async () => {
      vi.mocked(findAuFiles).mockResolvedValue(["src/utils/format.ts.au"]);
      vi.mocked(readFile).mockResolvedValue(`
layer: util
understanding:
  summary: Format utilities
  purpose: Formatting helpers
`);

      await tracker.scan(".");

      const issues = tracker.getNextFiles(1);
      expect(issues[0].issues).toContain("missing key_logic");
    });

    it("handles empty YAML file", async () => {
      vi.mocked(findAuFiles).mockResolvedValue(["src/index.ts.au"]);
      vi.mocked(readFile).mockResolvedValue("");

      await tracker.scan(".");

      const issues = tracker.getNextFiles(1);
      expect(issues[0].issues).toContain("empty file");
    });

    it("handles YAML parse errors", async () => {
      vi.mocked(findAuFiles).mockResolvedValue(["src/index.ts.au"]);
      vi.mocked(readFile).mockResolvedValue("invalid: yaml: content:");

      await tracker.scan(".");

      const issues = tracker.getNextFiles(1);
      expect(issues[0].issues.some(i => i.startsWith("parse error"))).toBe(true);
    });

    it("handles file read errors", async () => {
      vi.mocked(findAuFiles).mockResolvedValue(["src/index.ts.au"]);
      vi.mocked(readFile).mockRejectedValue(new Error("File not found"));

      await tracker.scan(".");

      const issues = tracker.getNextFiles(1);
      expect(issues[0].issues.some(i => i.includes("File not found"))).toBe(true);
    });
  });

  describe("markReviewed", () => {
    it("removes file from issues", async () => {
      vi.mocked(findAuFiles).mockResolvedValue(["src/index.ts.au"]);
      vi.mocked(readFile).mockResolvedValue(`
understanding:
  summary: Test
`);

      await tracker.scan(".");
      expect(tracker.getIssueCount()).toBe(1);

      tracker.markReviewed("src/index.ts");
      expect(tracker.getIssueCount()).toBe(0);
    });

    it("handles marking non-existent file", () => {
      tracker.markReviewed("nonexistent.ts");
      expect(tracker.getIssueCount()).toBe(0);
    });
  });

  describe("getIssueCount", () => {
    it("returns number of files with issues", async () => {
      vi.mocked(findAuFiles).mockResolvedValue([
        "src/a.ts.au",
        "src/b.ts.au",
        "src/c.ts.au",
      ]);
      // Missing layer in all
      vi.mocked(readFile).mockResolvedValue(`
understanding:
  summary: Test
`);

      await tracker.scan(".");

      expect(tracker.getIssueCount()).toBe(3);
    });
  });

  describe("getIssueBreakdownStrings", () => {
    it("returns sorted breakdown of issues", async () => {
      vi.mocked(findAuFiles).mockResolvedValue([
        "src/a.ts.au",
        "src/b.ts.au",
        "src/c.ts.au",
      ]);
      // All missing layer and purpose, first two also missing summary
      vi.mocked(readFile)
        .mockResolvedValueOnce(`understanding:\n  purpose: test`)
        .mockResolvedValueOnce(`understanding:\n  purpose: test`)
        .mockResolvedValueOnce(`understanding:\n  summary: test`);

      await tracker.scan(".");

      const breakdown = tracker.getIssueBreakdownStrings();
      // Should be sorted by count, highest first
      expect(breakdown[0]).toMatch(/3 files missing layer/);
    });

    it("returns empty array when no issues", async () => {
      vi.mocked(findAuFiles).mockResolvedValue([]);

      await tracker.scan(".");

      expect(tracker.getIssueBreakdownStrings()).toEqual([]);
    });
  });

  describe("getNextFiles", () => {
    it("returns requested number of files", async () => {
      vi.mocked(findAuFiles).mockResolvedValue([
        "src/a.ts.au",
        "src/b.ts.au",
        "src/c.ts.au",
      ]);
      vi.mocked(readFile).mockResolvedValue(`layer: core`);

      await tracker.scan(".");

      const next = tracker.getNextFiles(2);
      expect(next.length).toBe(2);
    });

    it("returns all if less than requested", async () => {
      vi.mocked(findAuFiles).mockResolvedValue(["src/a.ts.au"]);
      vi.mocked(readFile).mockResolvedValue(`layer: core`);

      await tracker.scan(".");

      const next = tracker.getNextFiles(10);
      expect(next.length).toBe(1);
    });

    it("returns empty array when no issues", async () => {
      vi.mocked(findAuFiles).mockResolvedValue(["src/a.ts.au"]);
      vi.mocked(readFile).mockResolvedValue(`
layer: core
understanding:
  summary: Test
  purpose: Does something
`);

      await tracker.scan(".");

      expect(tracker.getNextFiles()).toEqual([]);
    });
  });
});
