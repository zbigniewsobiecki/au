/**
 * SysML Write Gadget
 * Writes SysML v2 packages to the .sysml/ directory.
 * Supports two modes:
 * 1. Full content mode: Write entire file content (for new files)
 * 2. Search/Replace mode: Find and replace specific content (for edits)
 */

import { createGadget, z } from "llmist";
import { writeFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as Diff from "diff";
import { validateSysml } from "../lib/sysml/validator.js";
import {
  findMatch,
  findAllMatches,
  applyReplacement,
  formatDiff,
  type MatchResult,
} from "../lib/sysml/matcher.js";
import { GADGET_REASON_DESCRIPTION } from "../lib/constants.js";

export interface SysMLWriteResult {
  path: string;
  marker: "new" | "upd";
  oldBytes: number;
  newBytes: number;
  diffLines: Array<{ type: "add" | "del" | "ctx"; line: string }> | null;
  /** For search/replace mode: the matching strategy used */
  strategy?: string;
  /** For search/replace mode: formatted diff output */
  diffOutput?: string;
}

/**
 * Filter diff lines to only show changes with surrounding context.
 */
function filterWithContext(
  lines: Array<{ type: "add" | "del" | "ctx"; line: string }>,
  contextLines: number
): Array<{ type: "add" | "del" | "ctx"; line: string }> {
  if (lines.length === 0) return [];

  // Mark which indices should be included (changes + context)
  const include = new Array(lines.length).fill(false);

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].type !== "ctx") {
      // Mark this line and surrounding context
      for (let j = Math.max(0, i - contextLines); j <= Math.min(lines.length - 1, i + contextLines); j++) {
        include[j] = true;
      }
    }
  }

  return lines.filter((_, i) => include[i]);
}

/**
 * Compute diff lines between old and new content.
 */
function computeDiffLines(
  oldContent: string,
  newContent: string,
  contextLines: number = 1
): Array<{ type: "add" | "del" | "ctx"; line: string }> {
  const changes = Diff.diffLines(oldContent, newContent);
  const diffLines: Array<{ type: "add" | "del" | "ctx"; line: string }> = [];

  for (const change of changes) {
    const lines = change.value.split("\n").filter((l, i, arr) => i < arr.length - 1 || l !== "");
    for (const line of lines) {
      if (change.added) {
        diffLines.push({ type: "add", line });
      } else if (change.removed) {
        diffLines.push({ type: "del", line });
      } else {
        diffLines.push({ type: "ctx", line });
      }
    }
  }

  // Filter to only show changes + context
  return filterWithContext(diffLines, contextLines);
}

export const sysmlWrite = createGadget({
  name: "SysMLWrite",
  maxConcurrent: 1,
  description: `Write SysML v2 content to the .sysml/ directory.

**Two modes:**

1. **Full content mode** (for new files or complete rewrites):
   SysMLWrite(path="context/requirements.sysml", content="package SystemRequirements { ... }")

2. **Search/Replace mode** (for targeted edits - PREFERRED for existing files):
   SysMLWrite(path="context/requirements.sysml", search="old text", replace="new text")

**Search/Replace mode details:**
- Uses layered matching: exact → whitespace-normalized → indentation-normalized → fuzzy
- Provide enough context in 'search' to uniquely identify the location
- Use replaceAll=true to replace ALL occurrences (default: replace first match only)
- Returns nice diff output showing the change with line numbers

**Tips:**
- Always use search/replace for edits (smaller output, clearer diffs)
- Include 1-2 lines of surrounding context in search to ensure unique match
- If match fails, re-read the file with SysMLRead to get current content`,
  schema: z.object({
    reason: z.string().describe(GADGET_REASON_DESCRIPTION),
    path: z
      .string()
      .describe("File path relative to .sysml/ (e.g., 'context/requirements.sysml')"),
    // Mode 1: Full content (for new files)
    content: z
      .string()
      .optional()
      .describe("Full SysML v2 content to write (use for new files or complete rewrites)"),
    // Mode 2: Search/Replace (for edits)
    search: z
      .string()
      .optional()
      .describe("Content to find in the existing file (for search/replace mode)"),
    replace: z
      .string()
      .optional()
      .describe("Content to replace the search match with (for search/replace mode)"),
    replaceAll: z
      .boolean()
      .optional()
      .describe("Replace ALL occurrences instead of just the first (default: false)"),
    validate: z
      .boolean()
      .optional()
      .describe("Whether to validate SysML syntax before writing (default: true)"),
  }),
  execute: async ({ reason: _reason, path, content, search, replace, replaceAll = false, validate = true }) => {
    // Ensure path ends with .sysml
    if (!path.endsWith(".sysml")) {
      return `Error: File path must end with .sysml extension`;
    }

    const fullPath = join(".sysml", path);

    // Determine mode
    const isSearchReplace = search !== undefined && replace !== undefined;
    const isFullContent = content !== undefined;

    // Validate mode selection
    if (!isSearchReplace && !isFullContent) {
      return `Error: Must provide either 'content' (full content mode) or 'search'+'replace' (search/replace mode)`;
    }

    if (isSearchReplace && isFullContent) {
      return `Error: Cannot use both modes. Use either 'content' OR 'search'+'replace', not both.`;
    }

    // Read existing content if file exists
    let existingContent = "";
    let oldBytes = 0;
    let isNew = true;

    try {
      existingContent = await readFile(fullPath, "utf-8");
      oldBytes = Buffer.byteLength(existingContent, "utf-8");
      isNew = false;
    } catch {
      // File doesn't exist
      if (isSearchReplace) {
        return `Error: Cannot use search/replace on non-existent file: ${fullPath}\nUse 'content' parameter to create a new file.`;
      }
    }

    let newContent: string;
    let strategy: string | undefined;
    let diffOutput: string | undefined;

    if (isSearchReplace) {
      // Search/Replace mode
      const searchResult = replaceAll
        ? findAllMatches(existingContent, search!)
        : [findMatch(existingContent, search!)].filter((m): m is MatchResult => m.found);

      if (!replaceAll) {
        // Single match mode
        const match = findMatch(existingContent, search!);

        if (!match.found) {
          // Return detailed error with suggestions
          return `ERROR: Search content NOT FOUND in ${fullPath}\n\nYour search:\n\`\`\`\n${search}\n\`\`\`\n\n${(match as { message: string }).message}`;
        }

        // Now TypeScript knows match.found is true, so it's a MatchResult
        const successMatch = match as MatchResult;

        // Apply the replacement
        newContent = applyReplacement(existingContent, successMatch, replace!);
        strategy = successMatch.strategy;

        // Generate nice diff output
        diffOutput = formatDiff(existingContent, newContent, successMatch, replace!, 2);
      } else {
        // Replace all mode
        const matches = findAllMatches(existingContent, search!);

        if (matches.length === 0) {
          const noMatch = findMatch(existingContent, search!);
          if (!noMatch.found) {
            return `ERROR: Search content NOT FOUND in ${fullPath}\n\nYour search:\n\`\`\`\n${search}\n\`\`\`\n\n${(noMatch as { message: string }).message}`;
          }
          return `ERROR: No matches found for replaceAll in ${fullPath}`;
        }

        if (matches.length === 1) {
          // Just one match, apply it
          newContent = applyReplacement(existingContent, matches[0], replace!);
          strategy = matches[0].strategy;
          diffOutput = formatDiff(existingContent, newContent, matches[0], replace!, 2);
        } else {
          // Multiple matches - apply in reverse order to preserve indices
          newContent = existingContent;
          const reversedMatches = [...matches].reverse();

          for (const match of reversedMatches) {
            newContent = applyReplacement(newContent, {
              ...match,
              startIndex: match.startIndex - (existingContent.length - newContent.length),
              endIndex: match.endIndex - (existingContent.length - newContent.length),
            }, replace!);
          }

          strategy = matches[0].strategy;
          diffOutput = `Replaced ${matches.length} occurrences at lines: ${matches.map(m => `${m.startLine}-${m.endLine}`).join(", ")}`;
        }
      }
    } else {
      // Full content mode
      newContent = content!;
    }

    // Validate SysML syntax if requested
    if (validate) {
      const validationResult = await validateSysml(newContent);
      if (!validationResult.valid) {
        const errors = validationResult.issues
          .filter((i) => i.severity === "error")
          .map((i) => `  Line ${i.line}:${i.column}: ${i.message}`)
          .join("\n");

        if (isSearchReplace) {
          return `path=${fullPath} status=error\n\nSysML validation failed:\n${errors}\n\nReplacement would have been:\n${diffOutput}`;
        }
        return `Error: Invalid SysML syntax:\n${errors}`;
      }
    }

    // Create directory if needed
    const dir = dirname(fullPath);
    if (dir && dir !== ".") {
      await mkdir(dir, { recursive: true });
    }

    // Write file
    await writeFile(fullPath, newContent, "utf-8");

    const newBytes = Buffer.byteLength(newContent, "utf-8");
    const marker: "new" | "upd" = isNew ? "new" : "upd";

    // Compute diff lines for full content mode
    let diffLines: SysMLWriteResult["diffLines"] = null;
    if (!isNew && existingContent !== newContent && !isSearchReplace) {
      diffLines = computeDiffLines(existingContent, newContent, 1);
    }

    // Build result
    const result: SysMLWriteResult = {
      path: fullPath,
      marker,
      oldBytes,
      newBytes,
      diffLines,
    };

    if (strategy) {
      result.strategy = strategy;
    }
    if (diffOutput) {
      result.diffOutput = diffOutput;
    }

    // For search/replace mode, return a more readable format
    if (isSearchReplace) {
      const statusLine = `path=${fullPath} status=success strategy=${strategy}`;
      const validLine = validate ? "\n✓ Valid SysML" : "";
      return `${statusLine}\n\n${diffOutput}${validLine}`;
    }

    return JSON.stringify(result);
  },
});

export const sysmlRead = createGadget({
  name: "SysMLRead",
  description: `Read SysML v2 content from the .sysml/ directory.

**Usage:**
SysMLRead(path="context/requirements.sysml")

Returns the file content with line numbers for easy reference when using search/replace.`,
  schema: z.object({
    reason: z.string().describe(GADGET_REASON_DESCRIPTION),
    path: z
      .string()
      .describe("File path relative to .sysml/ (e.g., 'context/requirements.sysml')"),
  }),
  execute: async ({ reason: _reason, path }) => {
    const fullPath = join(".sysml", path);

    try {
      const content = await readFile(fullPath, "utf-8");
      const bytes = Buffer.byteLength(content, "utf-8");
      const lines = content.split("\n");
      const lineNumWidth = String(lines.length).length;

      // Format with line numbers for easy reference
      const numberedContent = lines
        .map((line, i) => {
          const lineNum = String(i + 1).padStart(lineNumWidth, " ");
          return `${lineNum} | ${line}`;
        })
        .join("\n");

      return `=== ${path} (${bytes} bytes, ${lines.length} lines) ===\n${numberedContent}`;
    } catch {
      return `Error: File not found: ${fullPath}`;
    }
  },
});

export const sysmlList = createGadget({
  name: "SysMLList",
  description: `List all SysML files in the .sysml/ directory.

**Usage:**
SysMLList()

Returns a list of all .sysml files with their sizes.`,
  schema: z.object({
    reason: z.string().describe(GADGET_REASON_DESCRIPTION),
  }),
  execute: async ({ reason: _reason }) => {
    const { readdir } = await import("node:fs/promises");
    const { join } = await import("node:path");

    const files: { path: string; bytes: number }[] = [];

    async function scanDir(dir: string, prefix: string = ""): Promise<void> {
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
          const fullPath = join(dir, entry.name);

          if (entry.isDirectory()) {
            await scanDir(fullPath, relativePath);
          } else if (entry.name.endsWith(".sysml")) {
            const statResult = await stat(fullPath);
            files.push({
              path: relativePath,
              bytes: statResult.size,
            });
          }
        }
      } catch {
        // Directory doesn't exist
      }
    }

    await scanDir(".sysml");

    if (files.length === 0) {
      return "No .sysml files found. Run sysml-ingest to generate the model.";
    }

    // Sort by path
    files.sort((a, b) => a.path.localeCompare(b.path));

    const lines = files.map((f) => `${f.path} (${f.bytes} bytes)`);
    const totalBytes = files.reduce((sum, f) => sum + f.bytes, 0);

    return `SysML Model Files:\n${lines.join("\n")}\n\nTotal: ${files.length} files, ${totalBytes} bytes`;
  },
});
