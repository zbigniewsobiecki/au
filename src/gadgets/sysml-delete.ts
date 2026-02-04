/**
 * SysML Delete Gadget
 * Deletes SysML v2 elements from the model using the sysml2 CLI.
 */

import { createGadget, z } from "llmist";
import { join } from "node:path";
import { deleteElements } from "../lib/sysml/sysml2-cli.js";
import { GADGET_REASON_DESCRIPTION } from "../lib/constants.js";

export const sysmlDelete = createGadget({
  name: "SysMLDelete",
  description: `Delete SysML elements from the model using CLI-based semantic deletion.

**Usage:**
\`\`\`
SysMLDelete(path="data/entities.sysml", element="DomainEntities::OldUser")
SysMLDelete(path="data/entities.sysml", element="DomainEntities::Legacy", recursive=true)
\`\`\`

**Parameters:**
- path: File path relative to .sysml/
- element: Qualified element path to delete (e.g., "Pkg::Element")
- recursive: Use '**' pattern for recursive delete of all nested elements
- dryRun: Preview what would be deleted without actually deleting

**Behavior:**
- Uses sysml2 CLI --delete for semantic element deletion
- Cascades to remove dependent elements
- Returns success even if element not found (deleted=0)`,
  schema: z.object({
    reason: z.string().describe(GADGET_REASON_DESCRIPTION),
    path: z
      .string()
      .describe("File path relative to .sysml/ (e.g., 'data/entities.sysml')"),
    element: z
      .string()
      .describe("Element path or pattern to delete. Supports: 'Pkg::Element' (exact), 'Pkg::*' (direct children), 'Pkg::**' (all descendants)"),
    recursive: z
      .boolean()
      .optional()
      .describe("Use '**' pattern for recursive delete of nested elements (default: false)"),
    dryRun: z
      .boolean()
      .optional()
      .describe("Preview changes without deleting (default: false)"),
  }),
  execute: async ({ reason: _reason, path, element, recursive = false, dryRun = false }) => {
    // Ensure path ends with .sysml
    if (!path.endsWith(".sysml")) {
      return `Error: File path must end with .sysml extension`;
    }

    const fullPath = join(".sysml", path);

    // Build the delete pattern - detect if element already contains wildcards
    const hasWildcard = element.includes("::*");
    const pattern = hasWildcard ? element : (recursive ? `${element}::**` : element);

    try {
      const result = await deleteElements(fullPath, [pattern], { dryRun });

      if (!result.success) {
        return `path=${fullPath} status=error\n\nDelete failed:\n${result.stderr || "Unknown error"}`;
      }

      const dryRunNote = dryRun ? " (dry run)" : "";
      const recursiveNote = recursive ? " (recursive)" : "";

      if (result.deleted === 0) {
        return `path=${fullPath} status=success${dryRunNote}${recursiveNote}
Element not found: ${pattern}
(Nothing was deleted)`;
      }

      return `path=${fullPath} status=success${dryRunNote}${recursiveNote}
Deleted: ${result.deleted} element(s) matching: ${pattern}`;
    } catch (err) {
      return `path=${fullPath} status=error\n\nError: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});
