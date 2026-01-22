/**
 * SysML Query Gadget
 * Queries the SysML model for entities, relationships, and cross-references.
 * Uses the sysml-parser to parse and traverse the AST.
 */

import { createGadget, z } from "llmist";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseDocument } from "../lib/sysml/sysml-parser-loader.js";
import { GADGET_REASON_DESCRIPTION } from "../lib/constants.js";

interface DefinitionInfo {
  name: string;
  type: string;
  file: string;
  line?: number;
  specializes?: string[];
  doc?: string;
}

interface RelationshipInfo {
  source: string;
  target: string;
  type: "specializes" | "connection" | "uses" | "contains";
  file: string;
}

interface QueryResult {
  entities?: DefinitionInfo[];
  relationships?: RelationshipInfo[];
  usages?: { entity: string; usedIn: string[]; file: string }[];
  packages?: { name: string; file: string; definitions: string[] }[];
}

/**
 * Extract the name from a Name AST node.
 */
function extractName(nameNode: unknown): string | undefined {
  if (!nameNode) return undefined;
  // Name can be an identifier or a string literal
  const node = nameNode as { name?: string; value?: string };
  return node.name ?? node.value;
}

/**
 * Extract qualified name parts from a QualifiedName node.
 */
function extractQualifiedName(qn: unknown): string | undefined {
  if (!qn) return undefined;
  const node = qn as { names?: unknown[] };
  if (Array.isArray(node.names)) {
    return node.names.map(extractName).filter(Boolean).join("::");
  }
  return extractName(qn);
}

/**
 * Extract doc comment from an element if present.
 */
function extractDoc(element: unknown): string | undefined {
  const el = element as { doc?: { text?: string } };
  if (el.doc?.text) {
    // Strip comment markers
    return el.doc.text
      .replace(/^\/\*\*?\s*/, "")
      .replace(/\s*\*\/$/, "")
      .replace(/^\s*\*\s?/gm, "")
      .trim();
  }
  return undefined;
}

/**
 * Get the definition type as a string.
 */
function getDefinitionType(element: unknown): string | undefined {
  const el = element as { $type?: string };
  const typeMap: Record<string, string> = {
    PackageBody: "package",
    PartDefinition: "part def",
    ActionDefinition: "action def",
    ItemDefinition: "item def",
    AttributeDefinition: "attribute def",
    PortDefinition: "port def",
    ConnectionDefinition: "connection def",
    InterfaceDefinition: "interface def",
    EnumerationDefinition: "enum def",
    StateDefinition: "state def",
    ConstraintDefinition: "constraint def",
    RequirementDefinition: "requirement def",
    UseCaseDefinition: "use case def",
    ViewDefinition: "view def",
    ViewpointDefinition: "viewpoint def",
    AllocationDefinition: "allocation def",
  };
  return typeMap[el.$type ?? ""] ?? el.$type;
}

/**
 * Check if an element is a definition type.
 */
function isDefinitionElement(element: unknown): boolean {
  const el = element as { $type?: string };
  return !!(el.$type && getDefinitionType(el));
}

/**
 * Extract definitions from an AST.
 * The ast is a RootNamespace with namespaceElements.
 */
function extractDefinitions(ast: { namespaceElements: unknown[] }, filePath: string): DefinitionInfo[] {
  const definitions: DefinitionInfo[] = [];

  function traverse(elements: unknown[], parentPkg?: string): void {
    if (!Array.isArray(elements)) return;

    for (const el of elements) {
      const element = el as {
        $type?: string;
        element?: unknown;
        elements?: unknown[];
        visibility?: unknown;
        name?: unknown;
        specializations?: unknown[];
        body?: { elements?: unknown[] };
      };

      if (element.$type === "OwningMembership" && element.element) {
        const innerEl = element.element as {
          $type?: string;
          name?: unknown;
          specializations?: unknown[];
          body?: { elements?: unknown[] };
          elements?: unknown[];
        };

        if (innerEl.$type === "PackageBody") {
          const pkgName = extractName(innerEl.name);
          if (pkgName) {
            definitions.push({
              name: parentPkg ? `${parentPkg}::${pkgName}` : pkgName,
              type: "package",
              file: filePath,
              doc: extractDoc(innerEl),
            });
            // Recurse into package
            if (innerEl.elements) {
              traverse(innerEl.elements, parentPkg ? `${parentPkg}::${pkgName}` : pkgName);
            }
          }
        } else if (isDefinitionElement(innerEl)) {
          const defName = extractName(innerEl.name);
          const defType = getDefinitionType(innerEl);
          if (defName && defType) {
            const specializes = innerEl.specializations
              ?.map(extractQualifiedName)
              .filter((s): s is string => !!s);
            definitions.push({
              name: parentPkg ? `${parentPkg}::${defName}` : defName,
              type: defType,
              file: filePath,
              specializes: specializes?.length ? specializes : undefined,
              doc: extractDoc(innerEl),
            });
            // Recurse into body for nested definitions
            if (innerEl.body?.elements) {
              traverse(innerEl.body.elements, parentPkg ? `${parentPkg}::${defName}` : defName);
            }
          }
        }
      }
    }
  }

  traverse(ast.namespaceElements);
  return definitions;
}

/**
 * Scan all SysML files and extract their definitions.
 */
async function scanSysmlFiles(): Promise<{
  definitions: DefinitionInfo[];
  files: { path: string; content: string }[];
}> {
  const sysmlDir = ".sysml";
  const definitions: DefinitionInfo[] = [];
  const files: { path: string; content: string }[] = [];

  async function scanDir(dir: string, prefix: string = ""): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        const fullPath = join(dir, entry.name);

        if (entry.isDirectory()) {
          await scanDir(fullPath, relativePath);
        } else if (entry.name.endsWith(".sysml")) {
          try {
            const content = await readFile(fullPath, "utf-8");
            files.push({ path: relativePath, content });

            const parseResult = await parseDocument(content, `memory://${relativePath}`);
            if (parseResult.ast && !parseResult.hasErrors) {
              const ast = parseResult.ast as { namespaceElements: unknown[] };
              const defs = extractDefinitions(ast, relativePath);
              definitions.push(...defs);
            }
          } catch {
            // Skip files that can't be parsed
          }
        }
      }
    } catch {
      // Directory doesn't exist
    }
  }

  await scanDir(sysmlDir);
  return { definitions, files };
}

export const sysmlQuery = createGadget({
  name: "SysMLQuery",
  description: `Query the SysML model for entities, relationships, and cross-references.

**Query Types:**

1. **Entity by name**: Find a specific definition
   SysMLQuery(query="UserService", type="entity")

2. **Entities by type**: Find all definitions of a certain type
   SysMLQuery(query="action def", type="entity")
   Types: package, part def, action def, item def, attribute def, port def, etc.

3. **Relationships**: Find what specializes or uses something
   SysMLQuery(query="UserService", type="relationship")

4. **Package contents**: List all definitions in a package
   SysMLQuery(query="structure", type="package")

**Examples:**
- Find all services: SysMLQuery(query="part def", type="entity")
- Find what uses UserData: SysMLQuery(query="UserData", type="usage")
- List structure package: SysMLQuery(query="structure", type="package")`,
  schema: z.object({
    reason: z.string().describe(GADGET_REASON_DESCRIPTION),
    query: z.string().describe("Search term: entity name, definition type (e.g., 'part def'), or package name"),
    type: z.enum(["entity", "relationship", "usage", "package"]).optional().default("entity")
      .describe("Query type: entity (find definitions), relationship (find specializations/connections), usage (find where something is used), package (list package contents)"),
    depth: z.number().optional().default(1)
      .describe("Relationship traversal depth (default: 1, max: 3)"),
  }),
  execute: async ({ reason: _reason, query, type = "entity", depth = 1 }) => {
    const { definitions, files } = await scanSysmlFiles();

    if (definitions.length === 0) {
      return "No SysML model found. Run `au sysml:ingest` first to generate the model.";
    }

    const result: QueryResult = {};
    const queryLower = query.toLowerCase();

    switch (type) {
      case "entity": {
        // Search by name or type
        const matches = definitions.filter((d) => {
          const nameMatch = d.name.toLowerCase().includes(queryLower);
          const typeMatch = d.type.toLowerCase() === queryLower;
          return nameMatch || typeMatch;
        });

        if (matches.length === 0) {
          return `No entities found matching "${query}".\n\nAvailable definition types: ${[...new Set(definitions.map((d) => d.type))].join(", ")}`;
        }

        result.entities = matches.slice(0, 50); // Limit to 50 results
        break;
      }

      case "relationship": {
        // Find relationships involving the query entity
        const relationships: RelationshipInfo[] = [];

        // Find definitions that specialize the query
        for (const def of definitions) {
          if (def.specializes?.some((s) => s.toLowerCase().includes(queryLower))) {
            relationships.push({
              source: def.name,
              target: def.specializes.find((s) => s.toLowerCase().includes(queryLower)) ?? query,
              type: "specializes",
              file: def.file,
            });
          }
        }

        // Find if query entity specializes something
        const queryEntity = definitions.find((d) => d.name.toLowerCase() === queryLower);
        if (queryEntity?.specializes) {
          for (const spec of queryEntity.specializes) {
            relationships.push({
              source: queryEntity.name,
              target: spec,
              type: "specializes",
              file: queryEntity.file,
            });
          }
        }

        if (relationships.length === 0) {
          return `No relationships found involving "${query}".`;
        }

        result.relationships = relationships;
        break;
      }

      case "usage": {
        // Search for usages of the query term in file contents
        const usages: { entity: string; usedIn: string[]; file: string }[] = [];

        for (const file of files) {
          // Simple text search for references (not in definitions)
          const lines = file.content.split("\n");
          const referencingLines: string[] = [];

          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            // Skip definition lines
            if (line.match(/^\s*(part|action|item|attribute|port|connection)\s+def\s+/)) {
              continue;
            }
            // Check if line references the query term
            if (line.toLowerCase().includes(queryLower)) {
              referencingLines.push(`L${i + 1}: ${line.trim()}`);
            }
          }

          if (referencingLines.length > 0) {
            usages.push({
              entity: query,
              usedIn: referencingLines.slice(0, 10), // Limit lines shown
              file: file.path,
            });
          }
        }

        if (usages.length === 0) {
          return `No usages found for "${query}".`;
        }

        result.usages = usages;
        break;
      }

      case "package": {
        // Find package and list its contents
        const packages: { name: string; file: string; definitions: string[] }[] = [];

        // Find packages matching the query
        const matchingPkgs = definitions.filter(
          (d) => d.type === "package" && d.name.toLowerCase().includes(queryLower)
        );

        if (matchingPkgs.length === 0) {
          // Try to match by file path
          const matchingFiles = [...new Set(
            definitions
              .filter((d) => d.file.toLowerCase().includes(queryLower))
              .map((d) => d.file)
          )];

          for (const file of matchingFiles) {
            const defs = definitions.filter((d) => d.file === file && d.type !== "package");
            packages.push({
              name: file.replace(/\.sysml$/, ""),
              file,
              definitions: defs.map((d) => `${d.type} ${d.name}`),
            });
          }
        } else {
          for (const pkg of matchingPkgs) {
            const prefix = pkg.name + "::";
            const defs = definitions.filter(
              (d) => d.name.startsWith(prefix) && d.name.split("::").length === pkg.name.split("::").length + 1
            );
            packages.push({
              name: pkg.name,
              file: pkg.file,
              definitions: defs.map((d) => `${d.type} ${d.name.replace(prefix, "")}`),
            });
          }
        }

        if (packages.length === 0) {
          return `No packages found matching "${query}".\n\nAvailable packages: ${definitions.filter((d) => d.type === "package").map((d) => d.name).join(", ")}`;
        }

        result.packages = packages;
        break;
      }
    }

    // Format output
    const lines: string[] = [];

    if (result.entities?.length) {
      lines.push(`## Entities matching "${query}":\n`);
      for (const e of result.entities) {
        lines.push(`- **${e.type}** ${e.name} (${e.file})`);
        if (e.specializes?.length) {
          lines.push(`  specializes: ${e.specializes.join(", ")}`);
        }
        if (e.doc) {
          lines.push(`  doc: ${e.doc.slice(0, 100)}${e.doc.length > 100 ? "..." : ""}`);
        }
      }
    }

    if (result.relationships?.length) {
      lines.push(`## Relationships involving "${query}":\n`);
      for (const r of result.relationships) {
        lines.push(`- ${r.source} --${r.type}--> ${r.target} (${r.file})`);
      }
    }

    if (result.usages?.length) {
      lines.push(`## Usages of "${query}":\n`);
      for (const u of result.usages) {
        lines.push(`**${u.file}:**`);
        for (const line of u.usedIn) {
          lines.push(`  ${line}`);
        }
      }
    }

    if (result.packages?.length) {
      lines.push(`## Package contents:\n`);
      for (const p of result.packages) {
        lines.push(`**${p.name}** (${p.file}):`);
        if (p.definitions.length === 0) {
          lines.push("  (empty or only contains nested packages)");
        } else {
          for (const d of p.definitions) {
            lines.push(`  - ${d}`);
          }
        }
      }
    }

    return lines.join("\n");
  },
});
