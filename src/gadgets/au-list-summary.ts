import { createGadget, z } from "llmist";
import { readFile } from "node:fs/promises";
import { getSourceFromAuPath, findAuFiles } from "../lib/au-paths.js";
import { parseAuFile } from "../lib/au-yaml.js";

/**
 * Compact listing of AU entries with just paths and summaries.
 * Suitable for planning where full content isn't needed.
 */
export const auListSummary = createGadget({
  name: "AUListSummary",
  description: `List AU entries with just paths and summaries (purpose, tags).
Use this for planning - use AURead to get full content.`,
  schema: z.object({
    path: z.string().default(".").describe("Starting path to search from"),
  }),
  execute: async ({ path }) => {
    const { files: auFiles } = await findAuFiles(path, true);
    if (auFiles.length === 0) {
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

        // Extract purpose (truncate to ~100 chars)
        const purpose = doc.purpose || doc.description;
        if (typeof purpose === "string") {
          const truncated =
            purpose.length > 100 ? purpose.slice(0, 100) + "..." : purpose;
          lines.push(`purpose: ${truncated}`);
        }

        // Extract tags
        if (Array.isArray(doc.tags) && doc.tags.length > 0) {
          lines.push(`tags: [${doc.tags.join(", ")}]`);
        }

        results.push(lines.join("\n"));
      } catch {
        const sourcePath = getSourceFromAuPath(auFile);
        results.push(`=== ${sourcePath} ===\n(error reading)`);
      }
    }

    return results.join("\n\n");
  },
});
