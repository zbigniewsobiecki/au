import { join, extname } from "node:path";

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
 * Determines if a source path is likely a file or directory.
 * Uses extension heuristic - paths with common code extensions are files.
 */
export function isLikelyFile(sourcePath: string): boolean {
  const ext = extname(sourcePath).toLowerCase();
  const fileExtensions = new Set([
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".json",
    ".md",
    ".yaml",
    ".yml",
    ".toml",
    ".css",
    ".scss",
    ".html",
    ".vue",
    ".svelte",
  ]);
  return fileExtensions.has(ext);
}
