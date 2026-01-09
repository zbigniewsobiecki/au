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

  // Always ignore .au files
  ig.add(["*.au", ".au", "**/*.au", "**/.au"]);

  // Always ignore common non-source directories
  ig.add(["node_modules", ".git", "dist", "build", ".next", ".cache"]);

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

      return !ig.ignores(relativePath);
    },
  };
}

/**
 * Creates a synchronous filter with pre-loaded gitignore.
 * Use createFileFilter() for async initialization.
 */
export function createSyncFileFilter(gitignoreContent?: string): FileFilter {
  const ig = ignore();

  // Always ignore .au files
  ig.add(["*.au", ".au", "**/*.au", "**/.au"]);

  // Always ignore common non-source directories
  ig.add(["node_modules", ".git", "dist", "build", ".next", ".cache"]);

  if (gitignoreContent) {
    ig.add(gitignoreContent);
  }

  return {
    accepts(path: string): boolean {
      let relativePath = path;
      if (relativePath.startsWith("./")) {
        relativePath = relativePath.slice(2);
      }
      if (relativePath.startsWith("/")) {
        relativePath = relativePath.slice(1);
      }
      if (!relativePath || relativePath === ".") {
        return true;
      }
      return !ig.ignores(relativePath);
    },
  };
}
