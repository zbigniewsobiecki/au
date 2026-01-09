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

    it("rejects node_modules", async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"));
      const filter = await createFileFilter(".");

      expect(filter.accepts("node_modules/package/index.js")).toBe(false);
    });

    it("rejects .git directory", async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"));
      const filter = await createFileFilter(".");

      expect(filter.accepts(".git/config")).toBe(false);
    });

    it("rejects dist/build directories", async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"));
      const filter = await createFileFilter(".");

      expect(filter.accepts("dist/index.js")).toBe(false);
      expect(filter.accepts("build/output.js")).toBe(false);
    });

    it("rejects .next and .cache directories", async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"));
      const filter = await createFileFilter(".");

      expect(filter.accepts(".next/static/chunks/main.js")).toBe(false);
      expect(filter.accepts(".cache/data.json")).toBe(false);
    });
  });

  describe("path normalization", () => {
    it("handles paths starting with ./", async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"));
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

    it("combines gitignore with default ignores", async () => {
      vi.mocked(fs.readFile).mockResolvedValue("custom-ignore/");
      const filter = await createFileFilter(".");

      // Custom ignore from gitignore
      expect(filter.accepts("custom-ignore/file.txt")).toBe(false);
      // Default ignores still apply
      expect(filter.accepts("node_modules/pkg")).toBe(false);
      expect(filter.accepts(".au")).toBe(false);
    });
  });
});
