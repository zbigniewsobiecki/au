import { createGadget, z } from "llmist";
import { readFile } from "node:fs/promises";
import { resolveAuPath } from "../lib/au-paths.js";
import { parseAuFile, stringifyForInference } from "../lib/au-yaml.js";
import { parsePathList } from "../lib/command-utils.js";

async function readSinglePath(filePath: string): Promise<string> {
  const auPath = resolveAuPath(filePath);

  try {
    const content = await readFile(auPath, "utf-8");
    const doc = parseAuFile(content);
    const stripped = stringifyForInference(doc);
    return `=== ${filePath} ===\n${stripped}`;
  } catch {
    return `=== ${filePath} ===\nNo understanding exists yet for this path.`;
  }
}

export const auRead = createGadget({
  name: "AURead",
  description: `Read the current agent understanding for one or more files/directories.
Accepts multiple paths separated by newlines. Returns combined understanding content.`,
  schema: z.object({
    paths: z
      .string()
      .describe("Path(s) to read understanding for, one per line"),
  }),
  execute: async ({ paths }) => {
    const pathList = parsePathList(paths);

    if (pathList.length === 0) {
      return "No paths provided.";
    }

    const results = await Promise.all(pathList.map(readSinglePath));
    return results.join("\n\n");
  },
});
