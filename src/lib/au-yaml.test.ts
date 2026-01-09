import { describe, it, expect } from "vitest";
import {
  parsePath,
  setByPath,
  deleteByPath,
  generateMeta,
  detectType,
  parseAuFile,
  stringifyAuFile,
  AuDocument,
} from "./au-yaml.js";

describe("parsePath", () => {
  it("returns empty array for empty string", () => {
    expect(parsePath("")).toEqual([]);
  });

  it("returns empty array for root path '.'", () => {
    expect(parsePath(".")).toEqual([]);
  });

  it("parses single segment", () => {
    expect(parsePath("understanding")).toEqual(["understanding"]);
  });

  it("parses multiple segments", () => {
    expect(parsePath("understanding.exports.0")).toEqual([
      "understanding",
      "exports",
      "0",
    ]);
  });

  it("handles deeply nested paths", () => {
    expect(parsePath("a.b.c.d.e")).toEqual(["a", "b", "c", "d", "e"]);
  });
});

describe("setByPath", () => {
  describe("basic operations", () => {
    it("sets value at root level", () => {
      const doc: AuDocument = {};
      const result = setByPath(doc, "name", "test");
      expect(result.name).toBe("test");
    });

    it("sets nested value creating intermediate objects", () => {
      const doc: AuDocument = {};
      const result = setByPath(doc, "understanding.summary", "A test file");
      expect(result.understanding).toEqual({ summary: "A test file" });
    });

    it("preserves existing values", () => {
      const doc: AuDocument = { existing: "value" };
      const result = setByPath(doc, "new", "data");
      expect(result.existing).toBe("value");
      expect(result.new).toBe("data");
    });

    it("is immutable - does not modify original", () => {
      const doc: AuDocument = { original: true };
      const result = setByPath(doc, "added", true);
      expect(doc).toEqual({ original: true });
      expect(result).toEqual({ original: true, added: true });
    });
  });

  describe("root replacement", () => {
    it("replaces root with new object", () => {
      const doc: AuDocument = { old: "value" };
      const result = setByPath(doc, "", { new: "value" });
      expect(result).toEqual({ new: "value" });
    });

    it("preserves meta when replacing root", () => {
      const doc: AuDocument = {
        meta: {
          au: "1.0",
          id: "au:test",
          type: "file",
          analyzed_at: "2024-01-01",
          analyzed_hash: "abc123",
        },
        old: "value",
      };
      const result = setByPath(doc, "", { new: "value" });
      expect(result.meta).toEqual(doc.meta);
      expect(result.new).toBe("value");
      expect(result.old).toBeUndefined();
    });

    it("throws when replacing root with non-object", () => {
      const doc: AuDocument = {};
      expect(() => setByPath(doc, "", "string")).toThrow(
        "Root value must be an object"
      );
    });

    it("throws when replacing root with null", () => {
      const doc: AuDocument = {};
      expect(() => setByPath(doc, "", null)).toThrow(
        "Root value must be an object"
      );
    });
  });

  describe("meta protection", () => {
    it("throws when trying to set meta directly", () => {
      const doc: AuDocument = {};
      expect(() => setByPath(doc, "meta", { au: "1.0" })).toThrow(
        "Meta fields are auto-managed"
      );
    });

    it("throws when trying to set nested meta field", () => {
      const doc: AuDocument = {};
      expect(() => setByPath(doc, "meta.au", "2.0")).toThrow(
        "Meta fields are auto-managed"
      );
    });
  });

  describe("array operations", () => {
    it("creates array when next segment is index", () => {
      const doc: AuDocument = {};
      const result = setByPath(doc, "exports.0", { name: "foo" });
      expect(Array.isArray(result.exports)).toBe(true);
      expect(result.exports).toEqual([{ name: "foo" }]);
    });

    it("sets value at existing array index", () => {
      const doc: AuDocument = { items: ["a", "b", "c"] };
      const result = setByPath(doc, "items.1", "B");
      expect(result.items).toEqual(["a", "B", "c"]);
    });

    it("appends to array when index exceeds length", () => {
      const doc: AuDocument = { items: ["a", "b"] };
      const result = setByPath(doc, "items.10", "c");
      expect(result.items).toEqual(["a", "b", "c"]);
    });

    it("handles nested arrays", () => {
      const doc: AuDocument = {};
      const result = setByPath(doc, "matrix.0.0", 1);
      expect(result.matrix).toEqual([[1]]);
    });
  });

  describe("JSON string auto-parsing", () => {
    it("parses JSON object strings", () => {
      const doc: AuDocument = {};
      const result = setByPath(doc, "data", '{"name": "test", "value": 42}');
      expect(result.data).toEqual({ name: "test", value: 42 });
    });

    it("parses JSON array strings", () => {
      const doc: AuDocument = {};
      const result = setByPath(doc, "items", '["a", "b", "c"]');
      expect(result.items).toEqual(["a", "b", "c"]);
    });

    it("parses YAML object strings", () => {
      const doc: AuDocument = {};
      const result = setByPath(doc, "data", "name: test\nvalue: 42");
      expect(result.data).toEqual({ name: "test", value: 42 });
    });

    it("parses single-line YAML", () => {
      const doc: AuDocument = {};
      const result = setByPath(doc, "data", "key: value");
      expect(result.data).toEqual({ key: "value" });
    });

    it("does not parse URLs as YAML", () => {
      const doc: AuDocument = {};
      const result = setByPath(doc, "url", "https://example.com");
      expect(result.url).toBe("https://example.com");
    });

    it("leaves non-JSON/YAML strings as-is", () => {
      const doc: AuDocument = {};
      const result = setByPath(doc, "text", "just a plain string");
      expect(result.text).toBe("just a plain string");
    });

    it("leaves numbers as-is", () => {
      const doc: AuDocument = {};
      const result = setByPath(doc, "count", 42);
      expect(result.count).toBe(42);
    });

    it("leaves booleans as-is", () => {
      const doc: AuDocument = {};
      const result = setByPath(doc, "active", true);
      expect(result.active).toBe(true);
    });
  });

  describe("error handling", () => {
    it("throws when traversing into non-object", () => {
      const doc: AuDocument = { name: "string" };
      expect(() => setByPath(doc, "name.nested", "value")).toThrow(
        "Cannot traverse into non-object"
      );
    });
  });
});

describe("deleteByPath", () => {
  describe("basic operations", () => {
    it("deletes key at root level", () => {
      const doc: AuDocument = { name: "test", other: "value" };
      const result = deleteByPath(doc, "name");
      expect(result.name).toBeUndefined();
      expect(result.other).toBe("value");
    });

    it("deletes nested key", () => {
      const doc: AuDocument = {
        understanding: { summary: "test", purpose: "do stuff" },
      };
      const result = deleteByPath(doc, "understanding.summary");
      expect(result.understanding).toEqual({ purpose: "do stuff" });
    });

    it("is immutable - does not modify original", () => {
      const doc: AuDocument = { toDelete: true };
      const result = deleteByPath(doc, "toDelete");
      expect(doc.toDelete).toBe(true);
      expect(result.toDelete).toBeUndefined();
    });

    it("returns unchanged doc when path does not exist", () => {
      const doc: AuDocument = { existing: "value" };
      const result = deleteByPath(doc, "nonexistent");
      expect(result).toEqual({ existing: "value" });
    });

    it("returns unchanged doc when nested path does not exist", () => {
      const doc: AuDocument = { existing: "value" };
      const result = deleteByPath(doc, "a.b.c");
      expect(result).toEqual({ existing: "value" });
    });
  });

  describe("meta protection", () => {
    it("throws when trying to delete meta", () => {
      const doc: AuDocument = { meta: { au: "1.0" } as any };
      expect(() => deleteByPath(doc, "meta")).toThrow(
        "Meta fields are auto-managed"
      );
    });

    it("throws when trying to delete nested meta field", () => {
      const doc: AuDocument = {};
      expect(() => deleteByPath(doc, "meta.au")).toThrow(
        "Meta fields are auto-managed"
      );
    });
  });

  describe("root protection", () => {
    it("throws when trying to delete root", () => {
      const doc: AuDocument = { test: "value" };
      expect(() => deleteByPath(doc, "")).toThrow("Cannot delete root");
    });
  });

  describe("array operations", () => {
    it("removes array element by index", () => {
      const doc: AuDocument = { items: ["a", "b", "c"] };
      const result = deleteByPath(doc, "items.1");
      expect(result.items).toEqual(["a", "c"]);
    });

    it("handles out of bounds index gracefully", () => {
      const doc: AuDocument = { items: ["a", "b"] };
      const result = deleteByPath(doc, "items.10");
      expect(result.items).toEqual(["a", "b"]);
    });
  });
});

describe("generateMeta", () => {
  it("generates meta for repository root", () => {
    const meta = generateMeta(".", "repository", "source content");
    expect(meta.au).toBe("1.0");
    expect(meta.id).toBe("au:");
    expect(meta.type).toBe("repository");
    expect(meta.analyzed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(meta.analyzed_hash).toMatch(/^[a-f0-9]{32}$/);
  });

  it("generates meta for empty path as repository", () => {
    const meta = generateMeta("", "repository", "source content");
    expect(meta.id).toBe("au:");
  });

  it("generates meta for file", () => {
    const meta = generateMeta("src/index.ts", "file", "source content");
    expect(meta.id).toBe("au:src/index.ts");
    expect(meta.type).toBe("file");
  });

  it("generates meta for directory", () => {
    const meta = generateMeta("src/lib", "directory", "source content");
    expect(meta.id).toBe("au:src/lib");
    expect(meta.type).toBe("directory");
  });

  it("generates different hashes for different content", () => {
    const meta1 = generateMeta("file.ts", "file", "content A");
    const meta2 = generateMeta("file.ts", "file", "content B");
    expect(meta1.analyzed_hash).not.toBe(meta2.analyzed_hash);
  });

  it("generates same hash for same content", () => {
    const meta1 = generateMeta("file.ts", "file", "same content");
    const meta2 = generateMeta("file.ts", "file", "same content");
    expect(meta1.analyzed_hash).toBe(meta2.analyzed_hash);
  });
});

describe("detectType", () => {
  it("returns repository for '.'", () => {
    expect(detectType(".")).toBe("repository");
  });

  it("returns repository for empty string", () => {
    expect(detectType("")).toBe("repository");
  });

  it("returns file for paths with extensions", () => {
    expect(detectType("src/index.ts")).toBe("file");
    expect(detectType("README.md")).toBe("file");
    expect(detectType("package.json")).toBe("file");
    expect(detectType("src/components/Button.tsx")).toBe("file");
  });

  it("returns directory for paths without extensions", () => {
    expect(detectType("src")).toBe("directory");
    expect(detectType("src/lib")).toBe("directory");
    expect(detectType("components")).toBe("directory");
  });

  it("handles dotfiles as directories", () => {
    expect(detectType(".git")).toBe("directory");
    expect(detectType(".vscode")).toBe("directory");
  });
});

describe("parseAuFile", () => {
  it("parses valid YAML", () => {
    const content = `
meta:
  au: "1.0"
  id: "au:test"
layer: core
understanding:
  summary: "Test file"
`;
    const doc = parseAuFile(content);
    expect(doc.layer).toBe("core");
    expect(doc.understanding).toEqual({ summary: "Test file" });
  });

  it("returns empty object for empty content", () => {
    const doc = parseAuFile("");
    expect(doc).toEqual({});
  });

  it("returns empty object for null YAML", () => {
    const doc = parseAuFile("null");
    expect(doc).toEqual({});
  });

  it("handles arrays at root", () => {
    const content = `
- item1
- item2
`;
    // This returns the array, which isn't an AuDocument but parseAuFile handles it
    const doc = parseAuFile(content);
    // Arrays aren't valid AuDocuments, but the function returns whatever YAML gives
    expect(Array.isArray(doc)).toBe(true);
  });
});

describe("stringifyAuFile", () => {
  it("produces valid YAML", () => {
    const doc: AuDocument = {
      layer: "core",
      understanding: { summary: "Test" },
    };
    const yaml = stringifyAuFile(doc);
    expect(yaml).toContain("layer:");
    expect(yaml).toContain("understanding:");
    expect(yaml).toContain("summary:");
  });

  it("roundtrips correctly", () => {
    const doc: AuDocument = {
      layer: "core",
      understanding: {
        summary: "A test file",
        exports: [{ name: "foo", kind: "function" }],
      },
    };
    const yaml = stringifyAuFile(doc);
    const parsed = parseAuFile(yaml);
    expect(parsed.layer).toBe("core");
    expect(parsed.understanding).toEqual(doc.understanding);
  });

  it("uses double quotes for strings", () => {
    const doc: AuDocument = { name: "test value" };
    const yaml = stringifyAuFile(doc);
    expect(yaml).toContain('"test value"');
  });
});
