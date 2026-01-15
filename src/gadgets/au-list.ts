import { createGadget, z } from "llmist";
import { readFile } from "node:fs/promises";
import { getSourceFromAuPath, findAuFiles } from "../lib/au-paths.js";
import { parseAuFile } from "../lib/au-yaml.js";

export const auList = createGadget({
  name: "AUList",
  description: `List AU entries with paths, layers, and summaries.
Use this to see what exists - use AURead to get full content.`,
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
    const { files: auFiles, truncatedPaths } = await findAuFiles(
      path,
      true,
      maxDepth
    );

    if (auFiles.length === 0 && truncatedPaths.length === 0) {
      return "No AU entries found.";
    }

    const results: string[] = [];
    for (const auFile of auFiles.sort()) {
      try {
        const fullPath = path === "." ? auFile : `${path}/${auFile}`;
        const content = await readFile(fullPath, "utf-8");
        const doc = parseAuFile(content);
        const sourcePath = getSourceFromAuPath(auFile);

        const lines: string[] = [`=== ${sourcePath} ===`];

        if (doc.layer) {
          lines.push(`layer: ${doc.layer}`);
        }

        const understanding = doc.understanding as
          | { summary?: string }
          | undefined;
        const summary = understanding?.summary;
        if (summary) {
          const truncated =
            summary.length > 120 ? summary.slice(0, 120) + "..." : summary;
          lines.push(`summary: ${truncated}`);
        }

        results.push(lines.join("\n"));
      } catch {
        const sourcePath = getSourceFromAuPath(auFile);
        results.push(`=== ${sourcePath} ===\n(error reading)`);
      }
    }

    if (truncatedPaths.length > 0) {
      results.push(
        `--- Deeper levels (use path param) ---\n${truncatedPaths.map((p) => p + "/...").join("\n")}`
      );
    }

    return results.join("\n\n");
  },
});
