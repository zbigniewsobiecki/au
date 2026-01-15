import { createGadget, z } from "llmist";
import { readFile } from "node:fs/promises";
import { getSourceFromAuPath, findAuFiles } from "../lib/au-paths.js";
import { parseAuFile, stringifyForInference } from "../lib/au-yaml.js";

export const auList = createGadget({
  name: "AUList",
  description: `List existing agent understanding entries with their contents.
This shows what understandings already exist so you can refine them.`,
  schema: z.object({
    path: z.string().default(".").describe("Starting path to search from"),
    maxDepth: z
      .number()
      .min(1)
      .max(10)
      .default(2)
      .describe("Maximum directory depth to search"),
  }),
  execute: async ({ path, maxDepth }) => {
    // Find all .au files up to maxDepth
    const { files: auFiles, truncatedPaths } = await findAuFiles(
      path,
      true,
      maxDepth
    );

    if (auFiles.length === 0 && truncatedPaths.length === 0) {
      return "No existing understanding entries found.";
    }

    const results: string[] = [];
    for (const auFile of auFiles.sort()) {
      try {
        const fullPath = path === "." ? auFile : `${path}/${auFile}`;
        const content = await readFile(fullPath, "utf-8");
        const doc = parseAuFile(content);
        const stripped = stringifyForInference(doc);
        const sourcePath = getSourceFromAuPath(auFile);
        results.push(`=== ${sourcePath} ===\n${stripped}`);
      } catch (error) {
        const sourcePath = getSourceFromAuPath(auFile);
        results.push(`=== ${sourcePath} ===\nError reading understanding`);
      }
    }

    // Add truncation notice if there are deeper levels
    if (truncatedPaths.length > 0) {
      const pathsList = truncatedPaths.map((p) => `  ${p}/...`).join("\n");
      results.push(
        `--- Deeper levels exist (use path parameter to explore) ---\n${pathsList}`
      );
    }

    return results.join("\n\n");
  },
});
