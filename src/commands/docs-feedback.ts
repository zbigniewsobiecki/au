import { Command, Flags } from "@oclif/core";
import { AgentBuilder, LLMist } from "llmist";
import { resolve } from "node:path";
import fg from "fast-glob";
import {
  readDoc,
  reportIssue,
  finishFeedback,
  setVerifyTargetDir,
  writeDoc,
  setTargetDir,
  finishFixing,
  sysmlRead,
  sysmlList,
  sysmlQuery,
} from "../gadgets/index.js";
import { Output } from "../lib/output.js";
import { render } from "../lib/templates.js";
import {
  agentFlags,
  configureBuilder,
  createTextBlockState,
  endTextBlock,
  setupIterationTracking,
  withWorkingDirectory,
} from "../lib/command-utils.js";
import { runAgentWithEvents } from "../lib/agent-runner.js";
import {
  resetCollectedIssues,
  getCollectedIssues,
  type VerificationIssue,
} from "../lib/doc-verifier.js";

interface FeedbackOutput {
  summary: {
    total: number;
    reviewed: number;
    passed: number;
    warnings: number;
    errors: number;
    fixed?: number;
  };
  documents: Array<{
    path: string;
    status: "passed" | "warning" | "error";
    issues: VerificationIssue[];
  }>;
}

interface DocumentInfo {
  path: string;
  title: string;
  lines: number;
  directory: string;
  content: string;
}

export default class DocsFeedback extends Command {
  static description = "Review documentation from a new developer's perspective";

  static examples = [
    "<%= config.bin %> docs-feedback --target ./docs",
    "<%= config.bin %> docs-feedback --target ./docs --document guides/getting-started.md",
    "<%= config.bin %> docs-feedback --target ./docs --json",
    "<%= config.bin %> docs-feedback --target ./docs --fix",
    "<%= config.bin %> docs-feedback --target ./docs --fix --fix-severity error",
  ];

  static flags = {
    ...agentFlags,
    target: Flags.string({
      char: "t",
      description: "Target documentation directory",
      required: true,
    }),
    document: Flags.string({
      char: "d",
      description: "Review specific document only (path within target)",
    }),
    json: Flags.boolean({
      description: "Output results as JSON",
      default: false,
    }),
    iterations: Flags.integer({
      description: "Max iterations for feedback phase",
      default: 15,
    }),
    fix: Flags.boolean({
      description: "Automatically fix issues found during feedback",
      default: false,
    }),
    "fix-severity": Flags.string({
      description: "Minimum severity to fix (error, warning, info)",
      default: "warning",
      options: ["error", "warning", "info"],
    }),
    "fix-iterations": Flags.integer({
      description: "Max iterations for fix phase",
      default: 30,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(DocsFeedback);
    const out = new Output({ verbose: flags.verbose, progressLabel: "Feedback" });
    const isJson = flags.json;

    const { restore } = withWorkingDirectory(flags.path, out);

    const targetDir = resolve(flags.target);

    // Scan for markdown files
    let mdFiles = await fg("**/*.md", {
      cwd: targetDir,
      ignore: ["**/node_modules/**", "**/.sysml/**"],
    });

    // Filter to specific document if requested
    if (flags.document) {
      const docPath = flags.document;
      if (!mdFiles.includes(docPath)) {
        if (!isJson) {
          out.error(`Document not found: ${docPath}`);
        } else {
          console.log(JSON.stringify({ error: `Document not found: ${docPath}` }));
        }
        restore();
        process.exit(1);
      }
      mdFiles = [docPath];
    }

    if (mdFiles.length === 0) {
      if (!isJson) {
        out.error(`No markdown files found in ${targetDir}`);
      } else {
        console.log(JSON.stringify({ error: `No markdown files found in ${targetDir}` }));
      }
      restore();
      process.exit(1);
    }

    // Build document info with metadata
    const documents: DocumentInfo[] = await Promise.all(
      mdFiles.map(async (file) => {
        const { readFile } = await import("node:fs/promises");
        const content = await readFile(resolve(targetDir, file), "utf-8");
        const lines = content.split("\n").length;

        // Extract title from frontmatter or first heading
        let title = "Untitled";
        const frontmatterMatch = content.match(/^---\n[\s\S]*?title:\s*["']?([^"'\n]+)["']?[\s\S]*?\n---/);
        if (frontmatterMatch) {
          title = frontmatterMatch[1].trim();
        } else {
          const headingMatch = content.match(/^#\s+(.+)$/m);
          if (headingMatch) {
            title = headingMatch[1].trim();
          }
        }

        // Get directory from path
        const parts = file.split("/");
        const directory = parts.length > 1 ? parts[0] + "/" : "root/";

        return { path: file, title, lines, directory, content };
      })
    );

    if (!isJson) {
      out.info(`Reviewing ${documents.length} documents in ${targetDir}`);
    }

    // Phase 1: Feedback review (agentic)
    if (!isJson) {
      out.info("Phase 1: Reviewing documentation from new developer perspective...");
    }

    // Reset issue collection
    resetCollectedIssues();

    // Set target directory for ReadDoc gadget
    setVerifyTargetDir(targetDir);

    // Render prompts
    const systemPrompt = render("docs-feedback/system", {});
    const initialPrompt = render("docs-feedback/initial", { documents });

    // Build agent with feedback gadgets (no source code access)
    const client = new LLMist();
    const gadgets = [reportIssue, finishFeedback];

    let builder = new AgentBuilder(client)
      .withModel(flags.model)
      .withSystem(systemPrompt)
      .withMaxIterations(flags.iterations)
      .withGadgetOutputLimitPercent(30)
      .withGadgets(...gadgets);

    builder = configureBuilder(builder, out, flags.rpm, flags.tpm);

    const agent = builder.ask(initialPrompt);

    // Track progress
    const textState = createTextBlockState();

    // Set up iteration tracking
    const tree = agent.getTree();
    setupIterationTracking(tree, {
      out,
      onlyInVerbose: isJson,
      showCumulativeCostEvery: 5,
      onIterationChange: () => endTextBlock(textState, out),
    });

    // Run agent
    try {
      await runAgentWithEvents(agent, {
        out,
        textState,
        verbose: !isJson && flags.verbose,
        onGadgetResult: (gadgetName, result) => {
          if (!isJson && gadgetName === "ReportIssue" && result) {
            out.info(result);
          }
        },
      });
    } catch (error) {
      // TaskCompletionSignal is expected
      if (!(error instanceof Error && error.message.includes("Feedback complete"))) {
        if (!isJson) {
          out.warn(`Feedback phase stopped: ${error instanceof Error ? error.message : error}`);
        }
      }
    }

    // Collect issues by document
    const allIssuesByDoc = new Map<string, VerificationIssue[]>();
    const feedbackIssues = getCollectedIssues();
    for (const issue of feedbackIssues) {
      const existing = allIssuesByDoc.get(issue.documentPath) || [];
      existing.push(issue);
      allIssuesByDoc.set(issue.documentPath, existing);
    }

    if (!isJson) {
      out.success(`Feedback review found ${feedbackIssues.length} issues`);
    }

    // Phase 2: Fix issues (if --fix flag is set)
    let fixesApplied = 0;
    if (flags.fix) {
      // Severity ordering for filtering
      const severityOrder: Record<string, number> = { error: 0, warning: 1, info: 2 };
      const minLevel = severityOrder[flags["fix-severity"] || "warning"];

      // Build documentsWithIssues array
      const documentsWithIssues: Array<{
        path: string;
        issues: VerificationIssue[];
      }> = [];

      for (const [docPath, issues] of allIssuesByDoc) {
        const fixable = issues.filter((i) => severityOrder[i.severity] <= minLevel);
        if (fixable.length > 0) {
          documentsWithIssues.push({
            path: docPath,
            issues: fixable,
          });
        }
      }

      if (documentsWithIssues.length > 0) {
        if (!isJson) {
          out.info(`Phase 2: Fixing ${documentsWithIssues.length} documents with issues...`);
        }

        // Set target directory for WriteFile gadget
        setTargetDir(targetDir);
        setVerifyTargetDir(targetDir);

        // Render fix prompts
        const fixSystemPrompt = render("docs-feedback-fix/system", {});
        const fixInitialPrompt = render("docs-feedback-fix/initial", {
          documentsWithIssues,
        });

        // Build fix agent with gadgets (SysML access for accurate fixes)
        const fixClient = new LLMist();
        const fixGadgets = [writeDoc, finishFixing, readDoc, sysmlRead, sysmlList, sysmlQuery];

        let fixBuilder = new AgentBuilder(fixClient)
          .withModel(flags.model)
          .withSystem(fixSystemPrompt)
          .withMaxIterations(flags["fix-iterations"] || 30)
          .withGadgetOutputLimitPercent(30)
          .withGadgets(...fixGadgets);

        fixBuilder = configureBuilder(fixBuilder, out, flags.rpm, flags.tpm);

        const fixAgent = fixBuilder.ask(fixInitialPrompt);

        // Track progress
        const fixTextState = createTextBlockState();

        // Set up iteration tracking
        const fixTree = fixAgent.getTree();
        setupIterationTracking(fixTree, {
          out,
          onlyInVerbose: isJson,
          showCumulativeCostEvery: 5,
          onIterationChange: () => endTextBlock(fixTextState, out),
        });

        // Run fix agent
        try {
          await runAgentWithEvents(fixAgent, {
            out,
            textState: fixTextState,
            verbose: !isJson && flags.verbose,
            onGadgetResult: (gadgetName, result) => {
              if (gadgetName === "WriteFile" && result) {
                fixesApplied++;
                if (!isJson) {
                  out.info(`Fixed: ${result}`);
                }
              }
            },
          });
        } catch (error) {
          // TaskCompletionSignal is expected
          if (!(error instanceof Error && error.message.includes("Fixing complete"))) {
            if (!isJson) {
              out.warn(`Fix phase stopped: ${error instanceof Error ? error.message : error}`);
            }
          }
        }

        if (!isJson) {
          out.success(`Fixed ${fixesApplied} documents`);
        }
      } else {
        if (!isJson) {
          out.info("Phase 2: No issues to fix at the specified severity level");
        }
      }
    }

    // Build final output
    const output = buildOutput(documents, allIssuesByDoc, fixesApplied);

    // Output results
    if (isJson) {
      console.log(JSON.stringify(output, null, 2));
    } else {
      printResults(out, output);
    }

    restore();

    // Exit with error code if there are errors
    if (output.summary.errors > 0) {
      process.exit(1);
    }
  }
}

/**
 * Build the final feedback output structure.
 */
function buildOutput(
  documents: DocumentInfo[],
  issuesByDoc: Map<string, VerificationIssue[]>,
  fixesApplied = 0
): FeedbackOutput {
  const outputDocs: FeedbackOutput["documents"] = [];
  let passed = 0;
  let warnings = 0;
  let errors = 0;

  for (const doc of documents) {
    const issues = issuesByDoc.get(doc.path) || [];
    const docErrors = issues.filter((i) => i.severity === "error");
    const docWarnings = issues.filter((i) => i.severity === "warning");

    let status: "passed" | "warning" | "error";
    if (docErrors.length > 0) {
      status = "error";
      errors += docErrors.length;
    } else if (docWarnings.length > 0) {
      status = "warning";
      warnings += docWarnings.length;
    } else {
      status = "passed";
      passed += 1;
    }

    outputDocs.push({ path: doc.path, status, issues });
  }

  const summary: FeedbackOutput["summary"] = {
    total: documents.length,
    reviewed: documents.length,
    passed,
    warnings,
    errors,
  };

  if (fixesApplied > 0) {
    summary.fixed = fixesApplied;
  }

  return { summary, documents: outputDocs };
}

/**
 * Print feedback results to console.
 */
function printResults(out: Output, output: FeedbackOutput): void {
  console.log();

  for (const doc of output.documents) {
    const statusIcon =
      doc.status === "passed"
        ? "✓"
        : doc.status === "warning"
          ? "⚠"
          : "✗";

    const statusColor =
      doc.status === "passed"
        ? "\x1b[32m" // green
        : doc.status === "warning"
          ? "\x1b[33m" // yellow
          : "\x1b[31m"; // red

    console.log(`${statusColor}━━━ ${statusIcon} ${doc.path} ━━━\x1b[0m`);

    if (doc.issues.length === 0) {
      console.log("  ✓ No issues found");
    } else {
      for (const issue of doc.issues) {
        const severityIcon =
          issue.severity === "error" ? "✗" : issue.severity === "warning" ? "⚠" : "ℹ";
        const severityColor =
          issue.severity === "error"
            ? "\x1b[31m"
            : issue.severity === "warning"
              ? "\x1b[33m"
              : "\x1b[36m";

        console.log(`  ${severityColor}${severityIcon} ${issue.severity.toUpperCase()}\x1b[0m: ${issue.description}`);
        if (issue.suggestion) {
          console.log(`    → ${issue.suggestion}`);
        }
      }
    }
    console.log();
  }

  // Summary
  console.log("━━━ Summary ━━━");
  let summaryLine =
    `Documents: ${output.summary.total} | ` +
    `Passed: \x1b[32m${output.summary.passed}\x1b[0m | ` +
    `Warnings: \x1b[33m${output.summary.warnings}\x1b[0m | ` +
    `Errors: \x1b[31m${output.summary.errors}\x1b[0m`;

  if (output.summary.fixed !== undefined && output.summary.fixed > 0) {
    summaryLine += ` | Fixed: \x1b[36m${output.summary.fixed}\x1b[0m`;
  }

  console.log(summaryLine);
}
