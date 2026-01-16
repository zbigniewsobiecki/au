import { join, extname } from "node:path";
import fg from "fast-glob";
import { loadGitignore } from "./gitignore.js";

/**
 * Resolves the .au file path for a given source path.
 *
 * Rules:
 * - File /foo/bar/baz.ts -> /foo/bar/baz.ts.au (append .au)
 * - Directory /foo/bar -> /foo/bar/.au
 * - Root . -> .au
 *
 * @param sourcePath - The source file or directory path
 * @param isDirectory - If known, whether the source is a directory (avoids heuristics)
 */
export function resolveAuPath(sourcePath: string, isDirectory?: boolean): string {
  // Normalize path
  const normalized = sourcePath.replace(/\/$/, "") || ".";

  if (normalized === ".") {
    return ".au";
  }

  // Use explicit isDirectory if provided, otherwise use heuristics
  if (isDirectory !== undefined) {
    return isDirectory ? join(normalized, ".au") : `${normalized}.au`;
  }

  // Heuristic: Check if it's a file (has extension) or directory
  const ext = extname(normalized);

  if (ext && ext !== ".") {
    // It's a file: /foo/bar/baz.ts -> /foo/bar/baz.ts.au
    return `${normalized}.au`;
  } else {
    // It's a directory: /foo/bar -> /foo/bar/.au
    return join(normalized, ".au");
  }
}

/**
 * Gets the source path from an .au file path.
 * Inverse of resolveAuPath.
 */
export function getSourceFromAuPath(auPath: string): string {
  if (auPath === ".au") {
    return ".";
  }

  if (auPath.endsWith("/.au")) {
    // Directory .au file: src/.au -> src
    return auPath.slice(0, -4);
  }

  if (auPath.endsWith(".au")) {
    // File .au: src/index.ts.au -> src/index.ts
    return auPath.slice(0, -3);
  }

  return auPath;
}

/**
 * Checks if a path is an .au file.
 */
export function isAuFile(path: string): boolean {
  return path.endsWith(".au") || path === ".au";
}

/**
 * Checks if an .au path is the root .au file.
 */
export function isRootAuFile(path: string): boolean {
  return path === ".au";
}

/**
 * Checks if an .au path is a directory .au file (including root).
 */
export function isDirectoryAuFile(path: string): boolean {
  return path.endsWith("/.au") || path === ".au";
}

/**
 * Checks if an .au path is a source file .au (not directory or root).
 */
export function isSourceFileAuFile(path: string): boolean {
  return isAuFile(path) && !isDirectoryAuFile(path);
}

export interface FindAuFilesResult {
  files: string[];
  truncatedPaths: string[];
}

/**
 * Find all .au files in a directory.
 * Respects .gitignore patterns from the repository.
 * @param basePath The directory to search from
 * @param includeRoot Whether to include root .au file in the pattern
 * @param maxDepth Maximum directory depth to search (undefined = unlimited)
 */
export async function findAuFiles(
  basePath: string = ".",
  includeRoot: boolean = true,
  maxDepth?: number
): Promise<FindAuFilesResult> {
  const patterns = includeRoot
    ? ["**/.au", "**/*.au", ".au"]
    : ["**/.au", "**/*.au"];

  // Get all .au files up to maxDepth
  const files = await fg(patterns, {
    cwd: basePath,
    absolute: false,
    dot: true,
    deep: maxDepth,
  });

  // Load .gitignore patterns
  const ig = await loadGitignore(basePath);

  // Filter out files in gitignored directories
  const filteredFiles = files.filter((file) => {
    const parts = file.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const pathToCheck = parts.slice(0, i).join("/");
      if (ig.ignores(pathToCheck)) {
        return false;
      }
    }
    return true;
  });

  // Find truncated paths (directories with deeper .au files)
  let truncatedPaths: string[] = [];
  if (maxDepth !== undefined) {
    // Search one level deeper to find what's beyond maxDepth
    const deeperFiles = await fg(patterns, {
      cwd: basePath,
      absolute: false,
      dot: true,
      deep: maxDepth + 1,
    });

    // Filter by gitignore
    const filteredDeeperFiles = deeperFiles.filter((file) => {
      const parts = file.split("/");
      for (let i = 1; i <= parts.length; i++) {
        const pathToCheck = parts.slice(0, i).join("/");
        if (ig.ignores(pathToCheck)) {
          return false;
        }
      }
      return true;
    });

    // Find files that are exactly at maxDepth+1
    const filesAtCutoff = filteredDeeperFiles.filter((file) => {
      const depth = file.split("/").length;
      return depth > maxDepth;
    });

    // Extract unique parent directories at the cutoff depth
    const truncatedSet = new Set<string>();
    for (const file of filesAtCutoff) {
      const parts = file.split("/");
      // Get path up to maxDepth level
      const truncatedPath = parts.slice(0, maxDepth).join("/");
      if (truncatedPath) {
        truncatedSet.add(truncatedPath);
      }
    }
    truncatedPaths = Array.from(truncatedSet).sort();
  }

  return { files: filteredFiles, truncatedPaths };
}

