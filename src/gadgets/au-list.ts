import { createGadget, z } from "llmist";
import { readFile } from "node:fs/promises";
import fg from "fast-glob";
import { getSourceFromAuPath } from "../lib/au-paths.js";

export const auList = createGadget({
  name: "AUList",
  description: `List all existing agent understanding entries recursively, with their contents.
This shows what understandings already exist so you can refine them.`,
  schema: z.object({
    path: z.string().default(".").describe("Starting path to search from"),
  }),
  execute: async ({ path }) => {
    // Find all .au files
    const auFiles = await fg(["**/.au", "**/*.au", ".au"], {
      cwd: path,
      ignore: ["node_modules/**"],
      absolute: false,
      dot: true,
    });

    if (auFiles.length === 0) {
      return "No existing understanding entries found.";
    }

    const results: string[] = [];
    for (const auFile of auFiles.sort()) {
      try {
        const fullPath = path === "." ? auFile : `${path}/${auFile}`;
        const content = await readFile(fullPath, "utf-8");
        const sourcePath = getSourceFromAuPath(auFile);
        results.push(`=== ${sourcePath} ===\n${content}`);
      } catch (error) {
        const sourcePath = getSourceFromAuPath(auFile);
        results.push(`=== ${sourcePath} ===\nError reading understanding`);
      }
    }

    return results.join("\n\n");
  },
});
