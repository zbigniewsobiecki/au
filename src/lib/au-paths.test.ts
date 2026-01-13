import { describe, it, expect } from "vitest";
import {
  resolveAuPath,
  getSourceFromAuPath,
  isAuFile,
  isRootAuFile,
  isDirectoryAuFile,
  isSourceFileAuFile,
} from "./au-paths.js";

describe("resolveAuPath", () => {
  describe("file paths", () => {
    it("appends .au to file with extension", () => {
      expect(resolveAuPath("src/index.ts")).toBe("src/index.ts.au");
    });

    it("handles deeply nested files", () => {
      expect(resolveAuPath("src/lib/utils/helper.ts")).toBe(
        "src/lib/utils/helper.ts.au"
      );
    });

    it("handles various extensions", () => {
      expect(resolveAuPath("README.md")).toBe("README.md.au");
      expect(resolveAuPath("package.json")).toBe("package.json.au");
      expect(resolveAuPath("styles.css")).toBe("styles.css.au");
    });
  });

  describe("directory paths", () => {
    it("creates /.au for directory without extension", () => {
      expect(resolveAuPath("src")).toBe("src/.au");
    });

    it("handles nested directories", () => {
      expect(resolveAuPath("src/lib")).toBe("src/lib/.au");
    });

    it("removes trailing slash", () => {
      expect(resolveAuPath("src/")).toBe("src/.au");
    });
  });

  describe("root path", () => {
    it("returns .au for '.'", () => {
      expect(resolveAuPath(".")).toBe(".au");
    });

    it("returns .au for empty string", () => {
      expect(resolveAuPath("")).toBe(".au");
    });

    it("returns .au for '/'", () => {
      expect(resolveAuPath("/")).toBe(".au");
    });
  });
});

describe("getSourceFromAuPath", () => {
  describe("file .au paths", () => {
    it("removes .au suffix from file", () => {
      expect(getSourceFromAuPath("src/index.ts.au")).toBe("src/index.ts");
    });

    it("handles nested paths", () => {
      expect(getSourceFromAuPath("src/lib/utils.ts.au")).toBe(
        "src/lib/utils.ts"
      );
    });
  });

  describe("directory .au paths", () => {
    it("removes /.au from directory", () => {
      expect(getSourceFromAuPath("src/.au")).toBe("src");
    });

    it("handles nested directories", () => {
      expect(getSourceFromAuPath("src/lib/.au")).toBe("src/lib");
    });
  });

  describe("root .au", () => {
    it("returns '.' for root .au file", () => {
      expect(getSourceFromAuPath(".au")).toBe(".");
    });
  });

  describe("non-.au paths", () => {
    it("returns path unchanged if not .au", () => {
      expect(getSourceFromAuPath("src/index.ts")).toBe("src/index.ts");
    });
  });

  describe("roundtrip", () => {
    it("resolveAuPath and getSourceFromAuPath are inverses for files", () => {
      const original = "src/lib/utils.ts";
      const auPath = resolveAuPath(original);
      const restored = getSourceFromAuPath(auPath);
      expect(restored).toBe(original);
    });

    it("resolveAuPath and getSourceFromAuPath are inverses for directories", () => {
      const original = "src/lib";
      const auPath = resolveAuPath(original);
      const restored = getSourceFromAuPath(auPath);
      expect(restored).toBe(original);
    });

    it("resolveAuPath and getSourceFromAuPath are inverses for root", () => {
      const original = ".";
      const auPath = resolveAuPath(original);
      const restored = getSourceFromAuPath(auPath);
      expect(restored).toBe(original);
    });
  });
});

describe("isAuFile", () => {
  it("returns true for .au files", () => {
    expect(isAuFile("src/index.ts.au")).toBe(true);
    expect(isAuFile("src/.au")).toBe(true);
    expect(isAuFile(".au")).toBe(true);
  });

  it("returns false for non-.au files", () => {
    expect(isAuFile("src/index.ts")).toBe(false);
    expect(isAuFile("README.md")).toBe(false);
    expect(isAuFile(".gitignore")).toBe(false);
  });

  it("returns false for files containing .au in the middle", () => {
    expect(isAuFile("src/.auth/config.ts")).toBe(false);
    expect(isAuFile("my.audio.mp3")).toBe(false);
  });
});

describe("isRootAuFile", () => {
  it("returns true for root .au", () => {
    expect(isRootAuFile(".au")).toBe(true);
  });

  it("returns false for other .au files", () => {
    expect(isRootAuFile("src/.au")).toBe(false);
    expect(isRootAuFile("src/index.ts.au")).toBe(false);
  });
});

describe("isDirectoryAuFile", () => {
  it("returns true for root .au", () => {
    expect(isDirectoryAuFile(".au")).toBe(true);
  });

  it("returns true for directory .au files", () => {
    expect(isDirectoryAuFile("src/.au")).toBe(true);
    expect(isDirectoryAuFile("src/lib/.au")).toBe(true);
  });

  it("returns false for source file .au files", () => {
    expect(isDirectoryAuFile("src/index.ts.au")).toBe(false);
    expect(isDirectoryAuFile("README.md.au")).toBe(false);
  });
});

describe("isSourceFileAuFile", () => {
  it("returns true for source file .au files", () => {
    expect(isSourceFileAuFile("src/index.ts.au")).toBe(true);
    expect(isSourceFileAuFile("README.md.au")).toBe(true);
    expect(isSourceFileAuFile("src/lib/utils.ts.au")).toBe(true);
  });

  it("returns false for directory .au files", () => {
    expect(isSourceFileAuFile("src/.au")).toBe(false);
    expect(isSourceFileAuFile(".au")).toBe(false);
  });

  it("returns false for non-.au files", () => {
    expect(isSourceFileAuFile("src/index.ts")).toBe(false);
  });
});
