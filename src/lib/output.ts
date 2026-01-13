import chalk from "chalk";
import type { ProgressTracker } from "./progress-tracker.js";
import { GadgetName } from "./constants.js";

export interface OutputOptions {
  verbose: boolean;
}

export class Output {
  private verbose: boolean;
  private startTime: number;
  private filesDocumented: number = 0;
  private currentIteration: number = 0;

  // Token and cost tracking
  private totalInputTokens: number = 0;
  private totalOutputTokens: number = 0;
  private totalCost: number = 0;
  private iterationInputTokens: number = 0;
  private iterationOutputTokens: number = 0;
  private iterationCost: number = 0;

  // Line tracking for understanding
  private totalLines: number = 0;
  private linesSinceCheckpoint: number = 0;

  // Progress tracker reference
  private progressTracker?: ProgressTracker;

  constructor(options: OutputOptions) {
    this.verbose = options.verbose;
    this.startTime = Date.now();
  }

  setProgressTracker(tracker: ProgressTracker): void {
    this.progressTracker = tracker;
  }

  // Startup messages
  info(msg: string): void {
    if (this.verbose) {
      console.log(chalk.cyan("●") + " " + chalk.cyan(msg));
    }
  }

  success(msg: string): void {
    console.log(chalk.green("✓") + " " + chalk.green(msg));
  }

  warn(msg: string): void {
    console.log(chalk.yellow("⚠") + " " + chalk.yellow(msg));
  }

  error(msg: string): void {
    console.log(chalk.red("✗") + " " + chalk.red(msg));
  }

  // Section header
  header(title: string): void {
    console.log(chalk.cyan(title));
  }

  // List item (with failure marker)
  item(msg: string): void {
    console.log(chalk.red("  ✗") + " " + msg);
  }

  // Iteration header
  iteration(n: number): void {
    this.currentIteration = n;
    // Reset iteration stats
    this.iterationInputTokens = 0;
    this.iterationOutputTokens = 0;
    this.iterationCost = 0;

    if (this.verbose) {
      console.log();
      console.log(chalk.blue(`━━━ Iteration ${n} ━━━`));
    }
  }

  // Gadget call (starting)
  gadgetCall(name: string, params?: Record<string, unknown>): void {
    if (this.verbose) {
      console.log(chalk.yellow("→") + " " + chalk.yellow(name));

      // Show detailed params for file/dir operations
      if (params) {
        if (name === GadgetName.ReadFiles && typeof params.paths === "string") {
          const paths = (params.paths as string).split("\n").filter(p => p.trim());
          const preview = paths.slice(0, 3).join(", ");
          const more = paths.length > 3 ? ` +${paths.length - 3} more` : "";
          console.log(chalk.dim(`   ${preview}${more}`));
        } else if (name === GadgetName.ReadDirs && typeof params.paths === "string") {
          const depth = params.depth || 2;
          const paths = (params.paths as string).split("\n").filter(p => p.trim());
          console.log(chalk.dim(`   ${paths.join(", ")} (depth: ${depth})`));
        } else if (name === GadgetName.AUUpdate && params.filePath) {
          const path = params.path as string || "";
          const value = params.value;
          let valuePreview = "";
          if (value === null) {
            valuePreview = chalk.red("(delete)");
          } else if (typeof value === "string") {
            valuePreview = this.truncate(value, 50);
          } else if (typeof value === "object") {
            valuePreview = this.truncate(JSON.stringify(value), 50);
          }
          console.log(chalk.dim(`   ${params.filePath}`));
          console.log(chalk.dim(`   ${chalk.cyan(path)} = ${valuePreview}`));
        } else if (name === GadgetName.RipGrep && params.pattern) {
          console.log(chalk.dim(`   pattern: ${params.pattern}`));
          if (params.glob) {
            console.log(chalk.dim(`   glob: ${params.glob}`));
          }
        } else if (name === GadgetName.Finish && params.summary) {
          console.log(chalk.dim(`   ${params.summary}`));
        } else {
          // Generic param display for other gadgets
          const paramStr = this.truncateParams(params);
          if (paramStr !== "{}") {
            console.log(chalk.dim("   " + paramStr));
          }
        }
      }
    }
  }

  // Gadget result (success)
  gadgetResult(name: string, summary?: string): void {
    if (this.verbose) {
      const summaryStr = summary ? " " + chalk.dim(`(${summary})`) : "";
      console.log(chalk.green("✓") + " " + chalk.green(name) + summaryStr);
    }
  }

  // Gadget error
  gadgetError(name: string, error: string): void {
    console.log(chalk.red("✗") + " " + chalk.red(name) + " " + chalk.dim(error));
  }

  // Agent thinking/reasoning text (stream chunk)
  thinkingChunk(text: string): void {
    if (this.verbose) {
      process.stdout.write(chalk.dim(text));
    }
  }

  // End of thinking block (newline)
  thinkingEnd(): void {
    if (this.verbose) {
      console.log();
    }
  }

  // Documenting a file (shown in both modes)
  documenting(filePath: string, lineDiff?: number): void {
    this.filesDocumented++;
    if (lineDiff !== undefined) {
      this.linesSinceCheckpoint += lineDiff;
      this.totalLines += lineDiff;
    }

    // Get progress if tracker is available
    const progressStr = this.progressTracker
      ? ` [${this.progressTracker.getProgressPercent()}%]`
      : "";

    if (this.verbose) {
      let diffStr = "";
      if (lineDiff !== undefined) {
        if (lineDiff > 0) {
          diffStr = " " + chalk.green(`+${lineDiff}`);
        } else if (lineDiff < 0) {
          diffStr = " " + chalk.red(`${lineDiff}`);
        } else {
          diffStr = " " + chalk.dim("±0");
        }
      }
      console.log(
        chalk.green("✓") + " " +
        chalk.white("Documented") + " " +
        chalk.cyan(filePath) +
        diffStr +
        chalk.magenta(progressStr)
      );
    } else {
      console.log("Documenting " + filePath + progressStr);
    }
  }

  // Set initial total lines (from existing .au files)
  setInitialLines(lines: number): void {
    this.totalLines = lines;
  }

  // Iteration stats (tokens and cost)
  iterationStats(inputTokens: number, outputTokens: number, cost: number): void {
    this.iterationInputTokens += inputTokens;
    this.iterationOutputTokens += outputTokens;
    this.iterationCost += cost;

    this.totalInputTokens += inputTokens;
    this.totalOutputTokens += outputTokens;
    this.totalCost += cost;

    if (this.verbose) {
      const tokens = this.formatTokens(inputTokens, outputTokens);
      const costStr = this.formatCost(cost);
      console.log(
        chalk.dim(`   ⤷ ${tokens}`) +
          (cost > 0 ? chalk.dim(` · ${costStr}`) : "")
      );
    }
  }

  // Show cumulative stats (every 10 iterations)
  cumulativeCost(): void {
    if (this.verbose) {
      console.log();
      // Cost line
      console.log(
        chalk.magenta("💰 Cumulative cost: ") +
          chalk.white(this.formatCost(this.totalCost)) +
          chalk.dim(` (${this.formatTokens(this.totalInputTokens, this.totalOutputTokens)})`)
      );
      // Lines line
      const diffStr = this.linesSinceCheckpoint >= 0
        ? chalk.green(`+${this.linesSinceCheckpoint}`)
        : chalk.red(`${this.linesSinceCheckpoint}`);
      console.log(
        chalk.magenta("📝 Understanding: ") +
          chalk.white(`${this.totalLines} lines`) +
          chalk.dim(" (") + diffStr + chalk.dim(" since last checkpoint)")
      );
      // Reset checkpoint counter
      this.linesSinceCheckpoint = 0;
    }
  }

  // Final summary
  summary(): void {
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);

    console.log();
    if (this.verbose) {
      console.log(chalk.blue("━━━ Summary ━━━"));
      console.log(chalk.white(`Files documented: ${this.filesDocumented}`));

      // Add progress/coverage display
      if (this.progressTracker) {
        const counts = this.progressTracker.getCounts();
        const percent = this.progressTracker.getProgressPercent();
        console.log(chalk.white(`Coverage: ${percent}% (${counts.documented}/${counts.total} items)`));
      }

      console.log(chalk.white(`Understanding: ${this.totalLines} lines`));
      console.log(chalk.white(`Iterations: ${this.currentIteration}`));
      console.log(chalk.white(`Time: ${elapsed}s`));
      console.log(
        chalk.white(`Tokens: ${this.formatTokens(this.totalInputTokens, this.totalOutputTokens)}`)
      );
      if (this.totalCost > 0) {
        console.log(chalk.white(`Cost: ${this.formatCost(this.totalCost)}`));
      }
    } else {
      let summary = `Done. Created understanding for ${this.filesDocumented} files in ${elapsed}s.`;

      // Add coverage to non-verbose summary
      if (this.progressTracker) {
        summary += ` Coverage: ${this.progressTracker.getProgressPercent()}%`;
      }

      if (this.totalCost > 0) {
        summary += ` Cost: ${this.formatCost(this.totalCost)}`;
      }
      console.log(summary);
    }
  }

  // Helper to truncate a string for display
  private truncate(str: string, maxLen: number): string {
    // Replace newlines with spaces for display
    const clean = str.replace(/\n/g, " ").trim();
    if (clean.length > maxLen) {
      return clean.slice(0, maxLen) + "...";
    }
    return clean;
  }

  // Helper to truncate params for display
  private truncateParams(params: Record<string, unknown>): string {
    const str = JSON.stringify(params);
    if (str.length > 60) {
      return str.slice(0, 60) + "...";
    }
    return str;
  }

  // Format tokens for display
  private formatTokens(input: number, output: number): string {
    const total = input + output;
    if (total >= 1000) {
      return `${(total / 1000).toFixed(1)}k tokens`;
    }
    return `${total} tokens`;
  }

  // Format cost for display
  private formatCost(cost: number): string {
    if (cost >= 1) {
      return `$${cost.toFixed(2)}`;
    } else if (cost >= 0.01) {
      return `$${cost.toFixed(3)}`;
    } else if (cost > 0) {
      return `$${cost.toFixed(4)}`;
    }
    return "$0.00";
  }
}
