import { describe, it, expect } from "vitest";
import {
  countAuLines,
  formatResultSize,
  createTextBlockState,
  parsePathList,
} from "./command-utils.js";

describe("countAuLines", () => {
  it("counts lines excluding separators", () => {
    const content = `=== src/index.ts.au ===
layer: core
understanding:
  summary: A test file
=== src/lib/utils.ts.au ===
layer: util`;
    // 4 non-separator lines
    expect(countAuLines(content)).toBe(4);
  });

  it("returns 0 for empty content", () => {
    expect(countAuLines("")).toBe(1); // Empty string splits to [""]
  });

  it("counts all lines when no separators", () => {
    const content = `line1
line2
line3`;
    expect(countAuLines(content)).toBe(3);
  });
});

describe("formatResultSize", () => {
  it("formats bytes to kb", () => {
    expect(formatResultSize("a".repeat(1024))).toBe("1.0kb");
    expect(formatResultSize("a".repeat(2048))).toBe("2.0kb");
    expect(formatResultSize("a".repeat(512))).toBe("0.5kb");
  });

  it("handles undefined", () => {
    expect(formatResultSize(undefined)).toBe("0.0kb");
  });

  it("handles empty string", () => {
    expect(formatResultSize("")).toBe("0.0kb");
  });
});

describe("createTextBlockState", () => {
  it("creates state with inTextBlock set to false", () => {
    const state = createTextBlockState();
    expect(state.inTextBlock).toBe(false);
  });

  it("state is mutable", () => {
    const state = createTextBlockState();
    state.inTextBlock = true;
    expect(state.inTextBlock).toBe(true);
  });
});

describe("parsePathList", () => {
  it("splits by newlines", () => {
    const result = parsePathList("src/a.ts\nsrc/b.ts\nsrc/c.ts");
    expect(result).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  it("trims whitespace", () => {
    const result = parsePathList("  src/a.ts  \n  src/b.ts  ");
    expect(result).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("filters empty lines", () => {
    const result = parsePathList("src/a.ts\n\n\nsrc/b.ts\n");
    expect(result).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("returns empty array for empty string", () => {
    expect(parsePathList("")).toEqual([]);
  });

  it("returns empty array for whitespace only", () => {
    expect(parsePathList("   \n   \n   ")).toEqual([]);
  });

  it("handles single path", () => {
    expect(parsePathList("src/index.ts")).toEqual(["src/index.ts"]);
  });
});
