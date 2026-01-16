import { Command, Flags } from "@oclif/core";
import { AgentBuilder, LLMist } from "llmist";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  auUpdate,
  auRead,
  auList,
  readFiles,
  readDirs,
  ripGrep,
  finish,
  gitDiffList,
  gitDiff,
} from "../gadgets/index.js";
import { Output } from "../lib/output.js";
import { render } from "../lib/templates.js";
import {
  agentFlags,
  configureBuilder,
  createTextBlockState,
  endTextBlock,
  getPreloadBudget,
  setupIterationTracking,
  withWorkingDirectory,
  preloadFiles,
} from "../lib/command-utils.js";
import { runAgentWithEvents } from "../lib/agent-runner.js";
import { GadgetName, GlobPatterns } from "../lib/constants.js";
import {
  isGitRepo,
  detectBaseBranch,
  getChangedFiles,
  filterSourceFiles,
  ChangedFile,
} from "../lib/git-utils.js";
import {
  buildDependencyGraph,
  findDependents,
  formatDependentsForContext,
} from "../lib/dependency-graph.js";
import { resolveAuPath, getSourceFromAuPath } from "../lib/au-paths.js";
import { Validator } from "../lib/validator.js";

export default class Update extends Command {
  static description = "Update AU documentation based on stale/missing files or git changes";

  static examples = [
    "<%= config.bin %> update",
    "<%= config.bin %> update --base develop",
    "<%= config.bin %> update --dry-run",
    "<%= config.bin %> update -v",
  ];

  static flags = {
    ...agentFlags,
    base: Flags.string({
      description: "Base branch for git-based comparison (without this, uses hash-based staleness detection)",
    }),
    "dry-run": Flags.boolean({
      description: "Show what would be updated without making changes",
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Update);
    const out = new Output({ verbose: flags.verbose });

    const { restore } = withWorkingDirectory(flags.path, out);

    // Determine mode: hash-based (no --base) vs git-based (--base provided)
    const isHashBasedMode = !flags.base;

    // Common variables for both modes
    let systemPrompt: string;
    let initialPrompt: string;
    let preloadedContent: string = "";
    let preloadedPaths: string[] = [];
    let useGitGadgets = false;
    let dependents: string[] = [];

    // Variables for synthetic gadget calls
    let gitDiffListContent: string | undefined;
    let baseBranch: string | undefined;
    let existingAuContent: string | undefined;
    let existingAuPaths: string[] = [];

    if (isHashBasedMode) {
      // ========================================
      // HASH-BASED MODE (no --base flag)
      // ========================================
      out.info("Scanning for stale and missing AU files...");

      const validator = new Validator();
      const result = await validator.validate(".");

      // stale: AU files with hash mismatch (source changed) - convert to source paths
      const stale = result.stale.map((auPath) => getSourceFromAuPath(auPath));

      // missing: source files without AU files (files only, not dirs)
      const missing = result.uncovered.filter((p) => !p.endsWith("/"));

      if (stale.length === 0 && missing.length === 0) {
        out.success("All AU files are up to date.");
        restore();
        return;
      }

      out.info(`Found ${stale.length + missing.length} files needing updates:`);
      if (stale.length > 0) out.info(`  ~ ${stale.length} stale (source changed)`);
      if (missing.length > 0) out.info(`  + ${missing.length} missing (no AU file)`);

      // Build dependency graph and find dependents
      out.info("Building dependency graph...");
      const graph = await buildDependencyGraph(".");
      const allChangedPaths = [...stale, ...missing];
      dependents = findDependents(graph, allChangedPaths);
      const dependentsContext = formatDependentsForContext(graph, allChangedPaths);

      if (dependents.length > 0) {
        out.info(`Found ${dependents.length} dependent files that may need updates`);
      }

      // Handle dry-run mode
      if (flags["dry-run"]) {
        out.header("Dry Run - Would Update:");
        console.log();
        if (stale.length > 0) {
          console.log("Update stale .au files for:");
          for (const file of stale) console.log(`  ~ ${file}`);
        }
        if (missing.length > 0) {
          console.log("Create .au files for:");
          for (const file of missing) console.log(`  + ${file}`);
        }
        if (dependents.length > 0) {
          console.log("Potentially update dependents:");
          for (const dep of dependents) console.log(`  ? ${dep}`);
        }
        restore();
        return;
      }

      // Build the agent
      const client = new LLMist();
      const budget = getPreloadBudget(client, flags.model);

      // Pre-load source files for context
      out.info("Pre-loading source files...");
      const preloaded = await preloadFiles([...stale, ...missing], budget);
      preloadedContent = preloaded.content;
      preloadedPaths = preloaded.paths;
      if (preloadedPaths.length > 0) {
        out.success(`Pre-loaded ${preloadedPaths.length} files (${(preloadedContent.length / 1024).toFixed(1)} KB)`);
      }

      // Pre-load existing AU content for stale files
      if (stale.length > 0) {
        const auContents: string[] = [];
        for (const file of stale) {
          const auPath = resolveAuPath(file);
          try {
            const content = await readFile(auPath, "utf-8");
            auContents.push(`=== ${file} ===\n${content}`);
            existingAuPaths.push(file);
          } catch {
            // Skip files that can't be read
          }
        }
        if (auContents.length > 0) {
          existingAuContent = auContents.join("\n\n");
        }
      }

      systemPrompt = render("update/system-stale", {});
      initialPrompt = render("update/initial-stale", {
        stale,
        missing,
        dependents,
        dependentsContext,
      });

      useGitGadgets = false;
    } else {
      // ========================================
      // GIT-BASED MODE (--base flag provided)
      // ========================================

      // Verify git repo
      if (!(await isGitRepo())) {
        out.error("Not a git repository. Run this command in a git repo.");
        restore();
        process.exit(1);
      }

      // Use specified base branch (we know it's defined since isHashBasedMode is false)
      baseBranch = flags.base!;
      out.info(`Comparing against: ${baseBranch}`);

      // Get changed files
      out.info("Detecting changed files...");
      let changedFiles: ChangedFile[];
      try {
        changedFiles = await getChangedFiles(baseBranch);
      } catch (error) {
        out.error(`Failed to get changed files: ${error instanceof Error ? error.message : error}`);
        restore();
        process.exit(1);
      }

      // Filter to source files only
      const sourcePatterns = GlobPatterns.sourceFiles.map((p) => p.replace("**/", ""));
      changedFiles = filterSourceFiles(changedFiles, sourcePatterns);

      if (changedFiles.length === 0) {
        out.success("No source files changed in this branch.");
        restore();
        return;
      }

      // Categorize changes
      const added = changedFiles.filter((f) => f.status === "A").map((f) => f.path);
      const modified = changedFiles.filter((f) => f.status === "M").map((f) => f.path);
      const deleted = changedFiles.filter((f) => f.status === "D").map((f) => f.path);
      const renamed = changedFiles.filter((f) => f.status === "R");

      out.info(`Found ${changedFiles.length} changed source files:`);
      if (added.length > 0) out.info(`  + ${added.length} added`);
      if (modified.length > 0) out.info(`  ~ ${modified.length} modified`);
      if (deleted.length > 0) out.info(`  - ${deleted.length} deleted`);
      if (renamed.length > 0) out.info(`  → ${renamed.length} renamed`);

      // Build dependency graph
      out.info("Building dependency graph...");
      const graph = await buildDependencyGraph(".");
      const allChangedPaths = [...added, ...modified, ...deleted, ...renamed.map((r) => r.path)];
      dependents = findDependents(graph, allChangedPaths);
      const dependentsContext = formatDependentsForContext(graph, allChangedPaths);

      if (dependents.length > 0) {
        out.info(`Found ${dependents.length} dependent files that may need updates`);
      }

      // Handle dry-run mode
      if (flags["dry-run"]) {
        out.header("Dry Run - Would Update:");
        console.log();
        if (added.length > 0) {
          console.log("Create .au files for:");
          for (const file of added) console.log(`  + ${file}`);
        }
        if (modified.length > 0) {
          console.log("Update .au files for:");
          for (const file of modified) console.log(`  ~ ${file}`);
        }
        if (deleted.length > 0) {
          console.log("Delete .au files for:");
          for (const file of deleted) console.log(`  - ${file}`);
        }
        if (renamed.length > 0) {
          console.log("Handle renamed files:");
          for (const file of renamed) console.log(`  → ${file.oldPath} → ${file.path}`);
        }
        if (dependents.length > 0) {
          console.log("Potentially update dependents:");
          for (const dep of dependents) console.log(`  ? ${dep}`);
        }
        restore();
        return;
      }

      // Handle deletions first (non-agentic)
      if (deleted.length > 0) {
        out.info("Removing .au files for deleted sources...");
        for (const file of deleted) {
          const auPath = resolveAuPath(file);
          try {
            await unlink(auPath);
            out.success(`Deleted: ${auPath}`);
          } catch {
            // File doesn't exist, that's fine
          }
        }
      }

      // Handle renames - delete old .au files
      if (renamed.length > 0) {
        out.info("Removing old .au files for renamed sources...");
        for (const file of renamed) {
          if (file.oldPath) {
            const oldAuPath = resolveAuPath(file.oldPath);
            try {
              await unlink(oldAuPath);
              out.success(`Deleted old: ${oldAuPath}`);
            } catch {
              // File doesn't exist, that's fine
            }
          }
        }
      }

      // If only deletions, we're done
      const needsAgent = added.length > 0 || modified.length > 0 || renamed.length > 0 || dependents.length > 0;
      if (!needsAgent) {
        out.success("All updates complete (only deletions).");
        restore();
        return;
      }

      // Build the agent
      const client = new LLMist();
      const budget = getPreloadBudget(client, flags.model);

      // Pre-load changed files for context
      out.info("Pre-loading changed files...");
      const filesToPreload = [...added, ...modified, ...renamed.map((r) => r.path)];
      const preloaded = await preloadFiles(filesToPreload, budget);
      preloadedContent = preloaded.content;
      preloadedPaths = preloaded.paths;
      if (preloadedPaths.length > 0) {
        out.success(`Pre-loaded ${preloadedPaths.length} files (${(preloadedContent.length / 1024).toFixed(1)} KB)`);
      }

      // Prepare GitDiffList content for synthetic call
      const statusLabels: Record<string, string> = {
        A: "added",
        M: "modified",
        D: "deleted",
        R: "renamed",
      };
      const diffListLines = changedFiles.map((f) => {
        const status = statusLabels[f.status] || f.status;
        if (f.status === "R" && f.oldPath) {
          return `${status}: ${f.oldPath} -> ${f.path}`;
        }
        return `${status}: ${f.path}`;
      });
      gitDiffListContent = `Changed files (${changedFiles.length}):\n${diffListLines.join("\n")}`;

      systemPrompt = render("update/system", {});
      initialPrompt = render("update/initial", {
        baseBranch,
        added,
        modified,
        deleted,
        renamed,
        dependents,
        dependentsContext,
      });

      useGitGadgets = true;
    }

    // ========================================
    // COMMON AGENT SETUP AND EXECUTION
    // ========================================
    const client = new LLMist();

    let builder = new AgentBuilder(client)
      .withModel(flags.model)
      .withSystem(systemPrompt)
      .withMaxIterations(flags["max-iterations"]);

    // Add gadgets based on mode
    if (useGitGadgets) {
      builder = builder.withGadgets(auUpdate, auRead, auList, readFiles, readDirs, ripGrep, finish, gitDiffList, gitDiff);
    } else {
      builder = builder.withGadgets(auUpdate, auRead, auList, readFiles, readDirs, ripGrep, finish);
    }

    builder = configureBuilder(builder, out, flags.rpm, flags.tpm);

    // Inject pre-loaded source files as synthetic gadget call
    if (preloadedPaths.length > 0) {
      builder.withSyntheticGadgetCall(
        "ReadFiles",
        { paths: preloadedPaths.join("\n") },
        preloadedContent,
        "gc_init_1"
      );
    }

    // For git-based mode, pre-inject GitDiffList
    if (useGitGadgets && gitDiffListContent && baseBranch) {
      builder.withSyntheticGadgetCall(
        "GitDiffList",
        { baseBranch },
        gitDiffListContent,
        "gc_init_2"
      );
    }

    // For hash-based mode, pre-inject existing AU content for stale files
    if (!useGitGadgets && existingAuContent && existingAuPaths.length > 0) {
      builder.withSyntheticGadgetCall(
        "AURead",
        { paths: existingAuPaths.join("\n") },
        existingAuContent,
        "gc_init_existing_au"
      );
    }

    // Create and run the agent
    const agent = builder.ask(initialPrompt);

    out.info("Starting update analysis...");

    // Track text block state
    const textState = createTextBlockState();

    // Subscribe to ExecutionTree for iteration tracking
    const tree = agent.getTree();
    setupIterationTracking(tree, {
      out,
      showCumulativeCostEvery: 5,
      onIterationChange: () => endTextBlock(textState, out),
    });

    // Run and stream events from the agent
    try {
      await runAgentWithEvents(agent, {
        out,
        textState,
        onGadgetResult: (gadgetName, result) => {
          // Log AUUpdate results
          if (gadgetName === GadgetName.AUUpdate) {
            if (result?.startsWith("Error:")) {
              out.warn(result);
            } else {
              out.success(`  ${result}`);
            }
          }
        },
      });
    } catch (error) {
      out.error(`Agent error: ${error instanceof Error ? error.message : error}`);
      restore();
      process.exit(1);
    } finally {
      restore();
    }

    out.success("Update complete.");
  }
}
