import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies before importing the gadget
vi.mock("node:fs/promises", () => ({
  readdir: vi.fn(),
  stat: vi.fn(),
}));

vi.mock("../lib/file-filter.js", () => ({
  createFileFilter: vi.fn(() => ({
    accepts: () => true,
  })),
}));

import { readdir, stat } from "node:fs/promises";
import { readDirs } from "./read-dirs.js";
import { createFileFilter } from "../lib/file-filter.js";

describe("readDirs gadget", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(createFileFilter).mockResolvedValue({
      accepts: () => true,
    });
  });

  it("has correct name", () => {
    expect(readDirs.name).toBe("ReadDirs");
  });

  describe("execute", () => {
    it("lists files with sizes at root level", async () => {
      vi.mocked(readdir).mockResolvedValue(["file1.ts", "file2.ts"] as never);
      vi.mocked(stat)
        .mockResolvedValueOnce({ isDirectory: () => false, size: 100 } as never)
        .mockResolvedValueOnce({
          isDirectory: () => false,
          size: 200,
        } as never);

      const result = await readDirs.execute({ paths: "src", depth: 1 });

      expect(result).toContain("# src");
      expect(result).toContain("file1.ts 100");
      expect(result).toContain("file2.ts 200");
    });

    it("shows directories with trailing slash", async () => {
      vi.mocked(readdir).mockResolvedValue(["commands", "lib"] as never);
      vi.mocked(stat)
        .mockResolvedValueOnce({ isDirectory: () => true } as never)
        .mockResolvedValueOnce({ isDirectory: () => true } as never);

      const result = await readDirs.execute({ paths: "src", depth: 1 });

      expect(result).toContain("commands/");
      expect(result).toContain("lib/");
      // Should not have size for directories
      expect(result).not.toContain("commands/ ");
    });

    it("uses indentation for nested items", async () => {
      vi.mocked(readdir)
        .mockResolvedValueOnce(["commands"] as never)
        .mockResolvedValueOnce(["ask.ts", "ingest.ts"] as never);
      vi.mocked(stat)
        .mockResolvedValueOnce({ isDirectory: () => true } as never)
        .mockResolvedValueOnce({
          isDirectory: () => false,
          size: 800,
        } as never)
        .mockResolvedValueOnce({
          isDirectory: () => false,
          size: 900,
        } as never);

      const result = await readDirs.execute({ paths: "src", depth: 2 });

      // Root level - no indent
      expect(result).toMatch(/^commands\/$/m);
      // Nested level - 2 space indent
      expect(result).toMatch(/^  ask\.ts 800$/m);
      expect(result).toMatch(/^  ingest\.ts 900$/m);
    });

    it("uses deeper indentation for deeply nested items", async () => {
      vi.mocked(readdir)
        .mockResolvedValueOnce(["templates"] as never)
        .mockResolvedValueOnce(["ask"] as never)
        .mockResolvedValueOnce(["system.eta"] as never);
      vi.mocked(stat)
        .mockResolvedValueOnce({ isDirectory: () => true } as never)
        .mockResolvedValueOnce({ isDirectory: () => true } as never)
        .mockResolvedValueOnce({
          isDirectory: () => false,
          size: 500,
        } as never);

      const result = await readDirs.execute({ paths: "src", depth: 3 });

      // Root level - no indent
      expect(result).toMatch(/^templates\/$/m);
      // Level 2 - 2 space indent
      expect(result).toMatch(/^  ask\/$/m);
      // Level 3 - 4 space indent
      expect(result).toMatch(/^    system\.eta 500$/m);
    });

    it("respects depth limit", async () => {
      vi.mocked(readdir)
        .mockResolvedValueOnce(["commands"] as never)
        .mockResolvedValueOnce(["nested"] as never);
      vi.mocked(stat)
        .mockResolvedValueOnce({ isDirectory: () => true } as never)
        .mockResolvedValueOnce({ isDirectory: () => true } as never);

      const result = await readDirs.execute({ paths: "src", depth: 1 });

      // Should only show first level
      expect(result).toContain("commands/");
      // readdir should only be called once (for src dir)
      expect(readdir).toHaveBeenCalledTimes(1);
    });

    it("respects gitignore filter", async () => {
      vi.mocked(readdir).mockResolvedValue([
        "file.ts",
        "node_modules",
      ] as never);
      vi.mocked(stat).mockResolvedValueOnce({
        isDirectory: () => false,
        size: 100,
      } as never);
      vi.mocked(createFileFilter).mockResolvedValue({
        accepts: (path: string) => !path.includes("node_modules"),
      });

      const result = await readDirs.execute({ paths: "src", depth: 1 });

      expect(result).toContain("file.ts 100");
      expect(result).not.toContain("node_modules");
    });

    it("includes gitignored files when includeGitIgnored is true", async () => {
      vi.mocked(readdir).mockResolvedValue([
        "file.ts",
        "node_modules",
      ] as never);
      vi.mocked(stat)
        .mockResolvedValueOnce({
          isDirectory: () => false,
          size: 100,
        } as never)
        .mockResolvedValueOnce({
          isDirectory: () => true,
        } as never);
      vi.mocked(createFileFilter).mockResolvedValue({
        accepts: (path: string) => !path.includes("node_modules"),
      });

      const result = await readDirs.execute({
        paths: "src",
        depth: 1,
        includeGitIgnored: true,
      });

      expect(result).toContain("file.ts 100");
      expect(result).toContain("node_modules/");
    });

    it("handles multiple paths", async () => {
      vi.mocked(readdir)
        .mockResolvedValueOnce(["file1.ts"] as never)
        .mockResolvedValueOnce(["file2.ts"] as never);
      vi.mocked(stat)
        .mockResolvedValueOnce({
          isDirectory: () => false,
          size: 100,
        } as never)
        .mockResolvedValueOnce({
          isDirectory: () => false,
          size: 200,
        } as never);

      const result = await readDirs.execute({
        paths: "src\nlib",
        depth: 1,
      });

      expect(result).toContain("# src");
      expect(result).toContain("file1.ts 100");
      expect(result).toContain("# lib");
      expect(result).toContain("file2.ts 200");
    });

    it("handles read errors gracefully", async () => {
      vi.mocked(readdir).mockRejectedValue(new Error("Permission denied"));

      const result = await readDirs.execute({ paths: "src", depth: 1 });

      expect(result).toContain("# src");
      expect(result).toContain("E|");
      expect(result).toContain("Error:");
    });

    it("skips files that cannot be stat'd", async () => {
      // Files are sorted alphabetically, so: alpha.ts, broken.ts, zeta.ts
      vi.mocked(readdir).mockResolvedValue([
        "zeta.ts",
        "broken.ts",
        "alpha.ts",
      ] as never);
      vi.mocked(stat)
        .mockResolvedValueOnce({
          isDirectory: () => false,
          size: 100,
        } as never) // alpha.ts
        .mockRejectedValueOnce(new Error("Cannot stat")) // broken.ts
        .mockResolvedValueOnce({
          isDirectory: () => false,
          size: 300,
        } as never); // zeta.ts

      const result = await readDirs.execute({ paths: "src", depth: 1 });

      expect(result).toContain("alpha.ts 100");
      expect(result).toContain("zeta.ts 300");
      expect(result).not.toContain("broken.ts");
    });

    it("sorts entries alphabetically", async () => {
      vi.mocked(readdir).mockResolvedValue([
        "zebra.ts",
        "alpha.ts",
        "beta.ts",
      ] as never);
      vi.mocked(stat)
        .mockResolvedValueOnce({
          isDirectory: () => false,
          size: 100,
        } as never)
        .mockResolvedValueOnce({
          isDirectory: () => false,
          size: 200,
        } as never)
        .mockResolvedValueOnce({
          isDirectory: () => false,
          size: 300,
        } as never);

      const result = await readDirs.execute({ paths: "src", depth: 1 });

      const lines = (result as string).split("\n");
      const fileLines = lines.filter((l: string) => l.includes(".ts"));
      expect(fileLines[0]).toContain("alpha.ts");
      expect(fileLines[1]).toContain("beta.ts");
      expect(fileLines[2]).toContain("zebra.ts");
    });

    it("formats sizes in kb for files >= 1024 bytes", async () => {
      vi.mocked(readdir).mockResolvedValue(["large.ts"] as never);
      vi.mocked(stat).mockResolvedValueOnce({
        isDirectory: () => false,
        size: 2048,
      } as never);

      const result = await readDirs.execute({ paths: "src", depth: 1 });

      expect(result).toContain("large.ts 2.0kb");
    });

    it("formats sizes in mb for files >= 1MB", async () => {
      vi.mocked(readdir).mockResolvedValue(["huge.ts"] as never);
      vi.mocked(stat).mockResolvedValueOnce({
        isDirectory: () => false,
        size: 1024 * 1024 * 2.5,
      } as never);

      const result = await readDirs.execute({ paths: "src", depth: 1 });

      expect(result).toContain("huge.ts 2.5mb");
    });
  });
});
