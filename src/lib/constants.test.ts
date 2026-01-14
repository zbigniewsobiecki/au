import { describe, it, expect } from "vitest";
import {
  GadgetName,
  AU_SEPARATOR,
  NO_EXISTING_MARKER,
  GlobPatterns,
  AU_IGNORE_PATTERNS,
  hasNoExisting,
  isFileReadingGadget,
} from "./constants.js";

describe("GadgetName", () => {
  it("contains all expected gadget names", () => {
    expect(GadgetName.ReadFiles).toBe("ReadFiles");
    expect(GadgetName.ReadDirs).toBe("ReadDirs");
    expect(GadgetName.AUUpdate).toBe("AUUpdate");
    expect(GadgetName.AURead).toBe("AURead");
    expect(GadgetName.AUList).toBe("AUList");
    expect(GadgetName.RipGrep).toBe("RipGrep");
    expect(GadgetName.Finish).toBe("Finish");
  });
});

describe("AU format constants", () => {
  it("AU_SEPARATOR is ===", () => {
    expect(AU_SEPARATOR).toBe("===");
  });

  it("NO_EXISTING_MARKER is correct", () => {
    expect(NO_EXISTING_MARKER).toBe("No existing");
  });
});

describe("GlobPatterns", () => {
  it("has AU file patterns", () => {
    expect(GlobPatterns.auFiles).toContain("**/.au");
    expect(GlobPatterns.auFiles).toContain("**/*.au");
  });

  it("has root AU file pattern", () => {
    expect(GlobPatterns.rootAuFile).toBe(".au");
  });

  it("has source file patterns", () => {
    expect(GlobPatterns.sourceFiles).toContain("**/*.ts");
    expect(GlobPatterns.sourceFiles).toContain("**/*.tsx");
    expect(GlobPatterns.sourceFiles).toContain("**/*.js");
    expect(GlobPatterns.sourceFiles).toContain("**/*.jsx");
  });

  it("has source ignore patterns for file types (not directories)", () => {
    // Directory ignores now come from .gitignore
    expect(GlobPatterns.sourceIgnore).toContain("**/*.test.ts");
    expect(GlobPatterns.sourceIgnore).toContain("**/*.spec.ts");
    expect(GlobPatterns.sourceIgnore).toContain("**/*.d.ts");
  });
});

describe("AU_IGNORE_PATTERNS", () => {
  it("includes all AU file patterns", () => {
    expect(AU_IGNORE_PATTERNS).toContain("*.au");
    expect(AU_IGNORE_PATTERNS).toContain(".au");
    expect(AU_IGNORE_PATTERNS).toContain("**/*.au");
    expect(AU_IGNORE_PATTERNS).toContain("**/.au");
  });
});

describe("hasNoExisting", () => {
  it("returns true when content contains no existing marker", () => {
    expect(hasNoExisting("No existing understanding files found")).toBe(true);
  });

  it("returns false when content has AU entries", () => {
    expect(hasNoExisting("=== src/index.ts.au ===\nlayer: core")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(hasNoExisting("")).toBe(false);
  });
});

describe("isFileReadingGadget", () => {
  it("returns true for ReadFiles", () => {
    expect(isFileReadingGadget("ReadFiles")).toBe(true);
  });

  it("returns true for ReadDirs", () => {
    expect(isFileReadingGadget("ReadDirs")).toBe(true);
  });

  it("returns false for other gadgets", () => {
    expect(isFileReadingGadget("AUUpdate")).toBe(false);
    expect(isFileReadingGadget("AURead")).toBe(false);
    expect(isFileReadingGadget("RipGrep")).toBe(false);
    expect(isFileReadingGadget("Finish")).toBe(false);
  });
});
