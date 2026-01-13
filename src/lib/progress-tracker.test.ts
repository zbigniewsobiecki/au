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
    it("adds source files, directories, and root to allItems", async () => {
      // Files: src/index.ts, src/lib/utils.ts, src/commands/test.ts
      // Dirs: src, src/lib, src/commands
      // Root: .
      // Total: 3 files + 3 dirs + 1 root = 7
      vi.mocked(fg).mockResolvedValue([
        "src/index.ts",
        "src/lib/utils.ts",
        "src/commands/test.ts",
      ]);

      await tracker.scanSourceFiles(".");

      const counts = tracker.getCounts();
      expect(counts.total).toBe(7);
      expect(counts.documented).toBe(0);
      expect(counts.pending).toBe(7);
    });

    it("handles empty project with just root", async () => {
      vi.mocked(fg).mockResolvedValue([]);

      await tracker.scanSourceFiles(".");

      const counts = tracker.getCounts();
      expect(counts.total).toBe(1); // just root "."
    });
  });

  describe("scanExistingAuFiles", () => {
    it("marks files as documented based on .au files", async () => {
      // Files: src/index.ts, src/lib/utils.ts
      // Dirs: src, src/lib
      // Root: .
      // Total: 2 files + 2 dirs + 1 root = 5
      vi.mocked(fg).mockResolvedValue([
        "src/index.ts",
        "src/lib/utils.ts",
      ]);
      await tracker.scanSourceFiles(".");

      // Mark one file as documented
      vi.mocked(findAuFiles).mockResolvedValue([
        "src/index.ts.au",
      ]);
      await tracker.scanExistingAuFiles(".");

      const counts = tracker.getCounts();
      expect(counts.total).toBe(5);
      expect(counts.documented).toBe(1);
      expect(counts.pending).toBe(4);
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

    it("can mark directories as documented", async () => {
      vi.mocked(fg).mockResolvedValue(["src/index.ts"]);
      await tracker.scanSourceFiles(".");

      tracker.markDocumented("src"); // directory
      tracker.markDocumented("."); // root

      const counts = tracker.getCounts();
      expect(counts.documented).toBe(2); // src and root
    });

    it("ignores paths not in allItems", () => {
      tracker.markDocumented("nonexistent/path");

      const counts = tracker.getCounts();
      expect(counts.documented).toBe(0);
    });
  });

  describe("getProgressPercent", () => {
    it("returns 0 for empty project (only root undocumented)", async () => {
      vi.mocked(fg).mockResolvedValue([]);
      await tracker.scanSourceFiles(".");

      expect(tracker.getProgressPercent()).toBe(0); // root is undocumented
    });

    it("returns 100 when root is documented in empty project", async () => {
      vi.mocked(fg).mockResolvedValue([]);
      await tracker.scanSourceFiles(".");
      tracker.markDocumented(".");

      expect(tracker.getProgressPercent()).toBe(100);
    });

    it("returns 0 when no files are documented", async () => {
      // Files: src/a.ts, src/b.ts -> Dirs: src -> Root: . -> Total: 4
      vi.mocked(fg).mockResolvedValue(["src/a.ts", "src/b.ts"]);
      await tracker.scanSourceFiles(".");

      expect(tracker.getProgressPercent()).toBe(0);
    });

    it("calculates percentage including directories", async () => {
      // Files: src/a.ts, src/b.ts -> Dirs: src -> Root: . -> Total: 4
      vi.mocked(fg).mockResolvedValue(["src/a.ts", "src/b.ts"]);
      await tracker.scanSourceFiles(".");

      tracker.markDocumented("src/a.ts");
      // 1/4 = 25%
      expect(tracker.getProgressPercent()).toBe(25);
    });

    it("returns 100 when all items are documented", async () => {
      // Files: src/a.ts, src/b.ts -> Dirs: src -> Root: . -> Total: 4
      vi.mocked(fg).mockResolvedValue(["src/a.ts", "src/b.ts"]);
      await tracker.scanSourceFiles(".");

      tracker.markDocumented("src/a.ts");
      tracker.markDocumented("src/b.ts");
      tracker.markDocumented("src");
      tracker.markDocumented(".");
      // 4/4 = 100%
      expect(tracker.getProgressPercent()).toBe(100);
    });

    it("rounds to nearest integer", async () => {
      // Files: a.ts, b.ts, c.ts (root level) -> Root: . -> Total: 4
      vi.mocked(fg).mockResolvedValue(["a.ts", "b.ts", "c.ts"]);
      await tracker.scanSourceFiles(".");

      tracker.markDocumented("a.ts");
      // 1/4 = 25%
      expect(tracker.getProgressPercent()).toBe(25);
    });
  });

  describe("getPendingItems", () => {
    it("returns files and directories not yet documented", async () => {
      vi.mocked(fg).mockResolvedValue(["a.ts", "b.ts", "c.ts"]);
      await tracker.scanSourceFiles(".");

      tracker.markDocumented("b.ts");

      const pending = tracker.getPendingItems();
      expect(pending).toContain("a.ts");
      expect(pending).toContain("c.ts");
      expect(pending).toContain("."); // root
      expect(pending).not.toContain("b.ts");
    });

    it("respects limit parameter", async () => {
      vi.mocked(fg).mockResolvedValue(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]);
      await tracker.scanSourceFiles(".");

      const pending = tracker.getPendingItems(2);
      expect(pending.length).toBe(2);
    });

    it("returns all if limit exceeds pending count", async () => {
      // Files: a.ts, b.ts -> Root: . -> Total: 3
      vi.mocked(fg).mockResolvedValue(["a.ts", "b.ts"]);
      await tracker.scanSourceFiles(".");

      const pending = tracker.getPendingItems(10);
      expect(pending.length).toBe(3);
    });

    it("returns empty array when all documented", async () => {
      // File: a.ts -> Root: . -> Total: 2
      vi.mocked(fg).mockResolvedValue(["a.ts"]);
      await tracker.scanSourceFiles(".");
      tracker.markDocumented("a.ts");
      tracker.markDocumented(".");

      expect(tracker.getPendingItems()).toEqual([]);
    });
  });

  describe("getCounts", () => {
    it("returns correct counts object including directories", async () => {
      // Files: a.ts, b.ts, c.ts -> Root: . -> Total: 4
      vi.mocked(fg).mockResolvedValue(["a.ts", "b.ts", "c.ts"]);
      await tracker.scanSourceFiles(".");
      tracker.markDocumented("a.ts");

      const counts = tracker.getCounts();
      expect(counts).toEqual({
        total: 4,
        documented: 1,
        pending: 3,
      });
    });
  });
});
