import { createGadget, z } from "llmist";
import { readFile } from "node:fs/promises";
import { createFileFilter } from "../lib/file-filter.js";
import { parsePathList } from "../lib/command-utils.js";
import { GADGET_REASON_DESCRIPTION } from "../lib/constants.js";

export const readFiles = createGadget({
  name: "ReadFiles",
  description: `Read the contents of multiple source files at once.
Respects gitignore. Returns the content of each file with its path.

Example:
  paths="src/app.ts
src/lib/utils.ts
src/config.ts"`,
  schema: z.object({
    reason: z.string().describe(GADGET_REASON_DESCRIPTION),
    paths: z.string().describe("File paths to read, one per line"),
  }),
  execute: async ({ reason: _reason, paths }) => {
    const filter = await createFileFilter();
    const results: string[] = [];
    const pathList = parsePathList(paths);

    for (const filePath of pathList) {
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
