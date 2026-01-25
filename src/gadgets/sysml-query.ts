/**
 * SysML Query Gadget
 * Queries the SysML model for entities, relationships, and cross-references.
 * Uses the sysml2 CLI to parse and extract semantic information.
 */

import { createGadget, z } from "llmist";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { runSysml2, selectElements } from "../lib/sysml/sysml2-cli.js";
import { GADGET_REASON_DESCRIPTION } from "../lib/constants.js";

interface DefinitionInfo {
  name: string;
  type: string;
  file: string;
  qualifiedName: string;
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
 * Map sysml2 element type to human-readable definition type.
 */
function mapElementType(type: string): string {
  // sysml2 returns types like "PartDef", "ActionDef", "Package"
  const typeMap: Record<string, string> = {
    Package: "package",
    PartDef: "part def",
    ActionDef: "action def",
    ItemDef: "item def",
    AttributeDef: "attribute def",
    PortDef: "port def",
    ConnectionDef: "connection def",
    InterfaceDef: "interface def",
    EnumerationDef: "enum def",
    StateDef: "state def",
    ConstraintDef: "constraint def",
    RequirementDef: "requirement def",
    UseCaseDef: "use case def",
    ViewDef: "view def",
    ViewpointDef: "viewpoint def",
    AllocationDef: "allocation def",
    FlowDef: "flow def",
    CalculationDef: "calc def",
    CaseDef: "case def",
    AnalysisCaseDef: "analysis def",
    VerificationCaseDef: "verification def",
    ConcernDef: "concern def",
    RenderingDef: "rendering def",
    MetadataDef: "metadata def",
    OccurrenceDef: "occurrence def",
  };
  return typeMap[type] ?? type.replace(/Def$/, " def").toLowerCase();
}

/**
 * Check if an element type is a definition type.
 */
function isDefinitionType(type: string): boolean {
  return type.endsWith("Def") || type === "Package";
}

/**
 * Scan all SysML files and extract their definitions using sysml2 JSON output.
 */
async function scanSysmlFiles(): Promise<{
  definitions: DefinitionInfo[];
  relationships: RelationshipInfo[];
  files: { path: string; content: string }[];
}> {
  const sysmlDir = ".sysml";
  const definitions: DefinitionInfo[] = [];
  const relationships: RelationshipInfo[] = [];
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

            // Use sysml2 -f json for semantic model
            const result = await runSysml2(content, { json: true });

            // Extract definitions from elements
            for (const elem of result.elements) {
              if (isDefinitionType(elem.type)) {
                definitions.push({
                  name: elem.name,
                  type: mapElementType(elem.type),
                  file: relativePath,
                  qualifiedName: elem.id,
                });
              }
            }

            // Extract relationships
            for (const rel of result.relationships) {
              if (rel.kind === "specializes" || rel.kind === "Specialization") {
                relationships.push({
                  source: rel.source,
                  target: rel.target,
                  type: "specializes",
                  file: relativePath,
                });
              }
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
  return { definitions, relationships, files };
}

export const sysmlQuery = createGadget({
  name: "SysMLQuery",
  description: `Query the SysML model for entities, relationships, and cross-references.

**CLI Select Mode (PREFERRED):**
Uses sysml2 CLI --select for semantic element selection:

   SysMLQuery(select="DataModel::Entities::*")   // Direct children
   SysMLQuery(select="DataModel::Entities::**")  // All descendants
   SysMLQuery(select="UserService")              // Find by name

**Legacy Query Types:**

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
- CLI select: SysMLQuery(select="SystemModules::*")
- Find all services: SysMLQuery(query="part def", type="entity")
- Find what uses UserData: SysMLQuery(query="UserData", type="usage")
- List structure package: SysMLQuery(query="structure", type="package")`,
  schema: z.object({
    reason: z.string().describe(GADGET_REASON_DESCRIPTION),
    // CLI select mode (preferred)
    select: z.string().optional()
      .describe("CLI select pattern: 'Pkg::*' (direct children), 'Pkg::**' (all descendants), 'Element' (find by name)"),
    // Legacy query mode
    query: z.string().optional()
      .describe("Search term: entity name, definition type (e.g., 'part def'), or package name"),
    type: z.enum(["entity", "relationship", "usage", "package"]).optional().default("entity")
      .describe("Query type: entity (find definitions), relationship (find specializations/connections), usage (find where something is used), package (list package contents)"),
    depth: z.number().optional().default(1)
      .describe("Relationship traversal depth (default: 1, max: 3)"),
  }),
  execute: async ({ reason: _reason, select, query, type = "entity", depth = 1 }) => {
    // CLI select mode - use sysml2 --select directly
    if (select) {
      const sysmlDir = ".sysml";
      const allFiles: string[] = [];

      // Collect all .sysml files
      async function collectFiles(dir: string): Promise<void> {
        try {
          const entries = await readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = join(dir, entry.name);
            if (entry.isDirectory()) {
              await collectFiles(fullPath);
            } else if (entry.name.endsWith(".sysml")) {
              allFiles.push(fullPath);
            }
          }
        } catch {
          // Directory doesn't exist
        }
      }

      await collectFiles(sysmlDir);

      if (allFiles.length === 0) {
        return "No SysML model found. Run `au sysml:ingest` first to generate the model.";
      }

      try {
        const result = await selectElements(allFiles, [select], { format: "json" });

        if (!result.success) {
          return `Select query failed for pattern: ${select}\nRaw output: ${result.raw ?? "(none)"}`;
        }

        if (result.elements.length === 0 && result.relationships.length === 0) {
          return `No elements found matching pattern: ${select}`;
        }

        const lines: string[] = [];
        lines.push(`## Select results for "${select}":\n`);

        if (result.elements.length > 0) {
          lines.push(`### Elements (${result.elements.length}):\n`);
          for (const elem of result.elements) {
            lines.push(`- **${elem.type}** ${elem.name}`);
            if (elem.id !== elem.name) {
              lines.push(`  qualified: ${elem.id}`);
            }
            if (elem.parent) {
              lines.push(`  parent: ${elem.parent}`);
            }
          }
        }

        if (result.relationships.length > 0) {
          lines.push(`\n### Relationships (${result.relationships.length}):\n`);
          for (const rel of result.relationships) {
            lines.push(`- ${rel.source} --${rel.kind}--> ${rel.target}`);
          }
        }

        return lines.join("\n");
      } catch (err) {
        return `Error running select query: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    // Legacy query mode - require query parameter
    if (!query) {
      return "Error: Must provide either 'select' (CLI mode) or 'query' (legacy mode) parameter";
    }
    const { definitions, relationships, files } = await scanSysmlFiles();

    if (definitions.length === 0) {
      return "No SysML model found. Run `au sysml:ingest` first to generate the model.";
    }

    const result: QueryResult = {};
    const queryLower = query.toLowerCase();

    switch (type) {
      case "entity": {
        // Search by name or type
        const matches = definitions.filter((d) => {
          const nameMatch = d.name.toLowerCase().includes(queryLower) ||
                           d.qualifiedName.toLowerCase().includes(queryLower);
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
        const matchedRelationships: RelationshipInfo[] = [];

        // Find relationships where query is source or target
        for (const rel of relationships) {
          if (rel.source.toLowerCase().includes(queryLower) ||
              rel.target.toLowerCase().includes(queryLower)) {
            matchedRelationships.push(rel);
          }
        }

        // Also find definitions that might specialize the query
        for (const def of definitions) {
          if (def.specializes?.some((s) => s.toLowerCase().includes(queryLower))) {
            matchedRelationships.push({
              source: def.qualifiedName,
              target: def.specializes.find((s) => s.toLowerCase().includes(queryLower)) ?? query,
              type: "specializes",
              file: def.file,
            });
          }
        }

        if (matchedRelationships.length === 0) {
          return `No relationships found involving "${query}".`;
        }

        result.relationships = matchedRelationships;
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
            const prefix = pkg.qualifiedName + "::";
            const defs = definitions.filter(
              (d) => d.qualifiedName.startsWith(prefix) &&
                     d.qualifiedName.split("::").length === pkg.qualifiedName.split("::").length + 1
            );
            packages.push({
              name: pkg.name,
              file: pkg.file,
              definitions: defs.map((d) => `${d.type} ${d.name}`),
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
        if (e.qualifiedName !== e.name) {
          lines.push(`  qualified: ${e.qualifiedName}`);
        }
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
