import { createGadget, z } from "llmist";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createFileFilter } from "../lib/file-filter.js";
import { isAuFile } from "../lib/au-paths.js";
import { parsePathList } from "../lib/command-utils.js";

export const readDirs = createGadget({
  name: "ReadDirs",
  description: `List directories recursively with file types and sizes.
Respects gitignore. Returns a compact listing with D=directory, F=file indicators.

Example:
  paths="src
apps/backend"
  depth=3`,
  schema: z.object({
    paths: z.string().describe("Directory paths to list, one per line"),
    depth: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(2)
      .describe("Maximum recursion depth"),
  }),
  execute: async ({ paths, depth }) => {
    const filter = await createFileFilter();
    const results: string[] = [];
    const pathList = parsePathList(paths);

    const listDir = async (
      dirPath: string,
      currentDepth: number,
      basePath: string
    ): Promise<string[]> => {
      const entries: string[] = [];

      try {
        const items = await readdir(dirPath);

        for (const item of items.sort()) {
          const fullPath = join(dirPath, item);
          const relativePath = basePath ? join(basePath, item) : item;

          // Skip .au files
          if (isAuFile(item)) continue;

          // Skip gitignored items
          if (!filter.accepts(relativePath)) continue;

          try {
            const stats = await stat(fullPath);
            const type = stats.isDirectory() ? "D" : "F";
            const size = stats.isDirectory() ? "" : ` ${stats.size}b`;

            entries.push(`${type}|${relativePath}${size}`);

            if (stats.isDirectory() && currentDepth < depth) {
              const subEntries = await listDir(
                fullPath,
                currentDepth + 1,
                relativePath
              );
              entries.push(...subEntries);
            }
          } catch {
            // Skip files we can't stat
          }
        }
      } catch (error) {
        entries.push(`E|${basePath || dirPath}|Error: ${error}`);
      }

      return entries;
    };

    for (const dirPath of pathList) {
      const normalizedPath = dirPath === "." ? "" : dirPath;
      results.push(`# Listing: ${dirPath}`);
      results.push("#T|Path|Size");
      const entries = await listDir(
        dirPath === "." ? "." : dirPath,
        1,
        normalizedPath
      );
      results.push(...entries);
      results.push("");
    }

    return results.join("\n");
  },
});
