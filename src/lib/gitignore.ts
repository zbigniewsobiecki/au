import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const ignore = require("ignore") as typeof import("ignore").default;

export type IgnoreMatcher = ReturnType<typeof ignore>;

/**
 * Loads gitignore patterns from a directory.
 * Returns an IgnoreMatcher that can be used to check if paths should be ignored.
 * Always succeeds - returns empty matcher if no .gitignore exists.
 */
export async function loadGitignore(basePath: string = "."): Promise<IgnoreMatcher> {
  const ig = ignore();
  try {
    const gitignorePath = join(basePath, ".gitignore");
    const content = await readFile(gitignorePath, "utf-8");
    ig.add(content);
  } catch {
    // No .gitignore file, return empty matcher
  }
  return ig;
}
