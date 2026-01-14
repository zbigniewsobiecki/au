import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock git-utils before importing the gadget
vi.mock("../lib/git-utils.js", () => ({
  getChangedFiles: vi.fn(),
}));

import { getChangedFiles } from "../lib/git-utils.js";
import { gitDiffList } from "./git-diff-list.js";

describe("gitDiffList gadget", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("has correct name", () => {
    expect(gitDiffList.name).toBe("GitDiffList");
  });

  describe("execute", () => {
    it("formats added files", async () => {
      vi.mocked(getChangedFiles).mockResolvedValue([
        { path: "src/new-file.ts", status: "A" },
      ]);

      const result = await gitDiffList.execute({ baseBranch: "main" });

      expect(result).toContain("Changed files (1):");
      expect(result).toContain("added: src/new-file.ts");
    });

    it("formats modified files", async () => {
      vi.mocked(getChangedFiles).mockResolvedValue([
        { path: "src/index.ts", status: "M" },
      ]);

      const result = await gitDiffList.execute({ baseBranch: "main" });

      expect(result).toContain("modified: src/index.ts");
    });

    it("formats deleted files", async () => {
      vi.mocked(getChangedFiles).mockResolvedValue([
        { path: "src/old-file.ts", status: "D" },
      ]);

      const result = await gitDiffList.execute({ baseBranch: "main" });

      expect(result).toContain("deleted: src/old-file.ts");
    });

    it("formats renamed files with arrow", async () => {
      vi.mocked(getChangedFiles).mockResolvedValue([
        { path: "src/new-name.ts", status: "R", oldPath: "src/old-name.ts" },
      ]);

      const result = await gitDiffList.execute({ baseBranch: "main" });

      expect(result).toContain("renamed: src/old-name.ts -> src/new-name.ts");
    });

    it("formats multiple files", async () => {
      vi.mocked(getChangedFiles).mockResolvedValue([
        { path: "src/new.ts", status: "A" },
        { path: "src/modified.ts", status: "M" },
        { path: "src/deleted.ts", status: "D" },
      ]);

      const result = await gitDiffList.execute({ baseBranch: "dev" });

      expect(result).toContain("Changed files (3):");
      expect(result).toContain("added: src/new.ts");
      expect(result).toContain("modified: src/modified.ts");
      expect(result).toContain("deleted: src/deleted.ts");
    });

    it("returns message when no files changed", async () => {
      vi.mocked(getChangedFiles).mockResolvedValue([]);

      const result = await gitDiffList.execute({ baseBranch: "main" });

      expect(result).toBe("No files changed between branches.");
    });

    it("passes baseBranch to getChangedFiles", async () => {
      vi.mocked(getChangedFiles).mockResolvedValue([]);

      await gitDiffList.execute({ baseBranch: "feature/test" });

      expect(getChangedFiles).toHaveBeenCalledWith("feature/test");
    });

    it("handles unknown status codes gracefully", async () => {
      vi.mocked(getChangedFiles).mockResolvedValue([
        { path: "src/file.ts", status: "X" as "A" }, // Cast to satisfy type, but test unknown
      ]);

      const result = await gitDiffList.execute({ baseBranch: "main" });

      // Should fall back to showing the raw status code
      expect(result).toContain("X: src/file.ts");
    });
  });
});
