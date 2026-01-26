/**
 * Debug logging utilities for SysML edit operations.
 *
 * Enable with environment variable: AU_DEBUG_EDITS=1
 * Disable auto-cleanup with: AU_DEBUG_EDITS_KEEP_ALL=1
 *
 * Creates debug files in .sysml.debug/{timestamp}-{operation}-{sanitized-path}/
 */

import { mkdir, writeFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

/** Check if debug logging is enabled */
export function isDebugEnabled(): boolean {
  return process.env.AU_DEBUG_EDITS === "1";
}

/** Check if auto-cleanup is disabled */
function isKeepAllEnabled(): boolean {
  return process.env.AU_DEBUG_EDITS_KEEP_ALL === "1";
}

/** Metadata for an edit operation */
export interface EditDebugMetadata {
  timestamp: string;
  operation: "upsert" | "delete" | "create";
  gadget: "SysMLWrite" | "SysMLCreate";
  path: string;
  scope?: string;
  createScope?: boolean;
  status: "success" | "error" | "rollback";
  bytesOriginal: number;
  bytesResult: number;
  byteDelta: number;
  added?: number;
  replaced?: number;
  deleted?: number;
  dryRun: boolean;
  errorMessage?: string | null;
  diagnostics?: Array<{ severity: string; message: string; line?: number; column?: number }>;
}

/** Data for a debug entry */
export interface EditDebugData {
  metadata: EditDebugMetadata;
  original: string;
  fragment: string;
  result: string;
}

/** Maximum number of debug sessions to keep (unless AU_DEBUG_EDITS_KEEP_ALL=1) */
const MAX_DEBUG_SESSIONS = 50;

/** Debug output base directory */
const DEBUG_BASE_DIR = ".sysml.debug";

/**
 * Sanitize a file path for use in directory names.
 * Replaces path separators and special chars with dashes.
 */
function sanitizePath(filePath: string): string {
  return filePath
    .replace(/^\.sysml\//, "")
    .replace(/\.sysml$/, "")
    .replace(/[/\\:]/g, "-")
    .replace(/[^a-zA-Z0-9-_]/g, "")
    .slice(0, 50);
}

/**
 * Generate a timestamp string suitable for directory names.
 * Format: 2025-01-25T10-30-45-123Z (ISO-like, filesystem safe)
 */
function generateTimestamp(): string {
  return new Date()
    .toISOString()
    .replace(/:/g, "-")
    .replace(/\./g, "-");
}

/**
 * Write debug files for an edit operation.
 * Non-blocking: errors are logged but don't break the main operation.
 */
export async function writeEditDebug(data: EditDebugData): Promise<void> {
  if (!isDebugEnabled()) {
    return;
  }

  try {
    const timestamp = generateTimestamp();
    const sanitizedPath = sanitizePath(data.metadata.path);
    const dirName = `${timestamp}-${data.metadata.operation}-${sanitizedPath}`;
    const debugDir = join(DEBUG_BASE_DIR, dirName);

    // Create debug directory
    await mkdir(debugDir, { recursive: true });

    // Write files in parallel
    await Promise.all([
      writeFile(join(debugDir, "original.sysml"), data.original, "utf-8"),
      writeFile(join(debugDir, "fragment.sysml"), data.fragment, "utf-8"),
      writeFile(join(debugDir, "result.sysml"), data.result, "utf-8"),
      writeFile(
        join(debugDir, "metadata.json"),
        JSON.stringify(data.metadata, null, 2),
        "utf-8"
      ),
    ]);

    // Clean up old sessions (async, non-blocking)
    if (!isKeepAllEnabled()) {
      cleanupOldSessions().catch(() => {
        // Ignore cleanup errors
      });
    }
  } catch (err) {
    // Non-blocking: log error but don't break main operation
    console.error(
      `[AU_DEBUG_EDITS] Failed to write debug files: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Clean up old debug sessions, keeping only the most recent MAX_DEBUG_SESSIONS.
 * Uses lexicographic sorting of ISO timestamps in directory names.
 */
export async function cleanupOldSessions(
  maxSessions = MAX_DEBUG_SESSIONS
): Promise<void> {
  try {
    const entries = await readdir(DEBUG_BASE_DIR, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort(); // ISO timestamps sort lexicographically

    if (dirs.length <= maxSessions) {
      return;
    }

    // Remove oldest directories
    const toRemove = dirs.slice(0, dirs.length - maxSessions);
    await Promise.all(
      toRemove.map((dir) =>
        rm(join(DEBUG_BASE_DIR, dir), { recursive: true, force: true })
      )
    );
  } catch {
    // Ignore errors - directory may not exist or be inaccessible
  }
}
