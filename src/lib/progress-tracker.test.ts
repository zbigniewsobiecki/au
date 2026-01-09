import { describe, it, expect, beforeEach, vi } from "vitest";
import { ProgressTracker } from "./progress-tracker.js";

// Mock fast-glob
vi.mock("fast-glob", () => ({
  default: vi.fn(),
}));

// Mock findAuFiles from au-paths
vi.mock("./au-paths.js", async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    findAuFiles: vi.fn(),
  };
});

import fg from "fast-glob";
import { findAuFiles } from "./au-paths.js";

describe("ProgressTracker", () => {
  let tracker: ProgressTracker;

  beforeEach(() => {
    tracker = new ProgressTracker();
    vi.clearAllMocks();
  });

  describe("scanSourceFiles", () => {
    it("adds source files to allItems set", async () => {
      vi.mocked(fg).mockResolvedValue([
        "src/index.ts",
        "src/lib/utils.ts",
        "src/commands/test.ts",
      ]);

      await tracker.scanSourceFiles(".");

      const counts = tracker.getCounts();
      expect(counts.total).toBe(3);
      expect(counts.documented).toBe(0);
      expect(counts.pending).toBe(3);
    });

    it("handles empty project", async () => {
      vi.mocked(fg).mockResolvedValue([]);

      await tracker.scanSourceFiles(".");

      const counts = tracker.getCounts();
      expect(counts.total).toBe(0);
    });
  });

  describe("scanExistingAuFiles", () => {
    it("marks files as documented based on .au files", async () => {
      // First scan source files
      vi.mocked(fg).mockResolvedValue([
        "src/index.ts",
        "src/lib/utils.ts",
      ]);
      await tracker.scanSourceFiles(".");

      // Then scan existing AU files
      vi.mocked(findAuFiles).mockResolvedValue([
        "src/index.ts.au",
      ]);
      await tracker.scanExistingAuFiles(".");

      const counts = tracker.getCounts();
      expect(counts.total).toBe(2);
      expect(counts.documented).toBe(1);
      expect(counts.pending).toBe(1);
    });
  });

  describe("markDocumented", () => {
    it("adds file to documented items", async () => {
      vi.mocked(fg).mockResolvedValue(["src/index.ts", "src/lib/utils.ts"]);
      await tracker.scanSourceFiles(".");

      tracker.markDocumented("src/index.ts");

      const counts = tracker.getCounts();
      expect(counts.documented).toBe(1);
    });

    it("can mark files not in allItems (edge case)", () => {
      tracker.markDocumented("some/new/file.ts");

      const counts = tracker.getCounts();
      expect(counts.documented).toBe(1);
    });
  });

  describe("getProgressPercent", () => {
    it("returns 100 for empty project", async () => {
      vi.mocked(fg).mockResolvedValue([]);
      await tracker.scanSourceFiles(".");

      expect(tracker.getProgressPercent()).toBe(100);
    });

    it("returns 0 when no files are documented", async () => {
      vi.mocked(fg).mockResolvedValue(["src/a.ts", "src/b.ts"]);
      await tracker.scanSourceFiles(".");

      expect(tracker.getProgressPercent()).toBe(0);
    });

    it("returns 50 when half are documented", async () => {
      vi.mocked(fg).mockResolvedValue(["src/a.ts", "src/b.ts"]);
      await tracker.scanSourceFiles(".");

      tracker.markDocumented("src/a.ts");

      expect(tracker.getProgressPercent()).toBe(50);
    });

    it("returns 100 when all are documented", async () => {
      vi.mocked(fg).mockResolvedValue(["src/a.ts", "src/b.ts"]);
      await tracker.scanSourceFiles(".");

      tracker.markDocumented("src/a.ts");
      tracker.markDocumented("src/b.ts");

      expect(tracker.getProgressPercent()).toBe(100);
    });

    it("rounds to nearest integer", async () => {
      vi.mocked(fg).mockResolvedValue(["a.ts", "b.ts", "c.ts"]);
      await tracker.scanSourceFiles(".");

      tracker.markDocumented("a.ts");
      // 1/3 = 33.33% should round to 33
      expect(tracker.getProgressPercent()).toBe(33);
    });
  });

  describe("getPendingItems", () => {
    it("returns files not yet documented", async () => {
      vi.mocked(fg).mockResolvedValue(["a.ts", "b.ts", "c.ts"]);
      await tracker.scanSourceFiles(".");

      tracker.markDocumented("b.ts");

      const pending = tracker.getPendingItems();
      expect(pending).toContain("a.ts");
      expect(pending).toContain("c.ts");
      expect(pending).not.toContain("b.ts");
    });

    it("respects limit parameter", async () => {
      vi.mocked(fg).mockResolvedValue(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]);
      await tracker.scanSourceFiles(".");

      const pending = tracker.getPendingItems(2);
      expect(pending.length).toBe(2);
    });

    it("returns all if limit exceeds pending count", async () => {
      vi.mocked(fg).mockResolvedValue(["a.ts", "b.ts"]);
      await tracker.scanSourceFiles(".");

      const pending = tracker.getPendingItems(10);
      expect(pending.length).toBe(2);
    });

    it("returns empty array when all documented", async () => {
      vi.mocked(fg).mockResolvedValue(["a.ts"]);
      await tracker.scanSourceFiles(".");
      tracker.markDocumented("a.ts");

      expect(tracker.getPendingItems()).toEqual([]);
    });
  });

  describe("getCounts", () => {
    it("returns correct counts object", async () => {
      vi.mocked(fg).mockResolvedValue(["a.ts", "b.ts", "c.ts"]);
      await tracker.scanSourceFiles(".");
      tracker.markDocumented("a.ts");

      const counts = tracker.getCounts();
      expect(counts).toEqual({
        total: 3,
        documented: 1,
        pending: 2,
      });
    });
  });
});
