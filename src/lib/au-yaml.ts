import { parse, stringify } from "yaml";
import { createHash } from "node:crypto";

// Types
export interface Meta {
  au: "1.0";
  id: string;
  type: "file" | "directory" | "repository";
  analyzed_at: string;
  analyzed_hash: string;
}

export interface AuDocument {
  meta?: Meta;
  [key: string]: unknown;
}

/**
 * Parse dot-notation path into segments.
 * "understanding.exports.0" → ["understanding", "exports", "0"]
 * "" or "." → [] (root)
 */
export function parsePath(path: string): string[] {
  if (!path || path === ".") {
    return [];
  }
  return path.split(".");
}

/**
 * Check if a segment looks like an array index (non-negative integer).
 */
function isArrayIndex(segment: string): boolean {
  return /^(0|[1-9]\d*)$/.test(segment);
}

/**
 * Try to parse a value if it looks like stringified JSON or YAML.
 * LLMs sometimes pass objects as:
 * - JSON strings: "{name: \"foo\"}"
 * - YAML strings: "name: foo\nkind: function"
 */
function maybeParseJsonString(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();

  // Check if it looks like a JSON object or array
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // Not valid JSON, try YAML below
    }
  }

  // Check if it looks like YAML (has key: value pattern with newlines)
  // Pattern: "key: value\nkey2: value2" or "key: value"
  if (trimmed.includes(":") && (trimmed.includes("\n") || /^[a-zA-Z_][a-zA-Z0-9_]*:\s/.test(trimmed))) {
    try {
      const parsed = parse(trimmed);
      // Only return if we got an object (not a string like "http://...")
      if (typeof parsed === "object" && parsed !== null) {
        return parsed;
      }
    } catch {
      // Not valid YAML, return as-is
    }
  }

  return value;
}

/**
 * Set value at path, creating intermediate objects/arrays as needed.
 * Returns new object (immutable operation).
 *
 * Array behavior: If index exceeds array length, appends to end.
 */
export function setByPath(
  obj: AuDocument,
  path: string,
  value: unknown
): AuDocument {
  // Auto-parse JSON strings (LLMs sometimes stringify objects)
  const parsedValue = maybeParseJsonString(value);
  const segments = parsePath(path);

  // Protect meta path
  if (segments.length > 0 && segments[0] === "meta") {
    throw new Error("Meta fields are auto-managed and cannot be set directly");
  }

  // Root replacement
  if (segments.length === 0) {
    if (typeof parsedValue !== "object" || parsedValue === null) {
      throw new Error("Root value must be an object");
    }
    // Preserve meta when replacing root
    const { meta } = obj;
    return { ...parsedValue, meta } as AuDocument;
  }

  // Deep clone to avoid mutation
  const result = structuredClone(obj) as AuDocument;
  let current: unknown = result;

  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    const nextSegment = segments[i + 1];
    const nextIsArray = isArrayIndex(nextSegment);

    if (typeof current !== "object" || current === null) {
      throw new Error(
        `Cannot traverse into non-object at "${segments.slice(0, i).join(".")}"`
      );
    }

    const rec = current as Record<string, unknown>;

    if (rec[segment] === undefined || rec[segment] === null) {
      // Create intermediate structure
      rec[segment] = nextIsArray ? [] : {};
    }

    const child = rec[segment];

    // Handle array index
    if (Array.isArray(current) && isArrayIndex(segment)) {
      const idx = parseInt(segment, 10);
      if (idx >= current.length) {
        // Append case - we'll set at the end later
        current[current.length] = nextIsArray ? [] : {};
        current = current[current.length - 1];
        continue;
      }
    }

    if (typeof child !== "object" || child === null) {
      throw new Error(
        `Cannot traverse into non-object at "${segments.slice(0, i + 1).join(".")}"`
      );
    }

    current = child;
  }

  // Set the final value
  const lastSegment = segments[segments.length - 1];

  if (typeof current !== "object" || current === null) {
    throw new Error("Cannot set value on non-object");
  }

  if (Array.isArray(current) && isArrayIndex(lastSegment)) {
    const idx = parseInt(lastSegment, 10);
    if (idx >= current.length) {
      // Append to array instead of creating gap
      current.push(parsedValue);
    } else {
      current[idx] = parsedValue;
    }
  } else {
    (current as Record<string, unknown>)[lastSegment] = parsedValue;
  }

  return result;
}

/**
 * Delete key at path (and descendants).
 * Returns new object (immutable operation).
 */
export function deleteByPath(obj: AuDocument, path: string): AuDocument {
  const segments = parsePath(path);

  // Protect meta path
  if (segments.length > 0 && segments[0] === "meta") {
    throw new Error("Meta fields are auto-managed and cannot be deleted");
  }

  // Can't delete root
  if (segments.length === 0) {
    throw new Error("Cannot delete root document");
  }

  // Deep clone to avoid mutation
  const result = structuredClone(obj) as AuDocument;
  let current: unknown = result;

  // Navigate to parent
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];

    if (typeof current !== "object" || current === null) {
      return result; // Path doesn't exist, nothing to delete
    }

    const child = (current as Record<string, unknown>)[segment];
    if (child === undefined) {
      return result; // Path doesn't exist, nothing to delete
    }

    current = child;
  }

  // Delete the final key
  const lastSegment = segments[segments.length - 1];

  if (typeof current !== "object" || current === null) {
    return result;
  }

  if (Array.isArray(current) && isArrayIndex(lastSegment)) {
    const idx = parseInt(lastSegment, 10);
    if (idx < current.length) {
      current.splice(idx, 1);
    }
  } else {
    delete (current as Record<string, unknown>)[lastSegment];
  }

  return result;
}

/**
 * Generate meta section for an .au file.
 */
export function generateMeta(
  filePath: string,
  type: "file" | "directory" | "repository",
  sourceContent: string
): Meta {
  const id = filePath === "." || filePath === "" ? "au:" : `au:${filePath}`;
  const hash = createHash("md5").update(sourceContent).digest("hex");

  return {
    au: "1.0",
    id,
    type,
    analyzed_at: new Date().toISOString(),
    analyzed_hash: hash,
  };
}

/**
 * Detect type based on file path.
 */
export function detectType(
  filePath: string
): "file" | "directory" | "repository" {
  if (filePath === "." || filePath === "") {
    return "repository";
  }
  // Check if path has a file extension (simple heuristic)
  const lastPart = filePath.split("/").pop() || "";

  // Regular files with extensions (not starting with dot)
  if (lastPart.includes(".") && !lastPart.startsWith(".")) {
    return "file";
  }

  // Dotfiles: most are files, but some patterns are directories
  if (lastPart.startsWith(".")) {
    // Known directory patterns
    const directoryPatterns = [".git", ".github", ".vscode", ".idea", ".aws", ".ssh", ".cache", ".npm", ".yarn", ".pnpm"];
    if (directoryPatterns.includes(lastPart)) {
      return "directory";
    }
    // Dotfiles like .gitignore, .npmrc, .env, .dockerignore are files
    return "file";
  }

  return "directory";
}

/**
 * Parse .au file content (YAML).
 */
export function parseAuFile(content: string): AuDocument {
  const doc = parse(content);
  if (typeof doc !== "object" || doc === null) {
    return {};
  }
  return doc as AuDocument;
}

/**
 * Stringify .au document to YAML with consistent formatting.
 */
export function stringifyAuFile(doc: AuDocument): string {
  return stringify(doc, {
    indent: 2,
    lineWidth: 100,
    defaultKeyType: "PLAIN",
    defaultStringType: "QUOTE_DOUBLE",
  });
}

/**
 * Strip the meta block from a document.
 * Used to prepare content for LLM inference (saves tokens, reduces noise).
 */
export function stripMeta(doc: AuDocument): AuDocument {
  const { meta, ...rest } = doc;
  return rest;
}

/**
 * Stringify .au document for inference context (meta stripped).
 */
export function stringifyForInference(doc: AuDocument): string {
  return stringifyAuFile(stripMeta(doc));
}
