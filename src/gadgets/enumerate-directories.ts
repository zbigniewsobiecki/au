/**
 * EnumerateDirectories Gadget
 * Enumerate directories at a path with metadata for LLM assignment.
 */

import { createGadget, z } from "llmist";
import { readdir, stat } from "node:fs/promises";
import { join, posix } from "node:path";
import { loadGitignore, type IgnoreMatcher } from "../lib/gitignore.js";
import { GADGET_REASON_DESCRIPTION } from "../lib/constants.js";

export interface DirectoryInfo {
  name: string;
  path: string;
  fileCount: number;
  extensions: string[];
  hasTests: boolean;
  hasIndex: boolean;
}

export interface EnumerationResult {
  path: string;
  count: number;
  directories: DirectoryInfo[];
}

/**
 * Load .gitignore patterns and add common ignores for directory enumeration.
 */
async function loadIgnorePatterns(basePath: string): Promise<IgnoreMatcher> {
  const ig = await loadGitignore(basePath);

  // Add common directories to ignore
  ig.add([
    "node_modules",
    ".git",
    ".sysml",
    "dist",
    "build",
    "coverage",
    ".cache",
    ".next",
    ".nuxt",
  ]);

  return ig;
}

/**
 * Get file extension from filename.
 */
function getExtension(filename: string): string | null {
  const parts = filename.split(".");
  if (parts.length < 2) return null;
  return parts[parts.length - 1];
}

/**
 * Check if a filename is a test file.
 */
function isTestFile(filename: string): boolean {
  return (
    filename.includes(".spec.") ||
    filename.includes(".test.") ||
    filename.endsWith(".spec.ts") ||
    filename.endsWith(".spec.js") ||
    filename.endsWith(".test.ts") ||
    filename.endsWith(".test.js")
  );
}

/**
 * Check if a filename is an index file.
 */
function isIndexFile(filename: string): boolean {
  return (
    filename === "index.ts" ||
    filename === "index.js" ||
    filename === "index.tsx" ||
    filename === "index.jsx" ||
    filename === "mod.ts" ||
    filename === "mod.rs" ||
    filename === "__init__.py"
  );
}

/**
 * Enumerate directories recursively up to a specified depth.
 */
async function enumerateRecursive(
  basePath: string,
  currentPath: string,
  ig: IgnoreMatcher,
  currentDepth: number,
  maxDepth: number
): Promise<DirectoryInfo[]> {
  if (currentDepth > maxDepth) {
    return [];
  }

  const fullPath = join(basePath, currentPath);
  let entries;

  try {
    entries = await readdir(fullPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const directories: DirectoryInfo[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    // Normalize path for gitignore matching (use forward slashes)
    const dirPath = currentPath ? posix.join(currentPath, entry.name) : entry.name;

    // Check gitignore
    if (ig.ignores(dirPath) || ig.ignores(dirPath + "/")) {
      continue;
    }

    // Get directory contents for metadata
    const dirFullPath = join(fullPath, entry.name);
    let files: string[] = [];

    try {
      const dirEntries = await readdir(dirFullPath, { withFileTypes: true });
      files = dirEntries
        .filter((e) => e.isFile())
        .map((e) => e.name);
    } catch {
      // Can't read directory, skip
      continue;
    }

    // Extract metadata
    const extensions = [...new Set(
      files
        .map(getExtension)
        .filter((ext): ext is string => ext !== null)
    )].sort();

    const hasTests = files.some(isTestFile);
    const hasIndex = files.some(isIndexFile);

    directories.push({
      name: entry.name,
      path: dirPath,
      fileCount: files.length,
      extensions,
      hasTests,
      hasIndex,
    });

    // Recurse into subdirectories if depth allows
    if (currentDepth < maxDepth) {
      const subDirs = await enumerateRecursive(
        basePath,
        dirPath,
        ig,
        currentDepth + 1,
        maxDepth
      );
      directories.push(...subDirs);
    }
  }

  return directories;
}

export const enumerateDirectories = createGadget({
  name: "EnumerateDirectories",
  description: `Enumerate directories at a path with metadata. Respects .gitignore.

**Usage:**
EnumerateDirectories(path="apps/backend/src/modules")

Returns exact count and directory details including:
- name: Directory name
- path: Relative path from project root
- fileCount: Number of files in directory
- extensions: File extensions present
- hasTests: Whether directory contains test files
- hasIndex: Whether directory has an index/entry point file

**Key insight**: Use this to SEE directories before assigning them to cycles.
Do NOT estimate counts - use this gadget to get exact numbers.

Example:
EnumerateDirectories(path="apps/backend/src/modules", depth=1)

Returns:
{
  "path": "apps/backend/src/modules",
  "count": 49,
  "directories": [
    { "name": "accounts", "path": "apps/backend/src/modules/accounts", "fileCount": 12, "extensions": ["ts"], "hasTests": true, "hasIndex": true },
    { "name": "auth0", "path": "apps/backend/src/modules/auth0", "fileCount": 8, "extensions": ["ts"], "hasTests": true, "hasIndex": true },
    ...
  ]
}`,
  schema: z.object({
    reason: z.string().describe(GADGET_REASON_DESCRIPTION),
    path: z.string().describe("Path to enumerate (relative to project root)"),
    depth: z.number().default(1).describe("Depth of enumeration (1 = immediate children only, 2 = children and grandchildren)"),
  }),
  execute: async ({ path: inputPath, depth }) => {
    const basePath = process.cwd();
    const fullPath = join(basePath, inputPath);

    // Check if path exists
    try {
      const pathStat = await stat(fullPath);
      if (!pathStat.isDirectory()) {
        return `Error: Path is not a directory: ${inputPath}`;
      }
    } catch {
      return `Error: Path does not exist: ${inputPath}`;
    }

    // Load gitignore patterns
    const ig = await loadIgnorePatterns(basePath);

    // Enumerate directories
    const directories = await enumerateRecursive(
      basePath,
      inputPath,
      ig,
      1,
      depth
    );

    // Sort by path for consistent output
    directories.sort((a, b) => a.path.localeCompare(b.path));

    const result: EnumerationResult = {
      path: inputPath,
      count: directories.length,
      directories,
    };

    // Format output as readable text with JSON at the end
    let output = `=== Directory Enumeration: ${inputPath} ===\n`;
    output += `Found ${directories.length} directories (depth=${depth})\n\n`;

    // Show summary table
    output += `| Directory | Files | Extensions | Tests | Index |\n`;
    output += `|-----------|-------|------------|-------|-------|\n`;
    for (const dir of directories) {
      const exts = dir.extensions.slice(0, 3).join(",") + (dir.extensions.length > 3 ? "..." : "");
      output += `| ${dir.name} | ${dir.fileCount} | ${exts} | ${dir.hasTests ? "✓" : "-"} | ${dir.hasIndex ? "✓" : "-"} |\n`;
    }

    output += `\n\nJSON:\n${JSON.stringify(result, null, 2)}`;

    return output;
  },
});
