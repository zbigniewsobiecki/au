import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock git-utils before importing the gadget
vi.mock("../lib/git-utils.js", () => ({
  getFileDiff: vi.fn(),
}));

import { getFileDiff } from "../lib/git-utils.js";
import { gitDiff } from "./git-diff.js";

describe("gitDiff gadget", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("has correct name", () => {
    expect(gitDiff.name).toBe("GitDiff");
  });

  describe("execute", () => {
    it("returns diff for single file", async () => {
      vi.mocked(getFileDiff).mockResolvedValue("=== src/index.ts ===\n+new line");

      const result = await gitDiff.execute({
        baseBranch: "main",
        paths: "src/index.ts",
      });

      expect(result).toContain("=== src/index.ts ===");
      expect(result).toContain("+new line");
      expect(getFileDiff).toHaveBeenCalledWith("main", "src/index.ts");
    });

    it("returns diffs for multiple files", async () => {
      vi.mocked(getFileDiff)
        .mockResolvedValueOnce("=== src/a.ts ===\n+line a")
        .mockResolvedValueOnce("=== src/b.ts ===\n-line b");

      const result = await gitDiff.execute({
        baseBranch: "dev",
        paths: "src/a.ts\nsrc/b.ts",
      });

      expect(result).toContain("=== src/a.ts ===");
      expect(result).toContain("+line a");
      expect(result).toContain("=== src/b.ts ===");
      expect(result).toContain("-line b");
      expect(getFileDiff).toHaveBeenCalledTimes(2);
    });

    it("trims whitespace from paths", async () => {
      vi.mocked(getFileDiff).mockResolvedValue("=== src/index.ts ===\ndiff");

      await gitDiff.execute({
        baseBranch: "main",
        paths: "  src/index.ts  \n",
      });

      expect(getFileDiff).toHaveBeenCalledWith("main", "src/index.ts");
    });

    it("filters out empty paths", async () => {
      vi.mocked(getFileDiff).mockResolvedValue("=== src/index.ts ===\ndiff");

      await gitDiff.execute({
        baseBranch: "main",
        paths: "src/index.ts\n\n  \n",
      });

      expect(getFileDiff).toHaveBeenCalledTimes(1);
    });

    it("returns message when no paths provided", async () => {
      const result = await gitDiff.execute({
        baseBranch: "main",
        paths: "",
      });

      expect(result).toBe("No file paths provided.");
      expect(getFileDiff).not.toHaveBeenCalled();
    });

    it("returns message when paths is only whitespace", async () => {
      const result = await gitDiff.execute({
        baseBranch: "main",
        paths: "   \n  \n  ",
      });

      expect(result).toBe("No file paths provided.");
      expect(getFileDiff).not.toHaveBeenCalled();
    });

    it("separates multiple file diffs with double newline", async () => {
      vi.mocked(getFileDiff)
        .mockResolvedValueOnce("=== a.ts ===\ndiff a")
        .mockResolvedValueOnce("=== b.ts ===\ndiff b")
        .mockResolvedValueOnce("=== c.ts ===\ndiff c");

      const result = await gitDiff.execute({
        baseBranch: "main",
        paths: "a.ts\nb.ts\nc.ts",
      });

      // Check that diffs are separated by double newline
      expect(result).toBe(
        "=== a.ts ===\ndiff a\n\n=== b.ts ===\ndiff b\n\n=== c.ts ===\ndiff c"
      );
    });

    it("passes correct baseBranch to getFileDiff", async () => {
      vi.mocked(getFileDiff).mockResolvedValue("diff");

      await gitDiff.execute({
        baseBranch: "feature/my-branch",
        paths: "src/file.ts",
      });

      expect(getFileDiff).toHaveBeenCalledWith("feature/my-branch", "src/file.ts");
    });

    it("fetches diffs in parallel", async () => {
      // Create a mock that tracks call order
      const callOrder: string[] = [];
      vi.mocked(getFileDiff).mockImplementation(async (_branch, path) => {
        callOrder.push(`start:${path}`);
        await new Promise((r) => setTimeout(r, 10));
        callOrder.push(`end:${path}`);
        return `=== ${path} ===\ndiff`;
      });

      await gitDiff.execute({
        baseBranch: "main",
        paths: "a.ts\nb.ts\nc.ts",
      });

      // All should start before any ends (parallel execution)
      const starts = callOrder.filter((c) => c.startsWith("start:"));
      const firstEnd = callOrder.findIndex((c) => c.startsWith("end:"));
      expect(starts.length).toBe(3);
      expect(firstEnd).toBeGreaterThanOrEqual(3);
    });
  });
});
