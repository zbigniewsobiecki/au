import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const ignore = require("ignore") as typeof import("ignore").default;

export interface FileFilter {
  accepts(path: string): boolean;
}

/**
 * Creates a filter that respects .gitignore and excludes .au files.
 */
export async function createFileFilter(rootPath = "."): Promise<FileFilter> {
  const ig = ignore();

  // Always ignore .au files (these are documentation, not source)
  ig.add(["*.au", ".au", "**/*.au", "**/.au"]);

  // Try to load .gitignore
  try {
    const gitignorePath = join(rootPath, ".gitignore");
    const gitignoreContent = await readFile(gitignorePath, "utf-8");
    ig.add(gitignoreContent);
  } catch {
    // No .gitignore file, that's fine
  }

  return {
    accepts(path: string): boolean {
      // Normalize path to be relative
      let relativePath = path;
      if (relativePath.startsWith("./")) {
        relativePath = relativePath.slice(2);
      }
      if (relativePath.startsWith("/")) {
        relativePath = relativePath.slice(1);
      }

      // Empty path is root, always accept
      if (!relativePath || relativePath === ".") {
        return true;
      }

      // Check both with and without trailing slash
      // This handles gitignore patterns like "node_modules/" which only match
      // the directory contents unless we also check with trailing slash
      if (ig.ignores(relativePath)) {
        return false;
      }
      // Also check as directory (with trailing slash)
      if (ig.ignores(relativePath + "/")) {
        return false;
      }
      return true;
    },
  };
}

