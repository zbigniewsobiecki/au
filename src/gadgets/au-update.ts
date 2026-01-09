import { createGadget, z } from "llmist";
import { writeFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveAuPath } from "../lib/au-paths.js";

export const auUpdate = createGadget({
  name: "AUUpdate",
  description: `Create or update the agent understanding for a file or directory.
The content should be a plain-text summary of what the code does, its purpose, key exports, and relationships.
You can store understanding for individual files, directories, or the repository root.
Note: The source file or directory must exist.`,
  schema: z.object({
    filePath: z
      .string()
      .describe(
        "Path to the file or directory to document (relative to repo root)"
      ),
    content: z
      .string()
      .describe("Plain-text understanding/documentation to store"),
  }),
  execute: async ({ filePath, content }) => {
    // Validate that source file/directory exists (skip for root)
    if (filePath !== "." && filePath !== "") {
      try {
        await stat(filePath);
      } catch {
        return `Error: Source path "${filePath}" does not exist. Cannot create understanding for non-existent files.`;
      }
    }

    const auPath = resolveAuPath(filePath);

    // Get old line count if file exists
    let oldLines = 0;
    try {
      const oldContent = await readFile(auPath, "utf-8");
      oldLines = oldContent.split("\n").length;
    } catch {
      // File doesn't exist yet
    }

    // Ensure parent directory exists
    const parentDir = dirname(auPath);
    if (parentDir && parentDir !== ".") {
      await mkdir(parentDir, { recursive: true });
    }

    // Write the understanding
    await writeFile(auPath, content, "utf-8");

    const newLines = content.split("\n").length;
    const diff = newLines - oldLines;

    return `Updated understanding at ${auPath} [${oldLines}→${newLines}:${diff >= 0 ? "+" : ""}${diff}]`;
  },
});
