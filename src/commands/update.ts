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
  formatResultSize,
  getPreloadBudget,
  setupIterationTracking,
} from "../lib/command-utils.js";
import { isFileReadingGadget, GadgetName, GlobPatterns } from "../lib/constants.js";
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
import { resolveAuPath } from "../lib/au-paths.js";

export default class Update extends Command {
  static description = "Update AU documentation based on git changes in current branch";

  static examples = [
    "<%= config.bin %> update",
    "<%= config.bin %> update --base develop",
    "<%= config.bin %> update --dry-run",
    "<%= config.bin %> update -v",
  ];

  static flags = {
    ...agentFlags,
    base: Flags.string({
      description: "Base branch to compare against (auto-detects main/master)",
    }),
    "dry-run": Flags.boolean({
      description: "Show what would be updated without making changes",
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Update);
    const out = new Output({ verbose: flags.verbose });

    // Change to target directory if --path specified
    const originalCwd = process.cwd();
    if (flags.path && flags.path !== ".") {
      try {
        process.chdir(flags.path);
        out.info(`Working in: ${flags.path}`);
      } catch {
        out.error(`Cannot access directory: ${flags.path}`);
        process.exit(1);
      }
    }

    // Verify git repo
    if (!(await isGitRepo())) {
      out.error("Not a git repository. Run this command in a git repo.");
      process.chdir(originalCwd);
      process.exit(1);
    }

    // Detect or use specified base branch
    let baseBranch: string;
    try {
      baseBranch = flags.base || (await detectBaseBranch());
      out.info(`Comparing against: ${baseBranch}`);
    } catch (error) {
      out.error(`Failed to detect base branch: ${error instanceof Error ? error.message : error}`);
      process.chdir(originalCwd);
      process.exit(1);
    }

    // Get changed files
    out.info("Detecting changed files...");
    let changedFiles: ChangedFile[];
    try {
      changedFiles = await getChangedFiles(baseBranch);
    } catch (error) {
      out.error(`Failed to get changed files: ${error instanceof Error ? error.message : error}`);
      process.chdir(originalCwd);
      process.exit(1);
    }

    // Filter to source files only
    const sourcePatterns = GlobPatterns.sourceFiles.map((p) => p.replace("**/", ""));
    changedFiles = filterSourceFiles(changedFiles, sourcePatterns);

    if (changedFiles.length === 0) {
      out.success("No source files changed in this branch.");
      process.chdir(originalCwd);
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
    const dependents = findDependents(graph, allChangedPaths);
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
      process.chdir(originalCwd);
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
      process.chdir(originalCwd);
      return;
    }

    // Build the agent
    const client = new LLMist();

    // Get pre-load budget based on model context window
    const budget = getPreloadBudget(client, flags.model);

    // Pre-load changed files for context
    out.info("Pre-loading changed files...");
    const preloadedFiles: string[] = [];
    const preloadedPaths: string[] = [];
    let totalBytes = 0;

    for (const file of [...added, ...modified, ...renamed.map((r) => r.path)]) {
      try {
        const content = await readFile(file, "utf-8");
        const fileSize = content.length;

        // Check per-file limit and total budget
        if (fileSize <= budget.maxPerFileBytes && totalBytes + fileSize <= budget.maxTotalBytes) {
          preloadedFiles.push(`=== ${file} ===\n${content}`);
          preloadedPaths.push(file);
          totalBytes += fileSize;
        }
      } catch {
        // Skip files that can't be read
      }
    }

    const preloadedContent = preloadedFiles.join("\n\n");
    if (preloadedPaths.length > 0) {
      out.success(`Pre-loaded ${preloadedPaths.length} files (${(preloadedContent.length / 1024).toFixed(1)} KB)`);
    }

    const systemPrompt = render("update/system", {});
    const initialPrompt = render("update/initial", {
      baseBranch,
      added,
      modified,
      deleted,
      renamed,
      dependents,
      dependentsContext,
    });

    let builder = new AgentBuilder(client)
      .withModel(flags.model)
      .withSystem(systemPrompt)
      .withMaxIterations(flags["max-iterations"])
      .withGadgets(auUpdate, auRead, auList, readFiles, readDirs, ripGrep, finish, gitDiffList, gitDiff);

    builder = configureBuilder(builder, out, flags.rpm, flags.tpm);

    // Inject pre-loaded files as synthetic gadget call
    if (preloadedPaths.length > 0) {
      builder.withSyntheticGadgetCall(
        "ReadFiles",
        { paths: preloadedPaths.join("\n") },
        preloadedContent,
        "gc_init_1"
      );
    }

    // Pre-inject GitDiffList so agent knows what changed
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
    const diffListContent = `Changed files (${changedFiles.length}):\n${diffListLines.join("\n")}`;
    builder.withSyntheticGadgetCall(
      "GitDiffList",
      { baseBranch },
      diffListContent,
      "gc_init_2"
    );

    // Note: We don't pre-inject AUList here to save context space.
    // The agent can call AUList on-demand if needed.

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
      for await (const event of agent.run()) {
        if (event.type === "text") {
          textState.inTextBlock = true;
          out.thinkingChunk(event.content);
        } else if (event.type === "gadget_call") {
          endTextBlock(textState, out);
          const params = event.call.parameters as Record<string, unknown>;
          out.gadgetCall(event.call.gadgetName, params);
        } else if (event.type === "gadget_result") {
          const result = event.result;

          if (result.error) {
            out.gadgetError(result.gadgetName, result.error);
          } else {
            let summary: string | undefined;
            if (isFileReadingGadget(result.gadgetName)) {
              summary = formatResultSize(result.result);
            }

            out.gadgetResult(result.gadgetName, summary);

            // Log AUUpdate results
            if (result.gadgetName === GadgetName.AUUpdate) {
              if (result.result?.startsWith("Error:")) {
                out.warn(result.result);
              } else {
                out.success(`  ${result.result}`);
              }
            }
          }
        }
      }

      endTextBlock(textState, out);
    } catch (error) {
      endTextBlock(textState, out);
      out.error(`Agent error: ${error instanceof Error ? error.message : error}`);
      process.chdir(originalCwd);
      process.exit(1);
    } finally {
      process.chdir(originalCwd);
    }

    out.success("Update complete.");
  }
}
