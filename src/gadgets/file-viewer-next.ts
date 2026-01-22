import { createGadget, z } from "llmist";
import { parsePathList } from "../lib/command-utils.js";

export const fileViewerNextFileSet = createGadget({
  name: "FileViewerNextFileSet",
  description: `Select the next batch of files to view in the file viewer.
Call EXACTLY ONCE per turn.
Pass file paths as a newline-separated string.
Pass an empty string when all documentation is complete.

Example:
  paths="src/index.ts
src/lib/utils.ts
package.json"
  paths=""  // Done - no more files to view`,
  schema: z.object({
    paths: z.string().default("").describe("File paths to view next, one per line. Empty string when done."),
  }),
  execute: async ({ paths }) => {
    const pathList = parsePathList(paths);
    if (pathList.length === 0) {
      return "DONE: No more files requested.";
    }
    return `Selected ${pathList.length} files: ${pathList.join(", ")}`;
  },
});
