import { createGadget, z } from "llmist";
import { writeFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveAuPath } from "../lib/au-paths.js";
import {
  parseAuFile,
  stringifyAuFile,
  setByPath,
  deleteByPath,
  generateMeta,
  type AuDocument,
} from "../lib/au-yaml.js";

const valueSchema = z.union([
  z.string(),
  z.object({}).passthrough(),
  z.array(z.union([z.string(), z.object({}).passthrough()])),
  z.literal(null),
]);

export const auUpdate = createGadget({
  name: "AUUpdate",
  maxConcurrent: 1,
  description: `Update agent understanding for a file or directory.

**Preferred: Full document with path="."**
AUUpdate(filePath="src/auth.ts", path=".", value={
  layer: "service",
  understanding: { summary: "...", purpose: "...", exports: [...] },
  relationships: { depends_on: [...] }
})

Field-by-field also works:
- path="layer", value="service"
- path="understanding.summary", value="..."

Meta fields are auto-managed.`,
  schema: z.object({
    filePath: z
      .string()
      .describe("Path to file/directory (relative to repo root)"),
    path: z
      .string()
      .describe("Dot-notation path (e.g., understanding.summary)"),
    value: valueSchema.describe("Value to set, or null to delete"),
  }),
  execute: async ({ filePath, path, value }) => {
    // Validate source exists and determine type (except for root)
    let isDirectory = filePath === "." || filePath === "";
    if (filePath !== "." && filePath !== "") {
      try {
        const statResult = await stat(filePath);
        isDirectory = statResult.isDirectory();
      } catch {
        return `Error: Source "${filePath}" does not exist. Cannot create understanding for non-existent paths.`;
      }
    }

    const auPath = resolveAuPath(filePath, isDirectory);

    // Read existing or start fresh
    let doc: AuDocument = {};
    let oldBytes = 0;
    let isNew = true;
    try {
      const content = await readFile(auPath, "utf-8");
      oldBytes = Buffer.byteLength(content, "utf-8");
      doc = parseAuFile(content);
      isNew = false;
    } catch {
      // New file - start with empty doc
    }

    // Apply update
    try {
      if (value === null || value === undefined) {
        doc = deleteByPath(doc, path);
      } else {
        doc = setByPath(doc, path, value);
      }
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }

    // Generate/update meta
    const type = filePath === "." || filePath === "" ? "repository" : isDirectory ? "directory" : "file";
    let sourceContent = "";
    if (type === "file") {
      try {
        sourceContent = await readFile(filePath, "utf-8");
      } catch {
        // Can't read source, use empty string for hash
      }
    }
    doc.meta = generateMeta(filePath, type, sourceContent);

    // Write YAML
    const yamlContent = stringifyAuFile(doc);
    const parentDir = dirname(auPath);
    if (parentDir && parentDir !== ".") {
      await mkdir(parentDir, { recursive: true });
    }
    await writeFile(auPath, yamlContent, "utf-8");

    const newBytes = Buffer.byteLength(yamlContent, "utf-8");
    const diff = newBytes - oldBytes;
    const marker = isNew ? "new" : "upd";

    return `Updated ${auPath} [${path}] [${marker}] [${oldBytes}→${newBytes}:${diff >= 0 ? "+" : ""}${diff}]`;
  },
});
