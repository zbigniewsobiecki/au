import { createGadget, z } from "llmist";
import { createCompletionGadget } from "./completion-gadget.js";

/**
 * Schema for a single document in the documentation plan.
 * Flat structure - directory is inferred from path prefix.
 */
const documentSchema = z.object({
  path: z.string().describe("File path with directory prefix, e.g., 'guides/authentication.md'"),
  title: z.string().default("Untitled").describe("Document title"),
  description: z.string().default("").describe("Brief description (1 sentence)"),
  order: z.number().int().default(1).describe("Order within directory (1, 2, 3...)"),
  sections: z.array(z.string()).default([]).describe("Section headings to include in this document"),
  requiresSourceValidation: z.boolean().optional()
    .describe("If true, verify facts against source files before writing"),
  sourcePaths: z.array(z.string()).optional()
    .describe("Source files to validate against (e.g., package.json, config files)"),
  includeDiagram: z.enum(["none", "architecture", "sequence", "entity", "state", "flow"]).optional()
    .describe("Type of D2 diagram to include"),
  coverageTarget: z.string().optional()
    .describe("AU path pattern this document should cover"),
});

/**
 * Schema for directory/category structure with description.
 */
const directoryMetaSchema = z.object({
  directory: z.string().describe("Directory name (e.g., 'guides/', 'architecture/')"),
  description: z.string().describe("Short description of this category for navigation/index"),
});

/**
 * DocPlan gadget - creates a documentation plan with a flat list of documents.
 * Directory structure is inferred from path prefixes.
 */
export const docPlan = createGadget({
  name: "DocPlan",
  maxConcurrent: 1,
  description: `Create a documentation plan listing all documents to generate.

Common path prefixes (use these as examples, create custom categories as needed):
- getting-started/ - Installation, setup, quick start
- guides/ - Feature-specific how-to guides
- reference/ - API, CLI, configuration docs
- architecture/ - System design, patterns
- troubleshooting/ - Error solutions, debugging, FAQ
- operations/ - Deployment, monitoring, runbooks
- testing/ - Test strategy, running/writing tests

Each document needs: path, title, description, order, sections.
Optional: requiresSourceValidation (for accuracy-critical docs), sourcePaths, includeDiagram, coverageTarget.

Also provide directoryDescriptions for each category used, especially custom categories.`,
  examples: [
    {
      comment: "Small project with basic docs",
      params: {
        documents: [
          { path: "getting-started/installation.md", title: "Installation", description: "Setup guide", order: 1, sections: ["Prerequisites", "Installation", "Verification"], requiresSourceValidation: true, sourcePaths: ["package.json"] },
          { path: "guides/usage.md", title: "Usage Guide", description: "How to use the tool", order: 1, sections: ["Overview", "Basic Usage", "Advanced Features"] },
          { path: "reference/api.md", title: "API Reference", description: "API documentation", order: 1, sections: ["Endpoints", "Authentication", "Error Codes"] },
        ],
        directoryDescriptions: [
          { directory: "getting-started/", description: "Install, configure, and run your first example" },
          { directory: "guides/", description: "Step-by-step guides for common tasks" },
          { directory: "reference/", description: "API documentation and configuration options" },
        ],
      },
    },
    {
      comment: "Full documentation structure with custom categories",
      params: {
        documents: [
          { path: "getting-started/installation.md", title: "Installation", description: "Setup guide", order: 1, sections: ["Prerequisites", "Installation Steps", "Verification"], requiresSourceValidation: true, sourcePaths: ["package.json", ".env.example"] },
          { path: "getting-started/quick-start.md", title: "Quick Start", description: "First steps", order: 2, sections: ["Overview", "Your First Project", "Next Steps"] },
          { path: "guides/authentication.md", title: "Authentication", description: "Auth guide", order: 1, sections: ["Overview", "Login Flow", "Session Management", "Security"] },
          { path: "guides/api-usage.md", title: "API Usage", description: "Using the API", order: 2, sections: ["Making Requests", "Handling Responses", "Error Handling"] },
          { path: "reference/api.md", title: "API Reference", description: "API docs", order: 1, sections: ["Endpoints", "Parameters", "Response Formats"], requiresSourceValidation: true },
          { path: "reference/config.md", title: "Configuration", description: "Config options", order: 2, sections: ["Environment Variables", "Config File", "Defaults"], requiresSourceValidation: true, sourcePaths: [".env.example"] },
          { path: "architecture/overview.md", title: "Overview", description: "System design", order: 1, sections: ["High-Level Architecture", "Components", "Data Flow"], includeDiagram: "architecture" },
          { path: "troubleshooting/common-errors.md", title: "Common Errors", description: "Solutions to frequent issues", order: 1, sections: ["Installation Errors", "Runtime Errors", "Configuration Issues"] },
        ],
        directoryDescriptions: [
          { directory: "getting-started/", description: "Install, configure, and run your first example" },
          { directory: "guides/", description: "Step-by-step guides for common tasks and features" },
          { directory: "reference/", description: "API documentation and configuration options" },
          { directory: "architecture/", description: "System design, patterns, and technical decisions" },
          { directory: "troubleshooting/", description: "Solve common problems and find answers" },
        ],
      },
    },
  ],
  schema: z.object({
    documents: z.array(documentSchema).describe("All documents to generate"),
    directoryDescriptions: z.array(directoryMetaSchema).default([])
      .describe("Descriptions for each directory/category used in the plan"),
  }),
  execute: async ({ documents, directoryDescriptions }) => {
    // Build description lookup
    const descriptionMap = new Map<string, string>();
    for (const { directory, description } of directoryDescriptions || []) {
      // Normalize directory name (ensure trailing slash)
      const normalized = directory.endsWith("/") ? directory : directory + "/";
      descriptionMap.set(normalized, description);
    }

    // Group by directory
    const byDir = new Map<string, typeof documents>();
    for (const doc of documents) {
      const parts = doc.path.split("/");
      const dir = parts.length > 1 ? parts[0] + "/" : "root/";
      const existing = byDir.get(dir) || [];
      existing.push(doc);
      byDir.set(dir, existing);
    }

    // Build structure (sorted by directory name, docs sorted by order)
    const structure = Array.from(byDir.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([directory, docs]) => ({
        directory,
        description: descriptionMap.get(directory) || "",
        documents: docs.sort((a, b) => a.order - b.order),
      }));

    const docCount = documents.length;
    const dirCount = structure.length;

    // Format plan summary
    const summary = structure
      .map(
        (dir) =>
          `${dir.directory} (${dir.documents.length} docs)${dir.description ? ` - ${dir.description}` : ""}\n` +
          dir.documents.map((d) => `  - ${d.path}`).join("\n")
      )
      .join("\n");

    return `Documentation plan created: ${docCount} documents in ${dirCount} directories\n\n${summary}\n\n<plan>\n${JSON.stringify({ structure }, null, 2)}\n</plan>`;
  },
});

/**
 * FinishPlanning gadget - signals that planning phase is complete.
 */
export const finishPlanning = createCompletionGadget({
  name: "FinishPlanning",
  description: `Signal that documentation planning is complete.
Call this after you have created the DocPlan.`,
  messagePrefix: "Planning complete",
});

/**
 * FinishDocs gadget - signals that documentation generation is complete.
 */
export const finishDocs = createCompletionGadget({
  name: "FinishDocs",
  description: `Signal that documentation generation is complete.
Call this after all planned documents have been written.`,
  messagePrefix: "Documentation complete",
});

// Export types for use in other modules
export type DocumentOutline = z.infer<typeof documentSchema>;
export type DirectoryMeta = z.infer<typeof directoryMetaSchema>;
export interface DirectoryStructure {
  directory: string;
  description: string;
  documents: DocumentOutline[];
}
export interface DocPlanStructure {
  structure: DirectoryStructure[];
}
