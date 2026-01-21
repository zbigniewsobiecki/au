import { Command, Flags } from "@oclif/core";
import { AgentBuilder, LLMist } from "llmist";
import { rm, mkdir, access, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { writeDoc, setTargetDir, auList } from "../gadgets/index.js";
import { docPlan, finishPlanning, finishDocs } from "../gadgets/doc-gadgets.js";
import { Output } from "../lib/output.js";
import { render } from "../lib/templates.js";
import {
  agentFlags,
  configureBuilder,
  createTextBlockState,
  endTextBlock,
  setupIterationTracking,
  withWorkingDirectory,
  selectReadGadgets,
} from "../lib/command-utils.js";
import { runAgentWithEvents } from "../lib/agent-runner.js";

interface DocPlanStructure {
  structure: Array<{
    directory: string;
    description: string;
    documents: Array<{
      path: string;
      title: string;
      description: string;
      order: number;
      type?: string;
      sections?: string[];
      sourcePaths?: string[];
      mustCoverPaths?: string[];
      validationFiles?: string[];
      includeDiagram?: string;
      coverageTarget?: string;
    }>;
  }>;
}

interface ProjectMetadata {
  name: string;
  description: string;
  repository?: string;
}

/**
 * Structure analysis results from AU content.
 * Used to guide documentation coverage decisions.
 */
interface StructureAnalysis {
  componentCount: number;
  componentPaths: string[];
  integrationMentions: string[];
  processMentions: string[];
  patternMentions: string[];
  projectType: "library" | "application" | "monorepo" | "unknown";
}

/**
 * Analyzes AU summary content to extract structure information.
 * This is language-agnostic and works from AU summaries and paths.
 */
function analyzeAUStructure(auSummary: string): StructureAnalysis {
  const result: StructureAnalysis = {
    componentCount: 0,
    componentPaths: [],
    integrationMentions: [],
    processMentions: [],
    patternMentions: [],
    projectType: "unknown",
  };

  // Parse AU entries from the summary
  // Format: === path/to/file.au ===
  const auEntries = auSummary.match(/^=== (.+?) ===/gm) || [];
  const paths = auEntries.map((e) => e.replace(/^=== | ===$/g, ""));

  // Detect project type from directory structure
  if (paths.some((p) => p.startsWith("apps/") || p.startsWith("packages/"))) {
    result.projectType = "monorepo";
  } else if (paths.some((p) => p.includes("/src/") || p.match(/^src\//))) {
    result.projectType = "application";
  } else if (paths.some((p) => p.includes("/lib/") || p.match(/^lib\//))) {
    result.projectType = "library";
  }

  // Identify component boundaries (language-agnostic)
  // Look for common component directory patterns
  const componentPatterns = [
    /^apps\/([^/]+)\//,           // monorepo apps
    /^packages\/([^/]+)\//,        // monorepo packages
    /^src\/modules\/([^/]+)\//,    // module-based architecture
    /^src\/components\/([^/]+)\//, // component-based
    /^src\/services\/([^/]+)\//,   // service-based
    /^lib\/([^/]+)\//,             // library modules
    /^internal\/([^/]+)\//,        // Go internal packages
    /^pkg\/([^/]+)\//,             // Go packages
    /^cmd\/([^/]+)\//,             // Go commands
  ];

  const componentSet = new Set<string>();
  for (const path of paths) {
    for (const pattern of componentPatterns) {
      const match = path.match(pattern);
      if (match && match[1]) {
        componentSet.add(match[1]);
        break;
      }
    }
  }
  result.componentPaths = Array.from(componentSet).sort();
  result.componentCount = componentSet.size;

  // Extract integration mentions from summaries
  // Look for common external service patterns
  const integrationKeywords = [
    // Databases
    "database", "postgres", "postgresql", "mysql", "mongodb", "redis", "dynamodb",
    "prisma", "sequelize", "typeorm", "drizzle",
    // Auth providers
    "auth0", "firebase auth", "cognito", "okta", "clerk",
    // Payment services
    "stripe", "paypal", "braintree", "adyen",
    // Cloud services
    "aws", "s3", "sqs", "sns", "lambda",
    "azure", "gcp", "google cloud",
    // Communication
    "twilio", "sendgrid", "mailgun", "postmark", "resend",
    // Monitoring
    "sentry", "datadog", "newrelic", "grafana",
    // Other integrations
    "temporal", "kafka", "rabbitmq", "elasticsearch",
    "openai", "anthropic", "webhook",
  ];

  const summaryLower = auSummary.toLowerCase();
  for (const keyword of integrationKeywords) {
    if (summaryLower.includes(keyword)) {
      result.integrationMentions.push(keyword);
    }
  }
  // Dedupe and sort
  result.integrationMentions = [...new Set(result.integrationMentions)].sort();

  // Extract process/flow mentions
  const processKeywords = [
    "workflow", "pipeline", "flow", "process", "saga",
    "job", "queue", "worker", "cron", "scheduler",
    "migration", "deployment", "build",
  ];

  for (const keyword of processKeywords) {
    if (summaryLower.includes(keyword)) {
      result.processMentions.push(keyword);
    }
  }
  result.processMentions = [...new Set(result.processMentions)].sort();

  // Extract pattern mentions (cross-cutting concerns)
  const patternKeywords = [
    "authentication", "authorization", "auth",
    "validation", "error handling", "exception",
    "logging", "logger", "telemetry", "observability",
    "caching", "cache", "middleware",
    "security", "encryption", "rate limit",
  ];

  for (const keyword of patternKeywords) {
    if (summaryLower.includes(keyword)) {
      result.patternMentions.push(keyword);
    }
  }
  result.patternMentions = [...new Set(result.patternMentions)].sort();

  return result;
}

/**
 * Formats the structure analysis as a human-readable string for the planning prompt.
 */
function formatStructureAnalysis(analysis: StructureAnalysis): string {
  const lines: string[] = [];

  lines.push(`**Project Type**: ${analysis.projectType}`);
  lines.push("");

  lines.push(`**Components Detected**: ${analysis.componentCount}`);
  if (analysis.componentPaths.length > 0) {
    lines.push(`  → ${analysis.componentPaths.join(", ")}`);
    lines.push(`  → Minimum component docs recommended: ${Math.ceil(analysis.componentCount / 3)}`);
  }
  lines.push("");

  if (analysis.integrationMentions.length > 0) {
    lines.push(`**External Integrations**: ${analysis.integrationMentions.length}`);
    lines.push(`  → ${analysis.integrationMentions.join(", ")}`);
    lines.push(`  → Minimum integration docs recommended: ${analysis.integrationMentions.length}`);
    lines.push("");
  }

  if (analysis.processMentions.length > 0) {
    lines.push(`**Processes/Flows Detected**: ${analysis.processMentions.length}`);
    lines.push(`  → ${analysis.processMentions.join(", ")}`);
    lines.push("");
  }

  if (analysis.patternMentions.length > 0) {
    lines.push(`**Cross-Cutting Patterns**: ${analysis.patternMentions.length}`);
    lines.push(`  → ${analysis.patternMentions.join(", ")}`);
    lines.push("");
  }

  return lines.join("\n");
}

async function readProjectMetadata(): Promise<ProjectMetadata> {
  try {
    const pkg = JSON.parse(await readFile("package.json", "utf-8"));
    let repository = pkg.repository;
    if (typeof repository === "object" && repository?.url) {
      repository = repository.url.replace(/^git\+/, "").replace(/\.git$/, "");
    }
    return {
      name: pkg.name || "Documentation",
      description: pkg.description || "",
      repository: typeof repository === "string" ? repository : undefined,
    };
  } catch {
    return { name: "Documentation", description: "" };
  }
}

function formatLabel(directory: string): string {
  return directory
    .replace(/\/$/, "")
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

// Fallback descriptions for common categories (used when plan doesn't provide one)
const FALLBACK_SECTION_DESCRIPTIONS: Record<string, string> = {
  "getting-started": "Install and set up for local development",
  guides: "Learn how to use features effectively",
  architecture: "Understand system design and patterns",
  reference: "API documentation and configuration options",
  troubleshooting: "Solve common problems and find answers",
  operations: "Deploy, monitor, and maintain in production",
  testing: "Run tests, write new tests, and understand test strategy",
  security: "Security practices and authentication",
  integrations: "Third-party service integrations",
  migrations: "Upgrade guides and breaking changes",
  examples: "Code examples and sample projects",
  tutorials: "Step-by-step learning paths",
  concepts: "Conceptual explanations and mental models",
};

function getSectionDescription(directory: string, planDescription?: string): string {
  // Prefer plan-provided description
  if (planDescription) {
    return planDescription;
  }
  // Fall back to hardcoded descriptions
  const key = directory.replace(/\/$/, "");
  return FALLBACK_SECTION_DESCRIPTIONS[key] || `Documentation for ${formatLabel(directory)}`;
}

export default class Document extends Command {
  static description = "Generate markdown documentation from AU understanding";

  static examples = [
    "<%= config.bin %> document --target ./docs",
    "<%= config.bin %> document --target ./docs --model opus",
    "<%= config.bin %> document --target ./docs --dry-run",
    "<%= config.bin %> document --target ./docs --au-only",
    "<%= config.bin %> document --target ./docs --code-only",
    "<%= config.bin %> document --target ./docs --format starlight",
  ];

  static flags = {
    ...agentFlags,
    target: Flags.string({
      char: "t",
      description: "Target directory for generated documentation",
      required: true,
    }),
    format: Flags.string({
      char: "f",
      description: "Output format (markdown, starlight)",
      default: "markdown",
      options: ["markdown", "starlight"],
    }),
    "dry-run": Flags.boolean({
      description: "Show planned structure without writing files",
      default: false,
    }),
    "skip-clear": Flags.boolean({
      description: "Skip clearing target directory (default: resume mode)",
      default: true,
    }),
    replan: Flags.boolean({
      description: "Force re-planning even if cached plan exists",
      default: false,
    }),
    "plan-iterations": Flags.integer({
      description: "Max iterations for planning phase",
      default: 5,
    }),
    "gen-iterations": Flags.integer({
      description: "Max iterations for generation phase",
      default: 30,
    }),
    "au-only": Flags.boolean({
      description: "Use only AU files, no source code reading",
      default: false,
      exclusive: ["code-only"],
    }),
    "code-only": Flags.boolean({
      description: "Use only source code, no AU files",
      default: false,
      exclusive: ["au-only"],
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Document);
    const out = new Output({ verbose: flags.verbose, progressLabel: "Documentation" });

    const { restore } = withWorkingDirectory(flags.path, out);

    const auOnly = flags["au-only"];
    const codeOnly = flags["code-only"];

    // Load AU understanding summary (unless code-only mode)
    let auSummary: string | null = null;
    if (!codeOnly) {
      out.info("Loading AU understanding...");
      try {
        auSummary = (await auList.execute({ path: "." })) as string;
      } catch (error) {
        out.error(`Failed to load AU understanding: ${error instanceof Error ? error.message : error}`);
        restore();
        process.exit(1);
      }

      if (!auSummary || auSummary.trim() === "" || auSummary === "No AU entries found.") {
        if (auOnly) {
          out.error("No AU understanding found. Run 'au ingest' first to create understanding files.");
          restore();
          process.exit(1);
        } else {
          out.warn("No AU understanding found. Will use source code only.");
          auSummary = null;
        }
      } else {
        const auEntries = (auSummary.match(/^=== /gm) || []).length;
        out.success(`Found ${auEntries} understanding entries`);
      }
    } else {
      out.info("Code-only mode: skipping AU files");
    }

    // Phase 1: Planning (or load cached plan)
    const targetDir = flags.target;
    const planFile = `${targetDir}/.au/doc-plan.json`;
    const client = new LLMist();
    let documentPlan: DocPlanStructure | null = null;

    // Try to load cached plan (unless --replan)
    if (!flags.replan) {
      try {
        const cached = await readFile(planFile, "utf-8");
        documentPlan = JSON.parse(cached);
        const cachedDocs = documentPlan!.structure.reduce((sum, dir) => sum + dir.documents.length, 0);
        out.success(`Loaded cached plan: ${cachedDocs} documents`);
      } catch {
        // No cached plan, will run planning
      }
    }

    // Run planning if no cached plan
    if (!documentPlan) {
      out.info("Planning documentation structure...");

      // Analyze AU structure for coverage guidance
      let structureAnalysis: string | undefined;
      if (auSummary) {
        const analysis = analyzeAUStructure(auSummary);
        structureAnalysis = formatStructureAnalysis(analysis);
        out.info(`Detected ${analysis.componentCount} components, ${analysis.integrationMentions.length} integrations`);
      }

      const planSystemPrompt = render("document/plan-system", {});
      const planInitialPrompt = render("document/plan-initial", {
        auSummary: auSummary || "",
        structureAnalysis,
      });

      // Build gadgets based on mode
      const planGadgets = [docPlan, finishPlanning, ...selectReadGadgets({ auOnly, codeOnly })];

      let planBuilder = new AgentBuilder(client)
        .withModel(flags.model)
        .withSystem(planSystemPrompt)
        .withMaxIterations(flags["plan-iterations"])
        .withGadgetOutputLimitPercent(30)
        .withGadgets(...planGadgets);

      planBuilder = configureBuilder(planBuilder, out, flags.rpm, flags.tpm);

      // Inject AU summary as synthetic call (only if available)
      if (auSummary) {
        planBuilder.withSyntheticGadgetCall(
          "AUListSummary",
          { path: "." },
          auSummary,
          "gc_init_1"
        );
      }

      const planAgent = planBuilder.ask(planInitialPrompt);

      // Track text block state for planning
      const planTextState = createTextBlockState();

      // Subscribe to planning agent for iteration tracking
      const planTree = planAgent.getTree();
      setupIterationTracking(planTree, {
        out,
        showCumulativeCostEvery: 5,
        onIterationChange: () => endTextBlock(planTextState, out),
      });

      // Run planning agent and capture DocPlan
      try {
        await runAgentWithEvents(planAgent, {
          out,
          textState: planTextState,
          onGadgetResult: (gadgetName, result) => {
            // Capture DocPlan result
            if (gadgetName === "DocPlan" && result) {
              // Extract JSON from the result (it's wrapped in <plan> tags)
              const planMatch = result.match(/<plan>\s*([\s\S]*?)\s*<\/plan>/);
              if (planMatch) {
                try {
                  documentPlan = JSON.parse(planMatch[1]);
                } catch {
                  out.warn("Failed to parse documentation plan");
                }
              }
            }
          },
        });
      } catch (error) {
        out.error(`Planning failed: ${error instanceof Error ? error.message : error}`);
        restore();
        process.exit(1);
      }

      if (!documentPlan) {
        out.error("No documentation plan was created. Check verbose output for details.");
        restore();
        process.exit(1);
      }

      // At this point documentPlan is guaranteed non-null
      const newPlan = documentPlan as DocPlanStructure;

      // Save plan to cache
      try {
        await mkdir(`${targetDir}/.au`, { recursive: true });
        await writeFile(planFile, JSON.stringify(newPlan, null, 2));
        out.info(`Saved plan to ${planFile}`);
      } catch (error) {
        out.warn(`Could not cache plan: ${error instanceof Error ? error.message : error}`);
      }

      const newPlanDocs = newPlan.structure.reduce((sum, dir) => sum + dir.documents.length, 0);
      out.success(`Plan created: ${newPlanDocs} documents in ${newPlan.structure.length} directories`);
    }

    // Calculate total docs for progress tracking
    // At this point documentPlan is guaranteed non-null (either from cache or planning)
    const plan = documentPlan!;
    const totalDocs = plan.structure.reduce((sum: number, dir) => sum + dir.documents.length, 0);

    console.log();
    out.header("Documentation Plan:");
    for (const dir of plan.structure) {
      console.log(`  ${dir.directory} (${dir.documents.length} docs)`);
      for (const doc of dir.documents) {
        console.log(`    - ${doc.path}`);
      }
    }
    console.log();

    // Handle dry-run mode
    if (flags["dry-run"]) {
      out.success("Dry run complete. Use without --dry-run to generate documentation.");
      restore();
      return;
    }

    // Clear target directory (if requested)
    if (!flags["skip-clear"]) {
      out.warn(`Clearing target directory: ${targetDir}`);
      try {
        await rm(targetDir, { recursive: true, force: true });
      } catch {
        // Directory might not exist, that's fine
      }
    }

    // Create target directory
    try {
      await mkdir(targetDir, { recursive: true });
    } catch (error) {
      out.error(`Failed to create target directory: ${error instanceof Error ? error.message : error}`);
      restore();
      process.exit(1);
    }

    // Phase 2: Generation via orchestrator
    out.info("Generating documentation...");

    // Set target directory for WriteFile gadget
    setTargetDir(targetDir);

    const orchestratorSystemPrompt = render("document/orchestrator-system", {});

    // Flatten documents for the orchestrator
    const allDocs = plan.structure.flatMap((dir) =>
      dir.documents.map((doc) => ({
        ...doc,
        directory: dir.directory,
      }))
    );

    // Check which documents already exist (for resume mode)
    const existingDocs = new Set<string>();
    for (const doc of allDocs) {
      const fullPath = `${targetDir}/${doc.path}`;
      try {
        await access(fullPath);
        existingDocs.add(doc.path);
      } catch {
        // File doesn't exist, needs to be written
      }
    }

    // Filter to only pending documents
    const pendingDocs = allDocs.filter((d) => !existingDocs.has(d.path));

    if (pendingDocs.length === 0) {
      out.success("All documents already exist. Nothing to generate.");
      restore();
      return;
    }

    if (existingDocs.size > 0) {
      out.info(`Resuming: ${existingDocs.size} docs exist, ${pendingDocs.length} remaining`);
    }

    // Build research instruction based on mode
    let researchInstruction: string;
    if (auOnly) {
      researchInstruction = "ONE AURead call with 2-4 relevant paths";
    } else if (codeOnly) {
      researchInstruction = "ReadFiles/ReadDirs/RipGrep calls to gather source code";
    } else {
      researchInstruction = "ONE AURead call (with multiple paths) or ReadFiles as needed";
    }

    // Format document info with optional metadata (numbered for clarity)
    const formatDocInfo = (d: typeof pendingDocs[0], index: number) => {
      const docType = d.type || "reference";
      let info = `${index + 1}. **${d.path}** (type: ${docType}): ${d.title}
   Sections: ${d.sections?.length ? d.sections.join(", ") : "(use your judgment)"}`;
      // Show AU paths to cover if specified
      if (d.mustCoverPaths?.length) {
        info += `\n   📂 Must cover: ${d.mustCoverPaths.join(", ")}`;
      }
      // All docs require validation - show which files to read
      const filesToRead = d.validationFiles?.length
        ? d.validationFiles.join(", ")
        : d.sourcePaths?.length
          ? d.sourcePaths.join(", ")
          : "package.json";
      info += `\n   📖 Read source: ${filesToRead}`;
      if (d.includeDiagram && d.includeDiagram !== "none") {
        info += `\n   📊 Include ${d.includeDiagram} diagram`;
      }
      return info;
    };

    const orchestratorInitialPrompt = `Generate ${pendingDocs.length} documentation files based on this plan.

## CRITICAL: One Document Per Turn
- You may only call WriteFile ONCE per turn
- After WriteFile, STOP and wait for confirmation
- Each document must be 80-150+ lines minimum

## Document Queue (${pendingDocs.length} documents):
${pendingDocs.map((d, i) => formatDocInfo(d, i)).join("\n\n")}

## Workflow Per Document
1. **Read**: ${researchInstruction} (use paths from AUListSummary above)
2. **Validate**: If marked "REQUIRES VALIDATION", also read those source files
3. **Write**: Call WriteFile with complete, thorough markdown (80-150+ lines)
4. **Stop**: Wait for confirmation, then proceed to next document

## Quality Requirements
- Each document: 80-150 lines MINIMUM
- Include: overview, detailed sections, code examples, cross-references
- Code examples must be complete with imports
- Link to related documents in the set

## Start Now
Begin with document #1: **${pendingDocs[0]?.path}**
Read the relevant AU content, then write a comprehensive document.

Call FinishDocs only after ALL ${pendingDocs.length} documents are written.`;

    // Build gadgets based on mode
    const genGadgets = [writeDoc, ...selectReadGadgets({ auOnly, codeOnly }), finishDocs];

    let genBuilder = new AgentBuilder(client)
      .withModel(flags.model)
      .withSystem(orchestratorSystemPrompt)
      .withMaxIterations(flags["gen-iterations"])
      .withGadgetOutputLimitPercent(30)
      .withGadgets(...genGadgets);

    genBuilder = configureBuilder(genBuilder, out, flags.rpm, flags.tpm);

    // Inject AU summary so model knows what paths exist
    if (auSummary) {
      genBuilder.withSyntheticGadgetCall(
        "AUListSummary",
        { path: "." },
        auSummary,
        "gc_init_summary"
      );
    }

    const genAgent = genBuilder.ask(orchestratorInitialPrompt);

    // Track progress
    const genTextState = createTextBlockState();
    let docsWritten = 0;

    // Subscribe to generation agent for iteration tracking
    const genTree = genAgent.getTree();
    setupIterationTracking(genTree, {
      out,
      showCumulativeCostEvery: 5,
      onIterationChange: () => endTextBlock(genTextState, out),
    });

    // Run generation agent
    try {
      await runAgentWithEvents(genAgent, {
        out,
        textState: genTextState,
        onGadgetResult: (gadgetName, result) => {
          // Track WriteFile completions
          if (gadgetName === "WriteFile" && result) {
            docsWritten++;
            // Parse bytes from result: "Written: path (123 bytes)"
            const match = result.match(/Written: (.+) \((\d+) bytes\)/);
            if (match) {
              const [, filePath, bytesStr] = match;
              const bytes = parseInt(bytesStr, 10);
              out.documenting(filePath, bytes, true);
            } else {
              out.success(`[${docsWritten}/${totalDocs}] ${result}`);
            }
          }
        },
      });
    } catch (error) {
      // TaskCompletionSignal is expected
      if (error instanceof Error && error.message.includes("Documentation complete")) {
        // This is fine, it means we're done
      } else {
        out.error(`Generation failed: ${error instanceof Error ? error.message : error}`);
        restore();
        process.exit(1);
      }
    }

    // Generate index.mdx for Starlight format
    if (flags.format === "starlight") {
      out.info("Generating Starlight index.mdx...");
      const metadata = await readProjectMetadata();

      // Build section info from plan (use plan descriptions when available)
      const sections = plan.structure.map((dir) => ({
        label: formatLabel(dir.directory),
        description: getSectionDescription(dir.directory, dir.description),
        directory: dir.directory.replace(/\/$/, ""),
        firstDoc: dir.documents[0]?.path.split("/").pop()?.replace(".md", "") || "",
      }));

      const indexContent = render("document/index-mdx", {
        projectName: metadata.name,
        projectDescription: metadata.description,
        repository: metadata.repository,
        firstSection: sections[0]?.directory || "getting-started",
        firstDoc: sections[0]?.firstDoc || "installation",
        sections,
      });

      const indexPath = resolve(targetDir, "index.mdx");
      await writeFile(indexPath, indexContent);
      out.success("Generated index.mdx landing page");
    }

    restore();
    out.success(`Done. Generated ${docsWritten} documentation files in ${targetDir}`);
  }
}
