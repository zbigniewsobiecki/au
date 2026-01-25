/**
 * Entity parsing utilities for SysML content.
 */

import type { CreatedEntity } from "./types.js";

/**
 * Parse SysML content to extract entity definitions.
 */
export function extractEntitiesFromSysml(content: string, file: string): CreatedEntity[] {
  const entities: CreatedEntity[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();

    // Match item/part/action/state/analysis definitions
    const itemMatch = trimmed.match(/^(item|part|action|state|analysis)\s+def\s+(\w+)/);
    if (itemMatch) {
      entities.push({ type: `${itemMatch[1]} def`, name: itemMatch[2], file });
    }

    // Match enum definitions
    const enumMatch = trimmed.match(/^enum\s+def\s+(\w+)/);
    if (enumMatch) {
      entities.push({ type: "enum def", name: enumMatch[1], file });
    }

    // Match requirement definitions
    const reqMatch = trimmed.match(/^requirement\s+def\s+(\w+)/);
    if (reqMatch) {
      entities.push({ type: "requirement def", name: reqMatch[1], file });
    }
  }

  return entities;
}
