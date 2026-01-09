import { createGadget, z } from "llmist";
import { readFile } from "node:fs/promises";
import { createFileFilter } from "../lib/file-filter.js";
import { isAuFile } from "../lib/au-paths.js";

export const readFiles = createGadget({
  name: "ReadFiles",
  description: `Read the contents of multiple source files at once.
Respects gitignore. Returns the content of each file with its path.`,
  schema: z.object({
    paths: z.array(z.string()).describe("Array of file paths to read"),
  }),
  execute: async ({ paths }) => {
    const filter = await createFileFilter();
    const results: string[] = [];

    for (const filePath of paths) {
      // Filter out .au files
      if (isAuFile(filePath)) {
        continue;
      }

      // Filter out gitignored files
      if (!filter.accepts(filePath)) {
        continue;
      }

      try {
        const content = await readFile(filePath, "utf-8");
        results.push(`=== ${filePath} ===\n${content}`);
      } catch (error) {
        results.push(`=== ${filePath} ===\nError reading file: ${error}`);
      }
    }

    if (results.length === 0) {
      return "No valid files to read (all filtered out or do not exist).";
    }

    return results.join("\n\n");
  },
});
