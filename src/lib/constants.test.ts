import { describe, it, expect } from "vitest";
import {
  GadgetName,
  GlobPatterns,
  isFileReadingGadget,
} from "./constants.js";

describe("GadgetName", () => {
  it("contains all expected gadget names", () => {
    expect(GadgetName.ReadFiles).toBe("ReadFiles");
    expect(GadgetName.ReadDirs).toBe("ReadDirs");
    expect(GadgetName.RipGrep).toBe("RipGrep");
    expect(GadgetName.Finish).toBe("Finish");
    expect(GadgetName.SysMLWrite).toBe("SysMLWrite");
    expect(GadgetName.SysMLRead).toBe("SysMLRead");
    expect(GadgetName.SysMLList).toBe("SysMLList");
    expect(GadgetName.SysMLQuery).toBe("SysMLQuery");
  });
});

describe("GlobPatterns", () => {
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

describe("isFileReadingGadget", () => {
  it("returns true for ReadFiles", () => {
    expect(isFileReadingGadget("ReadFiles")).toBe(true);
  });

  it("returns true for ReadDirs", () => {
    expect(isFileReadingGadget("ReadDirs")).toBe(true);
  });

  it("returns false for other gadgets", () => {
    expect(isFileReadingGadget("SysMLWrite")).toBe(false);
    expect(isFileReadingGadget("SysMLRead")).toBe(false);
    expect(isFileReadingGadget("RipGrep")).toBe(false);
    expect(isFileReadingGadget("Finish")).toBe(false);
  });
});
