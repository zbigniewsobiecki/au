import { createGadget, z } from "llmist";
import { spawn } from "node:child_process";
import { GADGET_REASON_DESCRIPTION } from "../lib/constants.js";

export const ripGrep = createGadget({
  name: "RipGrep",
  description: `Search for patterns in source files using ripgrep.
Respects gitignore. Returns matching lines with file paths and line numbers.`,
  schema: z.object({
    reason: z.string().describe(GADGET_REASON_DESCRIPTION),
    pattern: z.string().describe("Regex pattern to search for"),
    path: z.string().default(".").describe("Path to search in"),
    glob: z
      .string()
      .optional()
      .describe('Glob pattern to filter files (e.g., "*.ts")'),
    maxResults: z
      .number()
      .int()
      .default(100)
      .describe("Maximum results to return"),
  }),
  execute: async ({ reason: _reason, pattern, path, glob, maxResults }) => {
    return new Promise((resolve) => {
      const args = [
        "--color=never",
        "--line-number",
        "--no-heading",
        "-g",
        "!.sysml/**", // Exclude .sysml directory
        "-m",
        String(maxResults),
      ];

      if (glob) {
        args.push("-g", glob);
      }

      args.push(pattern, path);

      const rg = spawn("rg", args);
      let output = "";
      let errorOutput = "";

      rg.stdout.on("data", (data: Buffer) => {
        output += data.toString();
      });
      rg.stderr.on("data", (data: Buffer) => {
        errorOutput += data.toString();
      });

      rg.on("close", (code) => {
        if (code === 0 || code === 1) {
          // 1 = no matches (valid)
          resolve(output || "No matches found.");
        } else {
          resolve(`ripgrep error (code ${code}): ${errorOutput || "Unknown error"}`);
        }
      });

      rg.on("error", (error) => {
        resolve(`Failed to run ripgrep: ${error.message}. Is ripgrep installed?`);
      });
    });
  },
});
