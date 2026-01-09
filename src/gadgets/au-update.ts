import { createGadget, z } from "llmist";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveAuPath } from "../lib/au-paths.js";

export const auUpdate = createGadget({
  name: "AUUpdate",
  description: `Create or update the agent understanding for a file or directory.
The content should be a plain-text summary of what the code does, its purpose, key exports, and relationships.
You can store understanding for individual files, directories, or the repository root.`,
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
    const auPath = resolveAuPath(filePath);

    // Ensure parent directory exists
    const parentDir = dirname(auPath);
    if (parentDir && parentDir !== ".") {
      await mkdir(parentDir, { recursive: true });
    }

    // Write the understanding
    await writeFile(auPath, content, "utf-8");

    return `Updated understanding at ${auPath}`;
  },
});
