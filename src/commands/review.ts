import { Command, Flags } from "@oclif/core";
import { AgentBuilder, LLMist } from "llmist";
import {
  auUpdate,
  auRead,
  auList,
  readFiles,
  finish,
} from "../gadgets/index.js";
import { REVIEW_SYSTEM_PROMPT, REVIEW_INITIAL_PROMPT } from "../lib/review-system-prompt.js";
import { Output } from "../lib/output.js";
import { ReviewTracker } from "../lib/review-tracker.js";
import { render } from "../lib/templates.js";
import {
  agentFlags,
  configureBuilder,
  createTextBlockState,
  endTextBlock,
  formatResultSize,
  setupIterationTracking,
} from "../lib/command-utils.js";
import { GadgetName, AU_SEPARATOR, hasNoExisting } from "../lib/constants.js";

export default class Review extends Command {
  static description = "Review and validate agent understanding files for accuracy";

  static examples = [
    "<%= config.bin %> review",
    "<%= config.bin %> review --model sonnet",
    "<%= config.bin %> review --max-iterations 30",
    "<%= config.bin %> review -v",
  ];

  static flags = {
    ...agentFlags,
    "max-iterations": Flags.integer({
      char: "i",
      description: "Maximum agent iterations",
      default: 30,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Review);
    const out = new Output({ verbose: flags.verbose });

    const client = new LLMist();

    // Get list of existing .au files
    out.info("Scanning existing understanding files...");
    const existingAu = await auList.execute({ path: flags.path });

    const existingContent = existingAu as string;
    if (hasNoExisting(existingContent)) {
      out.warn("No .au files found. Run 'au ingest' first.");
      return;
    }

    const auFileCount = existingContent.split(AU_SEPARATOR).length - 1;
    out.success(`Found ${auFileCount} understanding files`);

    // Initialize review tracker
    out.info("Checking for issues...");
    const reviewTracker = new ReviewTracker();
    await reviewTracker.scan(flags.path);

    const issueCount = reviewTracker.getIssueCount();
    if (issueCount > 0) {
      out.warn(`Found ${issueCount} files with potential issues`);
      const breakdown = reviewTracker.getIssueBreakdownStrings();
      for (const line of breakdown.slice(0, 5)) {
        out.info(`  - ${line}`);
      }
    } else {
      out.success("All files have required fields. Will verify accuracy against source.");
    }

    // Build the agent
    let builder = new AgentBuilder(client)
      .withModel(flags.model)
      .withSystem(REVIEW_SYSTEM_PROMPT)
      .withMaxIterations(flags["max-iterations"])
      .withGadgets(auUpdate, auRead, auList, readFiles, finish)
      .withTextOnlyHandler("acknowledge");

    builder = configureBuilder(builder, out, flags.rpm, flags.tpm)
      .withTrailingMessage((ctx) => {
        return render("review/trailing", {
          iteration: ctx.iteration + 1,
          maxIterations: ctx.maxIterations,
          totalAuFiles: auFileCount,
          issueCount: reviewTracker.getIssueCount(),
          issueBreakdown: reviewTracker.getIssueBreakdownStrings(),
          nextFiles: reviewTracker.getNextFiles(5),
        });
      });

    // Inject the list of .au files as initial context
    builder.withSyntheticGadgetCall(
      "AUList",
      { path: flags.path },
      existingAu as string,
      "gc_init_1"
    );

    // Create and run the agent
    const agent = builder.ask(REVIEW_INITIAL_PROMPT);

    out.info("Starting review...");

    // Track state
    const textState = createTextBlockState();
    let issuesFixed = 0;

    // Subscribe to ExecutionTree for iteration tracking
    const tree = agent.getTree();
    setupIterationTracking(tree, {
      out,
      onIterationChange: () => endTextBlock(textState, out),
    });

    // Run and stream events
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
            if (result.gadgetName === GadgetName.ReadFiles) {
              summary = formatResultSize(result.result);
            }

            out.gadgetResult(result.gadgetName, summary);

            // Track AUUpdate calls as fixes
            if (result.gadgetName === GadgetName.AUUpdate) {
              if (result.result?.startsWith("Error:")) {
                out.warn(result.result);
              } else {
                issuesFixed++;
                const match = result.result?.match(/Updated understanding at (.+?)\.au/);
                if (match) {
                  const filePath = match[1].replace(/\/$/, "");
                  reviewTracker.markReviewed(filePath);
                  out.success(`Fixed: ${filePath}`);
                }
              }
            }
          }
        }
      }

      endTextBlock(textState, out);
    } catch (error) {
      endTextBlock(textState, out);
      out.error(`Agent error: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }

    // Summary
    console.log("\n" + "═".repeat(50));
    console.log(`Review complete: ${issuesFixed} issues fixed`);
    const remainingIssues = reviewTracker.getIssueCount();
    if (remainingIssues > 0) {
      console.log(`Remaining issues: ${remainingIssues} files still need attention`);
    }
    out.summary();
  }
}
