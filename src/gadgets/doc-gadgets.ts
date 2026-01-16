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
});

/**
 * DocPlan gadget - creates a documentation plan with a flat list of documents.
 * Directory structure is inferred from path prefixes.
 */
export const docPlan = createGadget({
  name: "DocPlan",
  maxConcurrent: 1,
  description: `Create a documentation plan listing all documents to generate.

Use these path prefixes:
- getting-started/ - Installation, setup, quick start
- guides/ - Feature-specific how-to guides
- reference/ - API, CLI, configuration docs
- architecture/ - System design, patterns

Each document needs: path, title, description, order, sections. Directory is inferred from path prefix.
The sections array lists the main headings to include in the document.`,
  examples: [
    {
      comment: "Small project with basic docs",
      params: {
        documents: [
          { path: "getting-started/installation.md", title: "Installation", description: "Setup guide", order: 1, sections: ["Prerequisites", "Installation", "Verification"] },
          { path: "guides/usage.md", title: "Usage Guide", description: "How to use the tool", order: 1, sections: ["Overview", "Basic Usage", "Advanced Features"] },
          { path: "reference/api.md", title: "API Reference", description: "API documentation", order: 1, sections: ["Endpoints", "Authentication", "Error Codes"] },
        ],
      },
    },
    {
      comment: "Full documentation structure",
      params: {
        documents: [
          { path: "getting-started/installation.md", title: "Installation", description: "Setup guide", order: 1, sections: ["Prerequisites", "Installation Steps", "Verification"] },
          { path: "getting-started/quick-start.md", title: "Quick Start", description: "First steps", order: 2, sections: ["Overview", "Your First Project", "Next Steps"] },
          { path: "guides/authentication.md", title: "Authentication", description: "Auth guide", order: 1, sections: ["Overview", "Login Flow", "Session Management", "Security"] },
          { path: "guides/api-usage.md", title: "API Usage", description: "Using the API", order: 2, sections: ["Making Requests", "Handling Responses", "Error Handling"] },
          { path: "reference/api.md", title: "API Reference", description: "API docs", order: 1, sections: ["Endpoints", "Parameters", "Response Formats"] },
          { path: "reference/config.md", title: "Configuration", description: "Config options", order: 2, sections: ["Environment Variables", "Config File", "Defaults"] },
          { path: "architecture/overview.md", title: "Overview", description: "System design", order: 1, sections: ["High-Level Architecture", "Components", "Data Flow"] },
        ],
      },
    },
  ],
  schema: z.object({
    documents: z.array(documentSchema).describe("All documents to generate"),
  }),
  execute: async ({ documents }) => {
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
        documents: docs.sort((a, b) => a.order - b.order),
      }));

    const docCount = documents.length;
    const dirCount = structure.length;

    // Format plan summary
    const summary = structure
      .map(
        (dir) =>
          `${dir.directory} (${dir.documents.length} docs)\n` +
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
export interface DirectoryStructure {
  directory: string;
  documents: DocumentOutline[];
}
export interface DocPlanStructure {
  structure: DirectoryStructure[];
}
