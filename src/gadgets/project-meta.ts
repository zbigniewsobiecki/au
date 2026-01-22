/**
 * Project Metadata Gadget
 * Manages project metadata for SysML reverse engineering.
 */

import { createGadget, z } from "llmist";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  discoverProject,
  generateProjectFile,
  type ProjectMetadata,
} from "../lib/sysml/index.js";
import { GADGET_REASON_DESCRIPTION } from "../lib/constants.js";

const PROJECT_META_PATH = ".sysml/_project.sysml";

/**
 * Extract metadata JSON from SysML file.
 */
function extractMetadata(content: string): ProjectMetadata | null {
  const metaMatch = content.match(/\/\*\s*META:\s*([\s\S]*?)\s*\*\//);
  if (metaMatch) {
    try {
      return JSON.parse(metaMatch[1]) as ProjectMetadata;
    } catch {
      return null;
    }
  }
  return null;
}

export const projectMetaRead = createGadget({
  name: "ProjectMetaRead",
  description: `Read project metadata for SysML reverse engineering.

**Usage:**
ProjectMetaRead()

Returns discovered or cached project metadata including:
- Project name, type, version
- Primary language and framework
- Architecture style
- Entry points
- External dependencies
- Discovered ports (HTTP, gRPC, CLI, etc.)`,
  schema: z.object({
    reason: z.string().describe(GADGET_REASON_DESCRIPTION),
  }),
  execute: async ({ reason: _reason }) => {
    // Try to read cached metadata
    try {
      const content = await readFile(PROJECT_META_PATH, "utf-8");
      const metadata = extractMetadata(content);
      if (metadata) {
        return `=== Project Metadata (cached) ===
Name: ${metadata.name}
Version: ${metadata.version ?? "N/A"}
Description: ${metadata.description || "N/A"}
Type: ${metadata.projectType}
Language: ${metadata.primaryLanguage}
Framework: ${metadata.framework ?? "none"}
Architecture: ${metadata.architectureStyle}
Runtime: ${metadata.runtime ?? "unknown"}

Entry Points:
${metadata.entryPoints.map((ep) => `  - ${ep}`).join("\n") || "  (none discovered)"}

External Dependencies:
${metadata.externalDependencies.map((d) => `  - ${d.name} (${d.type}): ${d.purpose}`).join("\n") || "  (none discovered)"}

Ports:
${Object.entries(metadata.ports).filter(([, v]) => v).map(([k]) => `  - ${k}`).join("\n") || "  (none discovered)"}

Discovered: ${metadata.discoveredAt}`;
      }
    } catch {
      // File doesn't exist, discover
    }

    // Discover project metadata
    const metadata = await discoverProject(".");

    return `=== Project Metadata (freshly discovered) ===
Name: ${metadata.name}
Version: ${metadata.version ?? "N/A"}
Description: ${metadata.description || "N/A"}
Type: ${metadata.projectType}
Language: ${metadata.primaryLanguage}
Framework: ${metadata.framework ?? "none"}
Architecture: ${metadata.architectureStyle}
Runtime: ${metadata.runtime ?? "unknown"}

Entry Points:
${metadata.entryPoints.map((ep) => `  - ${ep}`).join("\n") || "  (none discovered)"}

External Dependencies:
${metadata.externalDependencies.map((d) => `  - ${d.name} (${d.type}): ${d.purpose}`).join("\n") || "  (none discovered)"}

Ports:
${Object.entries(metadata.ports).filter(([, v]) => v).map(([k]) => `  - ${k}`).join("\n") || "  (none discovered)"}

Discovered: ${metadata.discoveredAt}`;
  },
});

export const projectMetaDiscover = createGadget({
  name: "ProjectMetaDiscover",
  description: `Discover and save project metadata.

**Usage:**
ProjectMetaDiscover()

Analyzes the codebase to detect:
- Language and framework
- Project type (web-app, api, library, cli, etc.)
- Architecture style
- External dependencies
- Entry points

Saves the metadata to .sysml/_project.sysml`,
  schema: z.object({
    refresh: z
      .boolean()
      .default(false)
      .describe("Force re-discovery even if cached metadata exists"),
  }),
  execute: async ({ refresh }) => {
    // Check for existing metadata if not refreshing
    if (!refresh) {
      try {
        const content = await readFile(PROJECT_META_PATH, "utf-8");
        const metadata = extractMetadata(content);
        if (metadata) {
          return `Project metadata already exists (discovered ${metadata.discoveredAt}). Use refresh=true to re-discover.`;
        }
      } catch {
        // Continue to discovery
      }
    }

    // Discover project metadata
    const metadata = await discoverProject(".");

    // Generate and save SysML file
    const sysmlContent = generateProjectFile(metadata);

    await mkdir(".sysml", { recursive: true });
    await writeFile(PROJECT_META_PATH, sysmlContent, "utf-8");

    return `Discovered and saved project metadata:
Name: ${metadata.name}
Type: ${metadata.projectType}
Language: ${metadata.primaryLanguage}
Framework: ${metadata.framework ?? "none"}
Architecture: ${metadata.architectureStyle}

Saved to: ${PROJECT_META_PATH}`;
  },
});

export const projectMetaUpdate = createGadget({
  name: "ProjectMetaUpdate",
  description: `Update specific fields in project metadata.

**Usage:**
ProjectMetaUpdate(field="framework", value="nextjs")

Valid fields: projectType, framework, architectureStyle, runtime, description`,
  schema: z.object({
    field: z
      .enum(["projectType", "framework", "architectureStyle", "runtime", "description"])
      .describe("Field to update"),
    value: z.string().describe("New value for the field"),
  }),
  execute: async ({ field, value }) => {
    // Read existing metadata
    let metadata: ProjectMetadata;

    try {
      const content = await readFile(PROJECT_META_PATH, "utf-8");
      const existing = extractMetadata(content);
      if (!existing) {
        return "Error: Could not parse existing metadata. Run ProjectMetaDiscover first.";
      }
      metadata = existing;
    } catch {
      return "Error: Project metadata not found. Run ProjectMetaDiscover first.";
    }

    // Update field
    switch (field) {
      case "projectType":
        metadata.projectType = value as ProjectMetadata["projectType"];
        break;
      case "framework":
        metadata.framework = value;
        break;
      case "architectureStyle":
        metadata.architectureStyle = value as ProjectMetadata["architectureStyle"];
        break;
      case "runtime":
        metadata.runtime = value;
        break;
      case "description":
        metadata.description = value;
        break;
    }

    // Regenerate and save
    const sysmlContent = generateProjectFile(metadata);
    await writeFile(PROJECT_META_PATH, sysmlContent, "utf-8");

    return `Updated ${field} to "${value}" in project metadata.`;
  },
});
