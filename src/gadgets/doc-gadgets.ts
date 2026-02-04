import { createGadget, z, TaskCompletionSignal } from "llmist";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { createCompletionGadget } from "./completion-gadget.js";
import { addCollectedIssue, type IssueSeverity, type IssueCategory } from "../lib/doc-verifier.js";

// Store target directory for verification (set by document-verify command)
let verifyTargetDir: string | null = null;

export function setVerifyTargetDir(dir: string): void {
  verifyTargetDir = dir;
}

// Track whether DocPlan was successfully received (reset before each planning attempt)
let docPlanReceived = false;

export function setDocPlanReceived(value: boolean): void {
  docPlanReceived = value;
}

/**
 * Document type classification for template selection and coverage tracking.
 * Each type has specific structure requirements and validation rules.
 */
const documentTypeSchema = z.enum([
  "overview",
  "process",
  "component",
  "integration",
  "pattern",
  "reference",
]).describe(
  "Document type. MUST be one of: 'overview' (high-level architecture), " +
  "'process' (end-to-end flows), 'component' (module docs), " +
  "'integration' (external service guides), 'pattern' (cross-cutting concerns), " +
  "or 'reference' (API/config specs)"
);

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
  type: documentTypeSchema.default("reference")
    .describe("Document type for template selection: overview, process, component, integration, pattern, reference"),
  sourcePaths: z.array(z.string()).optional()
    .describe("Source files to read for validation (e.g., package.json, config files). All documents are validated against source."),
  mustCoverPaths: z.array(z.string()).optional()
    .describe("SysML paths that MUST be covered in this document (used for coverage tracking)"),
  validationFiles: z.array(z.string()).optional()
    .describe("Specific source files to read for fact-checking (frameworks, versions, commands)"),
  includeDiagram: z.enum(["none", "architecture", "sequence", "entity", "state", "flow"]).optional()
    .describe("Type of D2 diagram to include"),
  coverageTarget: z.string().optional()
    .describe("SysML path pattern this document should cover"),
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

## Document Types (use 'type' field)
- **overview**: Business context, architecture, high-level system docs
- **process**: End-to-end flows (data pipelines, user journeys, business processes)
- **component**: Per-module/package documentation
- **integration**: External service/library guides
- **pattern**: Cross-cutting concerns (auth, validation, error handling)
- **reference**: API/config reference documentation

## Common Path Prefixes
- getting-started/ - Installation, setup, quick start
- guides/ - Feature-specific how-to guides
- reference/ - API, CLI, configuration docs
- architecture/ - System design, patterns
- troubleshooting/ - Error solutions, debugging, FAQ
- operations/ - Deployment, monitoring, runbooks
- testing/ - Test strategy, running/writing tests

## Required Fields
- path, title, description, order, sections, type

## Optional Fields
- sourcePaths: files to validate against (package.json is always read)
- mustCoverPaths: SysML paths that MUST be covered (for coverage tracking)
- validationFiles: specific files for fact-checking (frameworks, versions)
- includeDiagram: architecture/sequence/entity/state/flow
- coverageTarget: SysML path pattern this document covers

Also provide directoryDescriptions for each category used.`,
  examples: [
    {
      comment: "Small project with basic docs",
      params: {
        documents: [
          { path: "getting-started/installation.md", title: "Installation", description: "Setup guide", order: 1, type: "overview", sections: ["Prerequisites", "Installation", "Verification"], sourcePaths: ["package.json"] },
          { path: "guides/usage.md", title: "Usage Guide", description: "How to use the tool", order: 1, type: "process", sections: ["Overview", "Basic Usage", "Advanced Features"] },
          { path: "reference/api.md", title: "API Reference", description: "API documentation", order: 1, type: "reference", sections: ["Endpoints", "Authentication", "Error Codes"] },
        ],
        directoryDescriptions: [
          { directory: "getting-started/", description: "Install, configure, and run your first example" },
          { directory: "guides/", description: "Step-by-step guides for common tasks" },
          { directory: "reference/", description: "API documentation and configuration options" },
        ],
      },
    },
    {
      comment: "Full documentation structure with typed documents",
      params: {
        documents: [
          { path: "getting-started/installation.md", title: "Installation", description: "Setup guide", order: 1, type: "overview", sections: ["Prerequisites", "Installation Steps", "Verification"], validationFiles: ["package.json", ".env.example"] },
          { path: "getting-started/quick-start.md", title: "Quick Start", description: "First steps", order: 2, type: "overview", sections: ["Overview", "Your First Project", "Next Steps"] },
          { path: "guides/authentication.md", title: "Authentication", description: "Auth guide", order: 1, type: "pattern", sections: ["Overview", "Login Flow", "Session Management", "Security"], mustCoverPaths: ["src/auth", "src/middleware/auth"] },
          { path: "guides/payment-flow.md", title: "Payment Flow", description: "End-to-end payment process", order: 2, type: "process", sections: ["Overview", "Steps", "Error Handling"], includeDiagram: "sequence" },
          { path: "components/api-module.md", title: "API Module", description: "API component reference", order: 1, type: "component", sections: ["Overview", "Key Files", "Public Interface"], mustCoverPaths: ["src/api"] },
          { path: "integrations/database.md", title: "Database Integration", description: "Database setup and usage", order: 1, type: "integration", sections: ["Setup", "Configuration", "Operations"], validationFiles: ["prisma/schema.prisma"] },
          { path: "reference/api.md", title: "API Reference", description: "API docs", order: 1, type: "reference", sections: ["Endpoints", "Parameters", "Response Formats"], validationFiles: ["src/api/routes.ts"] },
          { path: "reference/config.md", title: "Configuration", description: "Config options", order: 2, type: "reference", sections: ["Environment Variables", "Config File", "Defaults"], validationFiles: [".env.example"] },
          { path: "architecture/overview.md", title: "Overview", description: "System design", order: 1, type: "overview", sections: ["High-Level Architecture", "Components", "Data Flow"], includeDiagram: "architecture" },
        ],
        directoryDescriptions: [
          { directory: "getting-started/", description: "Install, configure, and run your first example" },
          { directory: "guides/", description: "Step-by-step guides for common tasks and features" },
          { directory: "components/", description: "Per-module documentation and reference" },
          { directory: "integrations/", description: "External service integration guides" },
          { directory: "reference/", description: "API documentation and configuration options" },
          { directory: "architecture/", description: "System design, patterns, and technical decisions" },
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

    docPlanReceived = true;

    return `Documentation plan created: ${docCount} documents in ${dirCount} directories\n\n${summary}\n\n<plan>\n${JSON.stringify({ structure }, null, 2)}\n</plan>`;
  },
});

/**
 * FinishPlanning gadget - signals that planning phase is complete.
 * Rejects if DocPlan hasn't been successfully received, prompting the LLM to retry.
 */
export const finishPlanning = createGadget({
  name: "FinishPlanning",
  description: `Signal that documentation planning is complete.
Call this after you have created the DocPlan.`,
  schema: z.object({
    summary: z.string().describe("Brief summary of completed work"),
  }),
  execute: async ({ summary }) => {
    if (!docPlanReceived) {
      return "Error: DocPlan was not successfully received. Your previous DocPlan call may have had a parsing error (e.g., duplicate keys). Please call DocPlan again with a valid plan, then call FinishPlanning.";
    }
    throw new TaskCompletionSignal(`Planning complete: ${summary}`);
  },
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

/**
 * ReadDoc gadget - reads a generated documentation file with parsed frontmatter.
 */
export const readDoc = createGadget({
  name: "ReadDoc",
  description: `Read a generated documentation file and parse its frontmatter.
Returns the document content along with parsed YAML frontmatter for inspection.`,
  examples: [
    {
      comment: "Read a guide document",
      params: { path: "guides/authentication.md" },
    },
  ],
  schema: z.object({
    path: z.string().describe("Path to the document within the docs directory"),
  }),
  execute: async ({ path }) => {
    if (!verifyTargetDir) {
      return "Error: Target directory not configured for verification";
    }

    const fullPath = join(verifyTargetDir, path);

    try {
      const content = await readFile(fullPath, "utf-8");

      // Parse frontmatter if present
      const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
      let frontmatter: Record<string, unknown> = {};
      let bodyContent = content;

      if (frontmatterMatch) {
        try {
          frontmatter = parse(frontmatterMatch[1]) || {};
          bodyContent = content.slice(frontmatterMatch[0].length).trim();
        } catch {
          frontmatter = { _parseError: "Failed to parse YAML frontmatter" };
        }
      }

      // Extract headings for structure analysis
      const headings = Array.from(content.matchAll(/^(#{1,6})\s+(.+)$/gm)).map(
        (m) => ({ level: m[1].length, text: m[2] })
      );

      const lines = content.split("\n").length;
      const bytes = Buffer.byteLength(content, "utf-8");

      return JSON.stringify(
        {
          path,
          lines,
          bytes,
          frontmatter,
          headings,
          content: bodyContent,
        },
        null,
        2
      );
    } catch (error) {
      return `Error reading ${path}: ${error instanceof Error ? error.message : "unknown error"}`;
    }
  },
});

/**
 * ReportIssue gadget - records a verification issue found during agentic analysis.
 */
export const reportIssue = createGadget({
  name: "ReportIssue",
  description: `Report a verification issue found in the documentation.
Use this when you find inaccuracies, outdated information, or missing content.

Severity levels:
- error: Critical issues that make the documentation incorrect (wrong framework name, incorrect commands)
- warning: Issues that should be fixed but don't break functionality (missing sections, incomplete examples)
- info: Minor suggestions for improvement (style issues, could-be-better content)

Categories:
- missing: Content that should exist but doesn't
- outdated: Information that was correct but is now stale
- inaccurate: Factually incorrect information
- incomplete: Partially correct but missing important details
- structural: Document structure issues (missing frontmatter, broken links)`,
  examples: [
    {
      comment: "Report incorrect framework name",
      params: {
        documentPath: "architecture/overview.md",
        severity: "error",
        category: "inaccurate",
        description: "States 'Express' but package.json shows 'Fastify'",
        suggestion: "Replace 'Express' with 'Fastify' throughout the document",
      },
    },
    {
      comment: "Report missing section",
      params: {
        documentPath: "guides/authentication.md",
        severity: "warning",
        category: "incomplete",
        description: "Missing 'Error Handling' section mentioned in plan",
        suggestion: "Add a section documenting authentication error codes and handling",
      },
    },
  ],
  schema: z.object({
    documentPath: z.string().describe("Path to the document within the docs directory"),
    severity: z.enum(["error", "warning", "info"]).describe("Issue severity level"),
    category: z.enum(["missing", "outdated", "inaccurate", "incomplete", "structural"])
      .describe("Issue category"),
    description: z.string().describe("Clear description of the issue found"),
    suggestion: z.string().optional().describe("Suggested fix for the issue"),
  }),
  execute: async ({ documentPath, severity, category, description, suggestion }) => {
    addCollectedIssue({
      documentPath,
      severity: severity as IssueSeverity,
      category: category as IssueCategory,
      description,
      suggestion,
    });

    return `Issue recorded: [${severity.toUpperCase()}] ${documentPath} - ${description}`;
  },
});

/**
 * FinishVerification gadget - signals that verification is complete.
 */
export const finishVerification = createCompletionGadget({
  name: "FinishVerification",
  description: `Signal that documentation verification is complete.
Call this after you have verified all documents and reported all issues found.`,
  messagePrefix: "Verification complete",
});

/**
 * FinishFixing gadget - signals that documentation fixing is complete.
 */
export const finishFixing = createCompletionGadget({
  name: "FinishFixing",
  description: `Signal that documentation fixing is complete.
Call this after all fixable issues have been addressed.`,
  messagePrefix: "Fixing complete",
});

/**
 * FinishFeedback gadget - signals that documentation feedback is complete.
 */
export const finishFeedback = createCompletionGadget({
  name: "FinishFeedback",
  description: `Signal that documentation feedback is complete.
Call this after you have reviewed all documents and reported all feedback.`,
  messagePrefix: "Feedback complete",
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
