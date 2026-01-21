import { Command, Flags } from "@oclif/core";
import { AgentBuilder, LLMist } from "llmist";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  auRead,
  auList,
  readFiles,
  readDirs,
  ripGrep,
  readDoc,
  reportIssue,
  finishVerification,
  setVerifyTargetDir,
  writeDoc,
  setTargetDir,
  finishFixing,
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
  DocVerifier,
  resetCollectedIssues,
  getCollectedIssues,
  type VerificationIssue,
  type VerificationResult,
} from "../lib/doc-verifier.js";
import type { DocPlanStructure, DocumentOutline } from "../gadgets/doc-gadgets.js";

interface VerificationOutput {
  summary: {
    total: number;
    checked: number;
    passed: number;
    warnings: number;
    errors: number;
    fixed?: number;
  };
  documents: Array<{
    path: string;
    status: "passed" | "warning" | "error" | "missing";
    issues: VerificationIssue[];
  }>;
}

export default class DocumentVerify extends Command {
  static description = "Verify generated documentation against AU understanding and source code";

  static examples = [
    "<%= config.bin %> document-verify --target ./docs",
    "<%= config.bin %> document-verify --target ./docs --deterministic-only",
    "<%= config.bin %> document-verify --target ./docs --document guides/auth.md",
    "<%= config.bin %> document-verify --target ./docs --json",
    "<%= config.bin %> document-verify --target ./docs --model opus",
  ];

  static flags = {
    ...agentFlags,
    target: Flags.string({
      char: "t",
      description: "Target documentation directory",
      required: true,
    }),
    "deterministic-only": Flags.boolean({
      description: "Skip agentic verification, only run deterministic checks",
      default: false,
    }),
    json: Flags.boolean({
      description: "Output results as JSON",
      default: false,
    }),
    document: Flags.string({
      char: "d",
      description: "Verify specific document only (path within target)",
    }),
    iterations: Flags.integer({
      description: "Max iterations for agentic verification",
      default: 15,
    }),
    fix: Flags.boolean({
      description: "Automatically fix issues found during verification",
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
    const { flags } = await this.parse(DocumentVerify);
    const out = new Output({ verbose: flags.verbose, progressLabel: "Verification" });
    const isJson = flags.json;

    const { restore } = withWorkingDirectory(flags.path, out);

    // Load plan from target directory
    const targetDir = resolve(flags.target);
    const planFile = `${targetDir}/.au/doc-plan.json`;

    let plan: DocPlanStructure;
    try {
      const planContent = await readFile(planFile, "utf-8");
      plan = JSON.parse(planContent);
    } catch (error) {
      if (!isJson) {
        out.error(`Failed to load plan from ${planFile}`);
        out.error("Run 'au document --target <dir> --dry-run' first to create a plan");
      } else {
        console.log(JSON.stringify({ error: `Failed to load plan: ${error instanceof Error ? error.message : error}` }));
      }
      restore();
      process.exit(1);
    }

    // Filter to specific document if requested
    if (flags.document) {
      const docPath = flags.document;
      const found = plan.structure.some((dir) =>
        dir.documents.some((doc) => doc.path === docPath)
      );

      if (!found) {
        if (!isJson) {
          out.error(`Document not found in plan: ${docPath}`);
        } else {
          console.log(JSON.stringify({ error: `Document not found in plan: ${docPath}` }));
        }
        restore();
        process.exit(1);
      }

      // Filter plan to only include the specified document
      plan = {
        structure: plan.structure
          .map((dir) => ({
            ...dir,
            documents: dir.documents.filter((doc) => doc.path === docPath),
          }))
          .filter((dir) => dir.documents.length > 0),
      };
    }

    const totalDocs = plan.structure.reduce((sum, dir) => sum + dir.documents.length, 0);

    if (!isJson) {
      out.info(`Verifying ${totalDocs} documents in ${targetDir}`);
    }

    // Phase 1: Deterministic checks
    if (!isJson) {
      out.info("Phase 1: Running deterministic checks...");
    }

    const verifier = new DocVerifier(targetDir, flags.path);
    const deterministicResult = await verifier.runDeterministicChecks(plan);

    // Collect all issues from both phases
    const allIssuesByDoc = new Map<string, VerificationIssue[]>();

    // Add deterministic issues
    for (const docResult of deterministicResult.documents) {
      const existing = allIssuesByDoc.get(docResult.path) || [];
      existing.push(...docResult.issues);
      allIssuesByDoc.set(docResult.path, existing);
    }

    if (!isJson) {
      out.success(
        `Deterministic: ${deterministicResult.passed} passed, ${deterministicResult.warnings} warnings, ${deterministicResult.errors} errors`
      );
    }

    // Phase 2: Agentic verification (unless deterministic-only)
    if (!flags["deterministic-only"]) {
      if (!isJson) {
        out.info("Phase 2: Running agentic verification...");
      }

      // Reset issue collection
      resetCollectedIssues();

      // Set target directory for ReadDoc gadget
      setVerifyTargetDir(targetDir);

      // Flatten documents for the prompt
      const allDocs = plan.structure.flatMap((dir) =>
        dir.documents.map((doc) => ({
          ...doc,
          directory: dir.directory,
        }))
      );

      // Find common validation files
      const commonValidationFiles = new Set<string>();
      for (const doc of allDocs) {
        if (doc.validationFiles) {
          doc.validationFiles.forEach((f) => commonValidationFiles.add(f));
        }
        if (doc.sourcePaths) {
          doc.sourcePaths.forEach((f) => commonValidationFiles.add(f));
        }
      }

      // Render prompts
      const systemPrompt = render("document-verify/system", {});
      const initialPrompt = render("document-verify/initial", {
        documents: allDocs,
        commonValidationFiles: Array.from(commonValidationFiles),
      });

      // Build agent with verification gadgets
      const client = new LLMist();
      const gadgets = [
        readDoc,
        reportIssue,
        finishVerification,
        auRead,
        auList,
        readFiles,
        readDirs,
        ripGrep,
      ];

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
              // Log issue as it's reported
              out.info(result);
            }
          },
        });
      } catch (error) {
        // TaskCompletionSignal is expected
        if (!(error instanceof Error && error.message.includes("Verification complete"))) {
          if (!isJson) {
            out.warn(`Agentic verification stopped: ${error instanceof Error ? error.message : error}`);
          }
        }
      }

      // Merge agentic issues
      const agenticIssues = getCollectedIssues();
      for (const issue of agenticIssues) {
        const existing = allIssuesByDoc.get(issue.documentPath) || [];
        existing.push(issue);
        allIssuesByDoc.set(issue.documentPath, existing);
      }

      if (!isJson) {
        out.success(`Agentic verification found ${agenticIssues.length} additional issues`);
      }
    }

    // Phase 3: Fix issues (if --fix flag is set and not deterministic-only)
    let fixesApplied = 0;
    if (flags.fix && !flags["deterministic-only"]) {
      // Severity ordering for filtering
      const severityOrder: Record<string, number> = { error: 0, warning: 1, info: 2 };
      const minLevel = severityOrder[flags["fix-severity"] || "warning"];

      // Flatten documents from plan
      const allDocs = plan.structure.flatMap((dir) =>
        dir.documents.map((doc) => ({
          ...doc,
          directory: dir.directory,
        }))
      );

      // Build documentsWithIssues array
      const documentsWithIssues: Array<{
        path: string;
        issues: VerificationIssue[];
        validationFiles?: string[];
        mustCoverPaths?: string[];
      }> = [];

      for (const [docPath, issues] of allIssuesByDoc) {
        const fixable = issues.filter((i) => severityOrder[i.severity] <= minLevel);
        if (fixable.length > 0) {
          const meta = allDocs.find((d) => d.path === docPath);
          documentsWithIssues.push({
            path: docPath,
            issues: fixable,
            validationFiles: meta?.validationFiles,
            mustCoverPaths: meta?.mustCoverPaths,
          });
        }
      }

      if (documentsWithIssues.length > 0) {
        if (!isJson) {
          out.info(`Phase 3: Fixing ${documentsWithIssues.length} documents with issues...`);
        }

        // Set target directory for WriteFile gadget
        setTargetDir(targetDir);
        setVerifyTargetDir(targetDir);

        // Render fix prompts
        const fixSystemPrompt = render("document-fix/system", {});
        const fixInitialPrompt = render("document-fix/initial", {
          documentsWithIssues,
        });

        // Build fix agent with gadgets
        const fixClient = new LLMist();
        const fixGadgets = [
          writeDoc,
          finishFixing,
          readDoc,
          auRead,
          auList,
          readFiles,
          readDirs,
          ripGrep,
        ];

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
          out.info("Phase 3: No issues to fix at the specified severity level");
        }
      }
    }

    // Build final output
    const output = buildOutput(plan, allIssuesByDoc, fixesApplied);

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
 * Build the final verification output structure.
 */
function buildOutput(
  plan: DocPlanStructure,
  issuesByDoc: Map<string, VerificationIssue[]>,
  fixesApplied = 0
): VerificationOutput {
  const allDocs = plan.structure.flatMap((dir) =>
    dir.documents.map((doc) => doc.path)
  );

  const documents: VerificationOutput["documents"] = [];
  let passed = 0;
  let warnings = 0;
  let errors = 0;

  for (const docPath of allDocs) {
    const issues = issuesByDoc.get(docPath) || [];
    const docErrors = issues.filter((i) => i.severity === "error");
    const docWarnings = issues.filter((i) => i.severity === "warning");
    const isMissing = issues.some((i) => i.category === "missing" && i.severity === "error");

    let status: "passed" | "warning" | "error" | "missing";
    if (isMissing) {
      status = "missing";
      errors += 1;
    } else if (docErrors.length > 0) {
      status = "error";
      errors += docErrors.length;
    } else if (docWarnings.length > 0) {
      status = "warning";
      warnings += docWarnings.length;
    } else {
      status = "passed";
      passed += 1;
    }

    documents.push({ path: docPath, status, issues });
  }

  const summary: VerificationOutput["summary"] = {
    total: allDocs.length,
    checked: allDocs.length,
    passed,
    warnings,
    errors,
  };

  if (fixesApplied > 0) {
    summary.fixed = fixesApplied;
  }

  return { summary, documents };
}

/**
 * Print verification results to console.
 */
function printResults(out: Output, output: VerificationOutput): void {
  console.log();

  for (const doc of output.documents) {
    const statusIcon =
      doc.status === "passed"
        ? "✓"
        : doc.status === "warning"
          ? "⚠"
          : doc.status === "missing"
            ? "✗"
            : "✗";

    const statusColor =
      doc.status === "passed"
        ? "\x1b[32m" // green
        : doc.status === "warning"
          ? "\x1b[33m" // yellow
          : "\x1b[31m"; // red

    console.log(`${statusColor}━━━ ${statusIcon} ${doc.path} ━━━\x1b[0m`);

    if (doc.issues.length === 0) {
      console.log("  ✓ All checks passed");
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
