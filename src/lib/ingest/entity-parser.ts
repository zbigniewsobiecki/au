/**
 * Entity parsing utilities for SysML content.
 */

import type { CreatedEntity } from "./types.js";
import { listElements } from "../sysml/sysml2-cli.js";

/**
 * Parse SysML content to extract entity definitions.
 * Uses sysml2 --list via stdin to discover all definition types.
 */
export async function extractEntitiesFromSysml(content: string, file: string): Promise<CreatedEntity[]> {
  const entries = await listElements([], { stdin: content, parseOnly: true });
  return entries
    .filter((e) => e.kind.endsWith(" def"))
    .map((e) => ({ type: e.kind, name: e.name, file }));
}
