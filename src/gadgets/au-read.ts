import { createGadget, z } from "llmist";
import { readFile } from "node:fs/promises";
import { resolveAuPath } from "../lib/au-paths.js";
import { parseAuFile, stringifyForInference } from "../lib/au-yaml.js";

export const auRead = createGadget({
  name: "AURead",
  description: `Read the current agent understanding for a file or directory.
Returns the existing understanding content, or indicates if no understanding exists yet.`,
  schema: z.object({
    filePath: z
      .string()
      .describe("Path to the file or directory to read understanding for"),
  }),
  execute: async ({ filePath }) => {
    const auPath = resolveAuPath(filePath);

    try {
      const content = await readFile(auPath, "utf-8");
      const doc = parseAuFile(content);
      const stripped = stringifyForInference(doc);
      return `path=${filePath}\n\n${stripped}`;
    } catch {
      return `path=${filePath}\n\nNo understanding exists yet for this path.`;
    }
  },
});
