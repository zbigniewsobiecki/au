import { createGadget, z } from "llmist";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createFileFilter } from "../lib/file-filter.js";
import { parsePathList } from "../lib/command-utils.js";
import { GADGET_REASON_DESCRIPTION } from "../lib/constants.js";

export const readDirs = createGadget({
  name: "ReadDirs",
  description: `List directories recursively with file types and sizes.
Respects gitignore. Uses indentation for nesting, directories end with /.

Example:
  paths="src
apps/backend"
  depth=3`,
  schema: z.object({
    reason: z.string().describe(GADGET_REASON_DESCRIPTION),
    paths: z.string().describe("Directory paths to list, one per line"),
    depth: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(2)
      .describe("Maximum recursion depth"),
    includeGitIgnored: z
      .boolean()
      .default(false)
      .describe("Include files that match .gitignore patterns"),
  }),
  execute: async ({ reason: _reason, paths, depth, includeGitIgnored }) => {
    const filter = await createFileFilter();
    const results: string[] = [];
    const pathList = parsePathList(paths);

    const formatSize = (bytes: number): string => {
      if (bytes >= 1024 * 1024) {
        return `${(bytes / (1024 * 1024)).toFixed(1)}mb`;
      }
      if (bytes >= 1024) {
        return `${(bytes / 1024).toFixed(1)}kb`;
      }
      return String(bytes);
    };

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

          // Skip gitignored items (unless includeGitIgnored is true)
          if (!includeGitIgnored && !filter.accepts(relativePath)) continue;

          try {
            const stats = await stat(fullPath);
            const indent = "  ".repeat(currentDepth - 1);
            const name = stats.isDirectory() ? `${item}/` : item;
            const sizeStr = stats.isDirectory() ? "" : ` ${formatSize(stats.size)}`;

            entries.push(`${indent}${name}${sizeStr}`);

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
      results.push(`# ${dirPath}`);
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
