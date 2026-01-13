import { describe, it, expect, beforeEach } from "vitest";
import { ProgressTracker } from "./progress-tracker.js";
import { ScanData } from "./validator.js";

describe("ProgressTracker", () => {
  let tracker: ProgressTracker;

  beforeEach(() => {
    tracker = new ProgressTracker();
  });

  describe("initFromScanData", () => {
    it("adds source files, directories, and root to allItems", () => {
      // Files: src/index.ts, src/lib/utils.ts, src/commands/test.ts
      // Dirs: src, src/lib, src/commands
      // Root: .
      // Total: 3 files + 3 dirs + 1 root = 7
      const scanData: ScanData = {
        sourceFiles: ["src/index.ts", "src/lib/utils.ts", "src/commands/test.ts"],
        directories: new Set(["src", "src/lib", "src/commands"]),
        auFiles: [],
        documented: new Set(),
      };

      tracker.initFromScanData(scanData);

      const counts = tracker.getCounts();
      expect(counts.total).toBe(7);
      expect(counts.documented).toBe(0);
      expect(counts.pending).toBe(7);
    });

    it("handles empty project with no files", () => {
      const scanData: ScanData = {
        sourceFiles: [],
        directories: new Set(),
        auFiles: [],
        documented: new Set(),
      };

      tracker.initFromScanData(scanData);

      const counts = tracker.getCounts();
      expect(counts.total).toBe(0); // no files, no root
    });

    it("marks files as documented from scanData.documented", () => {
      // Files: src/index.ts, src/lib/utils.ts
      // Dirs: src, src/lib
      // Root: .
      // Total: 2 files + 2 dirs + 1 root = 5
      const scanData: ScanData = {
        sourceFiles: ["src/index.ts", "src/lib/utils.ts"],
        directories: new Set(["src", "src/lib"]),
        auFiles: ["src/index.ts.au"],
        documented: new Set(["src/index.ts"]),
      };

      tracker.initFromScanData(scanData);

      const counts = tracker.getCounts();
      expect(counts.total).toBe(5);
      expect(counts.documented).toBe(1);
      expect(counts.pending).toBe(4);
    });

    it("clears previous state when called again", () => {
      const firstData: ScanData = {
        sourceFiles: ["a.ts", "b.ts"],
        directories: new Set(),
        auFiles: [],
        documented: new Set(["a.ts"]),
      };
      tracker.initFromScanData(firstData);
      expect(tracker.getCounts().documented).toBe(1);

      const secondData: ScanData = {
        sourceFiles: ["x.ts"],
        directories: new Set(),
        auFiles: [],
        documented: new Set(),
      };
      tracker.initFromScanData(secondData);

      const counts = tracker.getCounts();
      expect(counts.total).toBe(2); // x.ts + root
      expect(counts.documented).toBe(0);
    });
  });

  describe("markDocumented", () => {
    it("adds file to documented items", () => {
      const scanData: ScanData = {
        sourceFiles: ["src/index.ts", "src/lib/utils.ts"],
        directories: new Set(["src", "src/lib"]),
        auFiles: [],
        documented: new Set(),
      };
      tracker.initFromScanData(scanData);

      tracker.markDocumented("src/index.ts");

      const counts = tracker.getCounts();
      expect(counts.documented).toBe(1);
    });

    it("can mark directories as documented", () => {
      const scanData: ScanData = {
        sourceFiles: ["src/index.ts"],
        directories: new Set(["src"]),
        auFiles: [],
        documented: new Set(),
      };
      tracker.initFromScanData(scanData);

      tracker.markDocumented("src"); // directory
      tracker.markDocumented("."); // root

      const counts = tracker.getCounts();
      expect(counts.documented).toBe(2); // src and root
    });

    it("ignores paths not in allItems", () => {
      const scanData: ScanData = {
        sourceFiles: [],
        directories: new Set(),
        auFiles: [],
        documented: new Set(),
      };
      tracker.initFromScanData(scanData);

      tracker.markDocumented("nonexistent/path");

      const counts = tracker.getCounts();
      expect(counts.documented).toBe(0);
    });
  });

  describe("getProgressPercent", () => {
    it("returns 100 for empty project (nothing to document)", () => {
      const scanData: ScanData = {
        sourceFiles: [],
        directories: new Set(),
        auFiles: [],
        documented: new Set(),
      };
      tracker.initFromScanData(scanData);

      expect(tracker.getProgressPercent()).toBe(100);
    });

    it("returns 0 when no files are documented", () => {
      // Files: src/a.ts, src/b.ts -> Dirs: src -> Root: . -> Total: 4
      const scanData: ScanData = {
        sourceFiles: ["src/a.ts", "src/b.ts"],
        directories: new Set(["src"]),
        auFiles: [],
        documented: new Set(),
      };
      tracker.initFromScanData(scanData);

      expect(tracker.getProgressPercent()).toBe(0);
    });

    it("calculates percentage including directories", () => {
      // Files: src/a.ts, src/b.ts -> Dirs: src -> Root: . -> Total: 4
      const scanData: ScanData = {
        sourceFiles: ["src/a.ts", "src/b.ts"],
        directories: new Set(["src"]),
        auFiles: [],
        documented: new Set(),
      };
      tracker.initFromScanData(scanData);

      tracker.markDocumented("src/a.ts");
      // 1/4 = 25%
      expect(tracker.getProgressPercent()).toBe(25);
    });

    it("returns 100 when all items are documented", () => {
      // Files: src/a.ts, src/b.ts -> Dirs: src -> Root: . -> Total: 4
      const scanData: ScanData = {
        sourceFiles: ["src/a.ts", "src/b.ts"],
        directories: new Set(["src"]),
        auFiles: [],
        documented: new Set(),
      };
      tracker.initFromScanData(scanData);

      tracker.markDocumented("src/a.ts");
      tracker.markDocumented("src/b.ts");
      tracker.markDocumented("src");
      tracker.markDocumented(".");
      // 4/4 = 100%
      expect(tracker.getProgressPercent()).toBe(100);
    });

    it("rounds to nearest integer", () => {
      // Files: a.ts, b.ts, c.ts (root level) -> Root: . -> Total: 4
      const scanData: ScanData = {
        sourceFiles: ["a.ts", "b.ts", "c.ts"],
        directories: new Set(),
        auFiles: [],
        documented: new Set(),
      };
      tracker.initFromScanData(scanData);

      tracker.markDocumented("a.ts");
      // 1/4 = 25%
      expect(tracker.getProgressPercent()).toBe(25);
    });
  });

  describe("getPendingItems", () => {
    it("returns files and directories not yet documented", () => {
      const scanData: ScanData = {
        sourceFiles: ["a.ts", "b.ts", "c.ts"],
        directories: new Set(),
        auFiles: ["b.ts.au"],
        documented: new Set(["b.ts"]),
      };
      tracker.initFromScanData(scanData);

      const pending = tracker.getPendingItems();
      expect(pending).toContain("a.ts");
      expect(pending).toContain("c.ts");
      expect(pending).toContain("."); // root
      expect(pending).not.toContain("b.ts");
    });

    it("respects limit parameter", () => {
      const scanData: ScanData = {
        sourceFiles: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"],
        directories: new Set(),
        auFiles: [],
        documented: new Set(),
      };
      tracker.initFromScanData(scanData);

      const pending = tracker.getPendingItems(2);
      expect(pending.length).toBe(2);
    });

    it("returns all if limit exceeds pending count", () => {
      // Files: a.ts, b.ts -> Root: . -> Total: 3
      const scanData: ScanData = {
        sourceFiles: ["a.ts", "b.ts"],
        directories: new Set(),
        auFiles: [],
        documented: new Set(),
      };
      tracker.initFromScanData(scanData);

      const pending = tracker.getPendingItems(10);
      expect(pending.length).toBe(3);
    });

    it("returns empty array when all documented", () => {
      // File: a.ts -> Root: . -> Total: 2
      const scanData: ScanData = {
        sourceFiles: ["a.ts"],
        directories: new Set(),
        auFiles: ["a.ts.au", ".au"],
        documented: new Set(["a.ts", "."]),
      };
      tracker.initFromScanData(scanData);

      expect(tracker.getPendingItems()).toEqual([]);
    });
  });

  describe("getCounts", () => {
    it("returns correct counts object including directories", () => {
      // Files: a.ts, b.ts, c.ts -> Root: . -> Total: 4
      const scanData: ScanData = {
        sourceFiles: ["a.ts", "b.ts", "c.ts"],
        directories: new Set(),
        auFiles: [],
        documented: new Set(),
      };
      tracker.initFromScanData(scanData);
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
