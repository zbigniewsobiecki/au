import { describe, it, expect, beforeEach, vi } from "vitest";
import { Validator, ValidationResult } from "./validator.js";

// Mock fast-glob
vi.mock("fast-glob", () => ({
  default: vi.fn(),
}));

// Mock findAuFiles and other au-paths functions
vi.mock("./au-paths.js", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    findAuFiles: vi.fn(),
  };
});

// Mock file-filter
vi.mock("./file-filter.js", () => ({
  createFileFilter: vi.fn(() =>
    Promise.resolve({
      accepts: (path: string) => {
        // Default: accept everything except .au files and node_modules
        if (path.endsWith(".au") || path === ".au") return false;
        if (path.includes("node_modules")) return false;
        return true;
      },
    })
  ),
}));

// Mock fs/promises
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
}));

import fg from "fast-glob";
import { findAuFiles } from "./au-paths.js";
import { readFile, readdir, stat } from "node:fs/promises";

describe("Validator", () => {
  let validator: Validator;

  beforeEach(() => {
    validator = new Validator();
    vi.clearAllMocks();
    // Default: all files are non-empty
    vi.mocked(stat).mockResolvedValue({ size: 100 } as any);
  });

  describe("findUncovered", () => {
    it("finds source files without .au files", async () => {
      vi.mocked(fg).mockResolvedValue([
        "src/index.ts",
        "src/lib/utils.ts",
        "src/commands/test.ts",
      ]);
      vi.mocked(findAuFiles).mockResolvedValue(["src/index.ts.au"]);

      const result = await validator.validate(".");

      expect(result.uncovered).toContain("src/lib/utils.ts");
      expect(result.uncovered).toContain("src/commands/test.ts");
      expect(result.uncovered).not.toContain("src/index.ts");
    });

    it("finds directories without .au files", async () => {
      vi.mocked(fg).mockResolvedValue([
        "src/lib/utils.ts",
        "src/commands/test.ts",
      ]);
      vi.mocked(findAuFiles).mockResolvedValue([
        "src/lib/utils.ts.au",
        "src/commands/test.ts.au",
        "src/.au", // src has .au but src/lib and src/commands don't
      ]);

      const result = await validator.validate(".");

      expect(result.uncovered).toContain("src/lib/");
      expect(result.uncovered).toContain("src/commands/");
    });

    it("returns empty array when all files are covered", async () => {
      vi.mocked(fg).mockResolvedValue(["src/index.ts"]);
      vi.mocked(findAuFiles).mockResolvedValue([
        "src/index.ts.au",
        "src/.au",
      ]);

      const result = await validator.validate(".");

      expect(result.uncovered).toEqual([]);
    });

    it("handles empty project", async () => {
      vi.mocked(fg).mockResolvedValue([]);
      vi.mocked(findAuFiles).mockResolvedValue([]);

      const result = await validator.validate(".");

      expect(result.uncovered).toEqual([]);
    });

    it("skips empty files (0 bytes)", async () => {
      vi.mocked(fg).mockResolvedValue([
        "src/index.ts",
        "src/empty.ts",
      ]);
      vi.mocked(findAuFiles).mockResolvedValue([]);
      // First file non-empty, second file empty
      vi.mocked(stat)
        .mockResolvedValueOnce({ size: 100 } as any)
        .mockResolvedValueOnce({ size: 0 } as any);

      const result = await validator.validate(".");

      // Only the non-empty file should be uncovered
      expect(result.uncovered).toContain("src/index.ts");
      expect(result.uncovered).not.toContain("src/empty.ts");
    });
  });

  describe("validateContents", () => {
    it("finds missing items in directory .au contents", async () => {
      vi.mocked(fg).mockResolvedValue([]);
      vi.mocked(findAuFiles).mockResolvedValue(["src/.au"]);
      vi.mocked(readFile).mockResolvedValue(`
layer: service
contents:
  - index.ts
`);
      vi.mocked(readdir).mockResolvedValue([
        { name: "index.ts", isFile: () => true, isDirectory: () => false },
        { name: "utils.ts", isFile: () => true, isDirectory: () => false },
      ] as any);

      const result = await validator.validate(".");

      expect(result.contentsIssues).toHaveLength(1);
      expect(result.contentsIssues[0].path).toBe("src/.au");
      expect(result.contentsIssues[0].missing).toContain("utils.ts");
    });

    it("finds extra items in directory .au contents", async () => {
      vi.mocked(fg).mockResolvedValue([]);
      vi.mocked(findAuFiles).mockResolvedValue(["src/.au"]);
      vi.mocked(readFile).mockResolvedValue(`
layer: service
contents:
  - index.ts
  - deleted.ts
`);
      vi.mocked(readdir).mockResolvedValue([
        { name: "index.ts", isFile: () => true, isDirectory: () => false },
      ] as any);

      const result = await validator.validate(".");

      expect(result.contentsIssues).toHaveLength(1);
      expect(result.contentsIssues[0].extra).toContain("deleted.ts");
    });

    it("ignores .au files in actual directory contents", async () => {
      vi.mocked(fg).mockResolvedValue([]);
      vi.mocked(findAuFiles).mockResolvedValue(["src/.au"]);
      vi.mocked(readFile).mockResolvedValue(`
layer: service
contents:
  - index.ts
`);
      vi.mocked(readdir).mockResolvedValue([
        { name: "index.ts", isFile: () => true, isDirectory: () => false },
        { name: ".au", isFile: () => true, isDirectory: () => false },
        { name: "index.ts.au", isFile: () => true, isDirectory: () => false },
      ] as any);

      const result = await validator.validate(".");

      // No issues - .au files should be filtered out
      expect(result.contentsIssues).toHaveLength(0);
    });

    it("handles directory .au with no contents field", async () => {
      vi.mocked(fg).mockResolvedValue([]);
      vi.mocked(findAuFiles).mockResolvedValue(["src/.au"]);
      vi.mocked(readFile).mockResolvedValue(`
layer: service
understanding:
  summary: Test
`);
      vi.mocked(readdir).mockResolvedValue([
        { name: "index.ts", isFile: () => true, isDirectory: () => false },
      ] as any);

      const result = await validator.validate(".");

      // Missing contents field means all files are "missing"
      expect(result.contentsIssues).toHaveLength(1);
      expect(result.contentsIssues[0].missing).toContain("index.ts");
    });

    it("validates root .au file contents", async () => {
      vi.mocked(fg).mockResolvedValue([]);
      vi.mocked(findAuFiles).mockResolvedValue([".au"]);
      vi.mocked(readFile).mockResolvedValue(`
layer: repository
contents:
  - src
`);
      vi.mocked(readdir).mockResolvedValue([
        { name: "src", isFile: () => false, isDirectory: () => true },
        { name: "tests", isFile: () => false, isDirectory: () => true },
      ] as any);

      const result = await validator.validate(".");

      expect(result.contentsIssues).toHaveLength(1);
      expect(result.contentsIssues[0].path).toBe(".au");
      expect(result.contentsIssues[0].missing).toContain("tests");
    });

    it("returns no issues when contents matches exactly", async () => {
      vi.mocked(fg).mockResolvedValue([]);
      vi.mocked(findAuFiles).mockResolvedValue(["src/.au"]);
      vi.mocked(readFile).mockResolvedValue(`
layer: service
contents:
  - index.ts
  - utils.ts
`);
      vi.mocked(readdir).mockResolvedValue([
        { name: "index.ts", isFile: () => true, isDirectory: () => false },
        { name: "utils.ts", isFile: () => true, isDirectory: () => false },
      ] as any);

      const result = await validator.validate(".");

      expect(result.contentsIssues).toHaveLength(0);
    });
  });

  describe("findOrphans", () => {
    it("finds .au files without corresponding source", async () => {
      vi.mocked(fg).mockResolvedValue([]);
      vi.mocked(findAuFiles).mockResolvedValue([
        "src/index.ts.au",
        "src/deleted.ts.au",
      ]);
      vi.mocked(stat)
        .mockResolvedValueOnce({} as any) // src/index.ts exists
        .mockRejectedValueOnce(new Error("ENOENT")); // src/deleted.ts doesn't

      const result = await validator.validate(".");

      expect(result.orphans).toContain("src/deleted.ts.au");
      expect(result.orphans).not.toContain("src/index.ts.au");
    });

    it("finds orphaned directory .au files", async () => {
      vi.mocked(fg).mockResolvedValue([]);
      vi.mocked(findAuFiles).mockResolvedValue(["src/deleted/.au"]);
      vi.mocked(stat).mockRejectedValue(new Error("ENOENT"));

      const result = await validator.validate(".");

      expect(result.orphans).toContain("src/deleted/.au");
    });

    it("returns empty when all sources exist", async () => {
      vi.mocked(fg).mockResolvedValue([]);
      vi.mocked(findAuFiles).mockResolvedValue(["src/index.ts.au"]);
      vi.mocked(stat).mockResolvedValue({} as any);

      const result = await validator.validate(".");

      expect(result.orphans).toEqual([]);
    });
  });

  describe("findStale", () => {
    it("detects stale .au file when hash mismatches", async () => {
      vi.mocked(fg).mockResolvedValue([]);
      vi.mocked(findAuFiles).mockResolvedValue(["src/index.ts.au"]);
      vi.mocked(stat).mockResolvedValue({} as any);

      // .au file has old hash
      vi.mocked(readFile)
        .mockResolvedValueOnce(`
meta:
  analyzed_hash: oldhash123
layer: service
`)
        .mockResolvedValueOnce("new source content"); // Current source

      const result = await validator.validate(".");

      expect(result.stale).toContain("src/index.ts.au");
    });

    it("ignores fresh .au file when hash matches", async () => {
      vi.mocked(fg).mockResolvedValue([]);
      vi.mocked(findAuFiles).mockResolvedValue(["src/index.ts.au"]);
      vi.mocked(stat).mockResolvedValue({} as any);

      const sourceContent = "source content";
      // MD5 of "source content" is 654e6ae...
      const { createHash } = await import("node:crypto");
      const correctHash = createHash("md5").update(sourceContent).digest("hex");

      const auContent = `
meta:
  analyzed_hash: ${correctHash}
layer: service
`;
      // Mock readFile to return appropriate content based on path
      vi.mocked(readFile).mockImplementation(async (path) => {
        if (String(path).endsWith(".au")) return auContent;
        return sourceContent;
      });

      const result = await validator.validate(".");

      expect(result.stale).toEqual([]);
    });

    it("skips .au files without meta.analyzed_hash", async () => {
      vi.mocked(fg).mockResolvedValue([]);
      vi.mocked(findAuFiles).mockResolvedValue(["src/index.ts.au"]);
      vi.mocked(stat).mockResolvedValue({} as any);

      vi.mocked(readFile).mockResolvedValueOnce(`
layer: service
understanding:
  summary: No meta section
`);

      const result = await validator.validate(".");

      expect(result.stale).toEqual([]);
    });

    it("skips directory .au files", async () => {
      vi.mocked(fg).mockResolvedValue([]);
      vi.mocked(findAuFiles).mockResolvedValue(["src/.au", ".au"]);
      vi.mocked(stat).mockResolvedValue({} as any);
      vi.mocked(readdir).mockResolvedValue([]);
      vi.mocked(readFile).mockResolvedValue(`
meta:
  analyzed_hash: somehash
contents: []
`);

      const result = await validator.validate(".");

      // Directory .au files should not be checked for stale hashes
      expect(result.stale).toEqual([]);
    });
  });

  describe("findStaleReferences", () => {
    it("detects stale depends_on reference", async () => {
      vi.mocked(fg).mockResolvedValue([]);
      vi.mocked(findAuFiles).mockResolvedValue(["src/index.ts.au"]);
      vi.mocked(stat)
        .mockResolvedValueOnce({} as any) // src/index.ts exists (orphan check)
        .mockRejectedValueOnce(new Error("ENOENT")); // src/models/User.ts doesn't exist

      vi.mocked(readFile).mockResolvedValue(`
layer: service
relationships:
  depends_on:
    - ref: "au:src/models/User.ts"
      symbols: ["User"]
`);

      const result = await validator.validate(".");

      expect(result.staleReferences).toHaveLength(1);
      expect(result.staleReferences[0].auFile).toBe("src/index.ts.au");
      expect(result.staleReferences[0].field).toBe("depends_on");
      expect(result.staleReferences[0].ref).toBe("au:src/models/User.ts");
    });

    it("detects stale collaborates_with reference", async () => {
      vi.mocked(fg).mockResolvedValue([]);
      vi.mocked(findAuFiles).mockResolvedValue(["src/.au"]);
      vi.mocked(stat)
        .mockResolvedValueOnce({} as any) // src exists (orphan check)
        .mockRejectedValueOnce(new Error("ENOENT")); // src/deleted doesn't exist
      vi.mocked(readdir).mockResolvedValue([]);

      vi.mocked(readFile).mockResolvedValue(`
layer: module
understanding:
  collaborates_with:
    - path: "au:src/deleted"
      nature: "Data processing"
`);

      const result = await validator.validate(".");

      expect(result.staleReferences).toHaveLength(1);
      expect(result.staleReferences[0].auFile).toBe("src/.au");
      expect(result.staleReferences[0].field).toBe("collaborates_with");
      expect(result.staleReferences[0].ref).toBe("au:src/deleted");
    });

    it("ignores valid references", async () => {
      vi.mocked(fg).mockResolvedValue([]);
      vi.mocked(findAuFiles).mockResolvedValue(["src/index.ts.au"]);
      vi.mocked(stat).mockResolvedValue({} as any); // All paths exist

      vi.mocked(readFile).mockResolvedValue(`
layer: service
relationships:
  depends_on:
    - ref: "au:src/models/User.ts"
      symbols: ["User"]
`);

      const result = await validator.validate(".");

      expect(result.staleReferences).toHaveLength(0);
    });

    it("handles .au files with no references", async () => {
      vi.mocked(fg).mockResolvedValue([]);
      vi.mocked(findAuFiles).mockResolvedValue(["src/index.ts.au"]);
      vi.mocked(stat).mockResolvedValue({} as any);

      vi.mocked(readFile).mockResolvedValue(`
layer: service
understanding:
  summary: Simple file with no deps
`);

      const result = await validator.validate(".");

      expect(result.staleReferences).toHaveLength(0);
    });

    it("detects multiple stale references in one file", async () => {
      vi.mocked(fg).mockResolvedValue([]);
      vi.mocked(findAuFiles).mockResolvedValue(["src/index.ts.au"]);
      vi.mocked(stat)
        .mockResolvedValueOnce({} as any) // src/index.ts exists (orphan check)
        .mockRejectedValueOnce(new Error("ENOENT")) // first ref doesn't exist
        .mockRejectedValueOnce(new Error("ENOENT")); // second ref doesn't exist

      vi.mocked(readFile).mockResolvedValue(`
layer: service
relationships:
  depends_on:
    - ref: "au:src/deleted1.ts"
    - ref: "au:src/deleted2.ts"
`);

      const result = await validator.validate(".");

      expect(result.staleReferences).toHaveLength(2);
    });
  });

  describe("findIncomplete", () => {
    it("detects missing layer", async () => {
      vi.mocked(fg).mockResolvedValue([]);
      vi.mocked(findAuFiles).mockResolvedValue(["src/index.ts.au"]);
      vi.mocked(readFile).mockResolvedValue(`
understanding:
  summary: A test file
  purpose: Does something
`);

      const result = await validator.validate(".");

      expect(result.incompleteFiles).toHaveLength(1);
      expect(result.incompleteFiles[0].issues).toContain("missing layer");
    });

    it("detects missing summary", async () => {
      vi.mocked(fg).mockResolvedValue([]);
      vi.mocked(findAuFiles).mockResolvedValue(["src/index.ts.au"]);
      vi.mocked(readFile).mockResolvedValue(`
layer: core
understanding:
  purpose: Does something
`);

      const result = await validator.validate(".");

      expect(result.incompleteFiles).toHaveLength(1);
      expect(result.incompleteFiles[0].issues).toContain("missing summary");
    });

    it("detects missing purpose for source files", async () => {
      vi.mocked(fg).mockResolvedValue([]);
      vi.mocked(findAuFiles).mockResolvedValue(["src/index.ts.au"]);
      vi.mocked(readFile).mockResolvedValue(`
layer: core
understanding:
  summary: A test file
`);

      const result = await validator.validate(".");

      expect(result.incompleteFiles).toHaveLength(1);
      expect(result.incompleteFiles[0].issues).toContain("missing purpose");
    });

    it("does not require purpose for directory .au files", async () => {
      vi.mocked(fg).mockResolvedValue([]);
      vi.mocked(findAuFiles).mockResolvedValue(["src/.au"]);
      vi.mocked(readFile).mockResolvedValue(`
layer: core
understanding:
  summary: Source directory
  responsibility: Contains source code
contents:
  - index.ts
`);
      vi.mocked(readdir).mockResolvedValue([
        { name: "index.ts", isFile: () => true, isDirectory: () => false },
      ] as any);

      const result = await validator.validate(".");

      expect(result.incompleteFiles).toHaveLength(0);
    });

    it("detects missing responsibility for directories", async () => {
      vi.mocked(fg).mockResolvedValue([]);
      vi.mocked(findAuFiles).mockResolvedValue(["src/.au"]);
      vi.mocked(readFile).mockResolvedValue(`
layer: core
understanding:
  summary: Source directory
contents:
  - index.ts
`);
      vi.mocked(readdir).mockResolvedValue([
        { name: "index.ts", isFile: () => true, isDirectory: () => false },
      ] as any);

      const result = await validator.validate(".");

      expect(result.incompleteFiles).toHaveLength(1);
      expect(result.incompleteFiles[0].issues).toContain("missing responsibility");
    });

    it("detects missing contents for directories", async () => {
      vi.mocked(fg).mockResolvedValue([]);
      vi.mocked(findAuFiles).mockResolvedValue(["src/.au"]);
      vi.mocked(readFile).mockResolvedValue(`
layer: core
understanding:
  summary: Source directory
  responsibility: Contains code
`);
      vi.mocked(readdir).mockResolvedValue([]);

      const result = await validator.validate(".");

      expect(result.incompleteFiles).toHaveLength(1);
      expect(result.incompleteFiles[0].issues).toContain("missing contents");
    });

    it("detects missing architecture for root .au", async () => {
      vi.mocked(fg).mockResolvedValue([]);
      vi.mocked(findAuFiles).mockResolvedValue([".au"]);
      vi.mocked(readFile).mockResolvedValue(`
layer: repository
understanding:
  summary: A project
  responsibility: Contains all code
contents: []
`);
      vi.mocked(readdir).mockResolvedValue([]);

      const result = await validator.validate(".");

      expect(result.incompleteFiles).toHaveLength(1);
      expect(result.incompleteFiles[0].issues).toContain("missing architecture");
    });

    it("detects missing key_logic for service files", async () => {
      vi.mocked(fg).mockResolvedValue([]);
      vi.mocked(findAuFiles).mockResolvedValue(["src/services/auth.ts.au"]);
      vi.mocked(readFile).mockResolvedValue(`
layer: service
understanding:
  summary: Auth service
  purpose: Handles authentication
`);

      const result = await validator.validate(".");

      expect(result.incompleteFiles).toHaveLength(1);
      expect(result.incompleteFiles[0].issues).toContain("missing key_logic");
    });

    it("detects missing key_logic for util files", async () => {
      vi.mocked(fg).mockResolvedValue([]);
      vi.mocked(findAuFiles).mockResolvedValue(["src/utils/format.ts.au"]);
      vi.mocked(readFile).mockResolvedValue(`
layer: util
understanding:
  summary: Format utilities
  purpose: Formatting helpers
`);

      const result = await validator.validate(".");

      expect(result.incompleteFiles).toHaveLength(1);
      expect(result.incompleteFiles[0].issues).toContain("missing key_logic");
    });

    it("handles empty YAML file", async () => {
      vi.mocked(fg).mockResolvedValue([]);
      vi.mocked(findAuFiles).mockResolvedValue(["src/index.ts.au"]);
      vi.mocked(readFile).mockResolvedValue("");

      const result = await validator.validate(".");

      expect(result.incompleteFiles).toHaveLength(1);
      expect(result.incompleteFiles[0].issues).toContain("empty file");
    });

    it("returns no incomplete files when all have required fields", async () => {
      vi.mocked(fg).mockResolvedValue([]);
      vi.mocked(findAuFiles).mockResolvedValue(["src/index.ts.au"]);
      vi.mocked(readFile).mockResolvedValue(`
layer: core
understanding:
  summary: A test file
  purpose: Does something
`);

      const result = await validator.validate(".");

      expect(result.incompleteFiles).toHaveLength(0);
    });
  });

  describe("getIssueCount", () => {
    it("counts all issue types including incompleteFiles", () => {
      const result: ValidationResult = {
        uncovered: ["file1.ts", "file2.ts"],
        contentsIssues: [
          { path: "src/.au", missing: ["a.ts", "b.ts"], extra: ["c.ts"] },
        ],
        orphans: ["old.ts.au"],
        stale: ["outdated.ts.au"],
        staleReferences: [
          { auFile: "src/index.ts.au", field: "depends_on", ref: "au:deleted.ts" },
        ],
        incompleteFiles: [
          { path: "src/foo.ts", issues: ["missing layer"] },
        ],
      };

      expect(Validator.getIssueCount(result)).toBe(9);
      // 2 uncovered + 2 missing + 1 extra + 1 orphan + 1 stale + 1 staleRef + 1 incomplete = 9
    });

    it("returns 0 for clean result", () => {
      const result: ValidationResult = {
        uncovered: [],
        contentsIssues: [],
        orphans: [],
        stale: [],
        staleReferences: [],
        incompleteFiles: [],
      };

      expect(Validator.getIssueCount(result)).toBe(0);
    });

    it("handles empty contents issues", () => {
      const result: ValidationResult = {
        uncovered: ["file.ts"],
        contentsIssues: [],
        orphans: [],
        stale: [],
        staleReferences: [],
        incompleteFiles: [],
      };

      expect(Validator.getIssueCount(result)).toBe(1);
    });
  });
});
