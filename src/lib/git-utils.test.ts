import { describe, it, expect, vi, beforeEach } from "vitest";
import { filterSourceFiles, type ChangedFile } from "./git-utils.js";

// Mock child_process for async git functions
vi.mock("node:child_process", () => ({
  exec: vi.fn(),
}));

import { exec } from "node:child_process";
import {
  isGitRepo,
  detectBaseBranch,
  getChangedFiles,
  getCurrentBranch,
  hasUncommittedChanges,
  getFileDiff,
} from "./git-utils.js";

// Helper to mock exec
function mockExec(stdout: string, stderr = "") {
  vi.mocked(exec).mockImplementation((_cmd, callback) => {
    if (typeof callback === "function") {
      (callback as (error: Error | null, result: { stdout: string; stderr: string }) => void)(
        null,
        { stdout, stderr }
      );
    }
    return {} as ReturnType<typeof exec>;
  });
}

function mockExecError(error: Error) {
  vi.mocked(exec).mockImplementation((_cmd, callback) => {
    if (typeof callback === "function") {
      (callback as (error: Error | null, result: { stdout: string; stderr: string }) => void)(
        error,
        { stdout: "", stderr: "" }
      );
    }
    return {} as ReturnType<typeof exec>;
  });
}

describe("filterSourceFiles", () => {
  const testFiles: ChangedFile[] = [
    { path: "src/index.ts", status: "M" },
    { path: "src/utils.tsx", status: "A" },
    { path: "src/styles.css", status: "M" },
    { path: "package.json", status: "M" },
    { path: "src/app.js", status: "D" },
    { path: "src/component.jsx", status: "A" },
    { path: "README.md", status: "M" },
  ];

  it("filters to TypeScript files only", () => {
    const result = filterSourceFiles(testFiles, ["*.ts"]);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("src/index.ts");
  });

  it("filters to multiple patterns", () => {
    const result = filterSourceFiles(testFiles, ["*.ts", "*.tsx", "*.js", "*.jsx"]);
    expect(result).toHaveLength(4);
    expect(result.map((f) => f.path)).toEqual([
      "src/index.ts",
      "src/utils.tsx",
      "src/app.js",
      "src/component.jsx",
    ]);
  });

  it("returns empty array when no matches", () => {
    const result = filterSourceFiles(testFiles, ["*.py"]);
    expect(result).toHaveLength(0);
  });

  it("preserves status and other properties", () => {
    const result = filterSourceFiles(testFiles, ["*.ts"]);
    expect(result[0]).toEqual({ path: "src/index.ts", status: "M" });
  });

  it("handles renamed files", () => {
    const filesWithRename: ChangedFile[] = [
      { path: "src/new-name.ts", status: "R", oldPath: "src/old-name.ts" },
    ];
    const result = filterSourceFiles(filesWithRename, ["*.ts"]);
    expect(result).toHaveLength(1);
    expect(result[0].oldPath).toBe("src/old-name.ts");
  });

  it("handles empty file list", () => {
    const result = filterSourceFiles([], ["*.ts"]);
    expect(result).toHaveLength(0);
  });

  it("handles empty patterns list", () => {
    const result = filterSourceFiles(testFiles, []);
    expect(result).toHaveLength(0);
  });
});

describe("isGitRepo", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns true when in git repo", async () => {
    mockExec("true\n");
    const result = await isGitRepo();
    expect(result).toBe(true);
  });

  it("returns false when not in git repo", async () => {
    mockExecError(new Error("not a git repository"));
    const result = await isGitRepo();
    expect(result).toBe(false);
  });
});

describe("detectBaseBranch", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns branch from remote origin", async () => {
    mockExec(" develop\n");
    const result = await detectBaseBranch();
    expect(result).toBe("develop");
  });

  it("falls back to main when remote fails", async () => {
    let callCount = 0;
    vi.mocked(exec).mockImplementation((_cmd, callback) => {
      callCount++;
      const cmd = _cmd as string;
      if (typeof callback === "function") {
        if (cmd.includes("remote show")) {
          (callback as (error: Error | null, result: { stdout: string; stderr: string }) => void)(
            new Error("no remote"),
            { stdout: "", stderr: "" }
          );
        } else if (cmd.includes("verify main")) {
          (callback as (error: Error | null, result: { stdout: string; stderr: string }) => void)(
            null,
            { stdout: "main", stderr: "" }
          );
        }
      }
      return {} as ReturnType<typeof exec>;
    });
    const result = await detectBaseBranch();
    expect(result).toBe("main");
  });

  it("falls back to master when main doesn't exist", async () => {
    vi.mocked(exec).mockImplementation((_cmd, callback) => {
      const cmd = _cmd as string;
      if (typeof callback === "function") {
        if (cmd.includes("remote show")) {
          (callback as (error: Error | null, result: { stdout: string; stderr: string }) => void)(
            new Error("no remote"),
            { stdout: "", stderr: "" }
          );
        } else if (cmd.includes("verify main")) {
          (callback as (error: Error | null, result: { stdout: string; stderr: string }) => void)(
            new Error("no main"),
            { stdout: "", stderr: "" }
          );
        } else if (cmd.includes("verify master")) {
          (callback as (error: Error | null, result: { stdout: string; stderr: string }) => void)(
            null,
            { stdout: "master", stderr: "" }
          );
        }
      }
      return {} as ReturnType<typeof exec>;
    });
    const result = await detectBaseBranch();
    expect(result).toBe("master");
  });

  it("throws when neither main nor master exists", async () => {
    vi.mocked(exec).mockImplementation((_cmd, callback) => {
      if (typeof callback === "function") {
        (callback as (error: Error | null, result: { stdout: string; stderr: string }) => void)(
          new Error("branch not found"),
          { stdout: "", stderr: "" }
        );
      }
      return {} as ReturnType<typeof exec>;
    });
    await expect(detectBaseBranch()).rejects.toThrow("Could not detect base branch");
  });
});

describe("getChangedFiles", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("parses added files", async () => {
    mockExec("A\tsrc/new-file.ts\n");
    const result = await getChangedFiles("main");
    expect(result).toEqual([{ path: "src/new-file.ts", status: "A" }]);
  });

  it("parses modified files", async () => {
    mockExec("M\tsrc/index.ts\n");
    const result = await getChangedFiles("main");
    expect(result).toEqual([{ path: "src/index.ts", status: "M" }]);
  });

  it("parses deleted files", async () => {
    mockExec("D\tsrc/old-file.ts\n");
    const result = await getChangedFiles("main");
    expect(result).toEqual([{ path: "src/old-file.ts", status: "D" }]);
  });

  it("parses renamed files", async () => {
    mockExec("R100\tsrc/old-name.ts\tsrc/new-name.ts\n");
    const result = await getChangedFiles("main");
    expect(result).toEqual([
      { path: "src/new-name.ts", status: "R", oldPath: "src/old-name.ts" },
    ]);
  });

  it("parses multiple files", async () => {
    mockExec("A\tsrc/new.ts\nM\tsrc/modified.ts\nD\tsrc/deleted.ts\n");
    const result = await getChangedFiles("main");
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ path: "src/new.ts", status: "A" });
    expect(result[1]).toEqual({ path: "src/modified.ts", status: "M" });
    expect(result[2]).toEqual({ path: "src/deleted.ts", status: "D" });
  });

  it("returns empty array when no changes", async () => {
    mockExec("");
    const result = await getChangedFiles("main");
    expect(result).toEqual([]);
  });

  it("returns empty array for whitespace-only output", async () => {
    mockExec("   \n  \n");
    const result = await getChangedFiles("main");
    expect(result).toEqual([]);
  });
});

describe("getCurrentBranch", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns current branch name", async () => {
    mockExec("feature/my-branch\n");
    const result = await getCurrentBranch();
    expect(result).toBe("feature/my-branch");
  });

  it("trims whitespace", async () => {
    mockExec("  main  \n");
    const result = await getCurrentBranch();
    expect(result).toBe("main");
  });
});

describe("hasUncommittedChanges", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns true when there are changes", async () => {
    mockExec(" M src/index.ts\n");
    const result = await hasUncommittedChanges();
    expect(result).toBe(true);
  });

  it("returns false when no changes", async () => {
    mockExec("");
    const result = await hasUncommittedChanges();
    expect(result).toBe(false);
  });

  it("returns false on error", async () => {
    mockExecError(new Error("git error"));
    const result = await hasUncommittedChanges();
    expect(result).toBe(false);
  });
});

describe("getFileDiff", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns formatted diff output", async () => {
    const diffContent = `diff --git a/src/index.ts b/src/index.ts
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,4 @@
+// New comment
 export function hello() {
   return "world";
 }`;
    mockExec(diffContent);
    const result = await getFileDiff("main", "src/index.ts");
    expect(result).toContain("=== src/index.ts ===");
    expect(result).toContain("+// New comment");
  });

  it("returns (no changes) when diff is empty", async () => {
    mockExec("");
    const result = await getFileDiff("main", "src/unchanged.ts");
    expect(result).toBe("=== src/unchanged.ts ===\n(no changes)");
  });

  it("includes file path in header", async () => {
    mockExec("some diff content");
    const result = await getFileDiff("dev", "packages/frontend/src/App.tsx");
    expect(result).toContain("=== packages/frontend/src/App.tsx ===");
  });
});
