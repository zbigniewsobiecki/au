import { join, extname } from "node:path";
import fg from "fast-glob";

/**
 * Resolves the .au file path for a given source path.
 *
 * Rules:
 * - File /foo/bar/baz.ts -> /foo/bar/baz.ts.au (append .au)
 * - Directory /foo/bar -> /foo/bar/.au
 * - Root . -> .au
 */
export function resolveAuPath(sourcePath: string): string {
  // Normalize path
  const normalized = sourcePath.replace(/\/$/, "") || ".";

  if (normalized === ".") {
    return ".au";
  }

  // Check if it's a file (has extension) or directory
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

/**
 * Find all .au files in a directory.
 * @param basePath The directory to search from
 * @param includeRoot Whether to include root .au file in the pattern
 */
export async function findAuFiles(
  basePath: string = ".",
  includeRoot: boolean = true
): Promise<string[]> {
  const patterns = includeRoot
    ? ["**/.au", "**/*.au", ".au"]
    : ["**/.au", "**/*.au"];

  return fg(patterns, {
    cwd: basePath,
    ignore: ["node_modules/**"],
    absolute: false,
    dot: true,
  });
}

