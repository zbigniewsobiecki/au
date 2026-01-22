import { describe, it, expect, beforeEach, vi } from "vitest";
import { createFileFilter } from "./file-filter.js";
import * as fs from "node:fs/promises";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

describe("createFileFilter", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("default behavior", () => {
    it("accepts regular source files", async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"));
      const filter = await createFileFilter(".");

      expect(filter.accepts("src/index.ts")).toBe(true);
      expect(filter.accepts("lib/utils.js")).toBe(true);
      expect(filter.accepts("README.md")).toBe(true);
    });

    it("rejects .au files", async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"));
      const filter = await createFileFilter(".");

      expect(filter.accepts("src/index.ts.au")).toBe(false);
      expect(filter.accepts("src/.au")).toBe(false);
      expect(filter.accepts(".au")).toBe(false);
    });

    it("accepts directories when no gitignore exists", async () => {
      // Without gitignore, no directories are rejected (except .au and .git)
      vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"));
      const filter = await createFileFilter(".");

      // These are accepted because there's no gitignore
      expect(filter.accepts("node_modules/package/index.js")).toBe(true);
      expect(filter.accepts("dist/index.js")).toBe(true);
    });

    it("rejects .git directory even without gitignore", async () => {
      // .git is always ignored (git implicitly excludes its own directory)
      vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"));
      const filter = await createFileFilter(".");

      expect(filter.accepts(".git")).toBe(false);
      expect(filter.accepts(".git/config")).toBe(false);
      expect(filter.accepts(".git/hooks/pre-commit")).toBe(false);
    });

    it("rejects directories specified in gitignore", async () => {
      // Typical gitignore content
      vi.mocked(fs.readFile).mockResolvedValue("node_modules\n.git\ndist\nbuild\n.next\n.cache");
      const filter = await createFileFilter(".");

      expect(filter.accepts("node_modules/package/index.js")).toBe(false);
      expect(filter.accepts(".git/config")).toBe(false);
      expect(filter.accepts("dist/index.js")).toBe(false);
      expect(filter.accepts("build/output.js")).toBe(false);
      expect(filter.accepts(".next/static/chunks/main.js")).toBe(false);
      expect(filter.accepts(".cache/data.json")).toBe(false);
    });

    it("rejects directories with trailing slash in gitignore", async () => {
      // gitignore often has trailing slashes for directories
      vi.mocked(fs.readFile).mockResolvedValue("node_modules/\ndist/");
      const filter = await createFileFilter(".");

      // Directory itself should be rejected
      expect(filter.accepts("node_modules")).toBe(false);
      expect(filter.accepts("dist")).toBe(false);
      // Nested directories should also be rejected
      expect(filter.accepts("packages/backend/node_modules")).toBe(false);
      // Contents should be rejected
      expect(filter.accepts("node_modules/pkg/index.js")).toBe(false);
    });
  });

  describe("path normalization", () => {
    it("handles paths starting with ./", async () => {
      vi.mocked(fs.readFile).mockResolvedValue("node_modules");
      const filter = await createFileFilter(".");

      expect(filter.accepts("./src/index.ts")).toBe(true);
      expect(filter.accepts("./node_modules/pkg")).toBe(false);
    });

    it("handles paths starting with /", async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"));
      const filter = await createFileFilter(".");

      expect(filter.accepts("/src/index.ts")).toBe(true);
    });

    it("accepts root path '.'", async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"));
      const filter = await createFileFilter(".");

      expect(filter.accepts(".")).toBe(true);
    });

    it("accepts empty string", async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"));
      const filter = await createFileFilter(".");

      expect(filter.accepts("")).toBe(true);
    });
  });

  describe("gitignore integration", () => {
    it("respects gitignore patterns", async () => {
      vi.mocked(fs.readFile).mockResolvedValue("*.log\ntmp/\nsecrets.json");
      const filter = await createFileFilter(".");

      expect(filter.accepts("debug.log")).toBe(false);
      expect(filter.accepts("tmp/cache.txt")).toBe(false);
      expect(filter.accepts("secrets.json")).toBe(false);
      expect(filter.accepts("src/index.ts")).toBe(true);
    });

    it("handles missing gitignore gracefully", async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"));
      const filter = await createFileFilter(".");

      // Should work normally without gitignore
      expect(filter.accepts("src/index.ts")).toBe(true);
    });

    it("combines gitignore with default .au ignores", async () => {
      vi.mocked(fs.readFile).mockResolvedValue("custom-ignore/\nnode_modules");
      const filter = await createFileFilter(".");

      // Custom ignore from gitignore
      expect(filter.accepts("custom-ignore/file.txt")).toBe(false);
      // node_modules from gitignore
      expect(filter.accepts("node_modules/pkg")).toBe(false);
      // .au files are always ignored (hardcoded)
      expect(filter.accepts(".au")).toBe(false);
    });
  });
});
