import chalk from "chalk";
import { GadgetName } from "./constants.js";

export interface OutputOptions {
  verbose: boolean;
  progressLabel?: string;  // Default: "Understanding"
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

  // Byte tracking for understanding
  private totalBytes: number = 0;
  private bytesSinceCheckpoint: number = 0;

  // Configurable label for progress display
  private progressLabel: string;

  constructor(options: OutputOptions) {
    this.verbose = options.verbose;
    this.progressLabel = options.progressLabel || "Understanding";
    this.startTime = Date.now();
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
        // Always show reason first if present
        if (typeof params.reason === "string" && params.reason.trim()) {
          console.log(chalk.cyan(`   ${params.reason}`));
        }

        if (name === GadgetName.ReadFiles && typeof params.paths === "string") {
          const paths = (params.paths as string).split("\n").filter(p => p.trim());
          const preview = paths.slice(0, 3).join(", ");
          const more = paths.length > 3 ? ` +${paths.length - 3} more` : "";
          console.log(chalk.dim(`   ${preview}${more}`));
        } else if (name === GadgetName.ReadDirs && typeof params.paths === "string") {
          const depth = params.depth || 2;
          const paths = (params.paths as string).split("\n").filter(p => p.trim());
          console.log(chalk.dim(`   ${paths.join(", ")} (depth: ${depth})`));
        } else if (name === GadgetName.RipGrep && params.pattern) {
          console.log(chalk.dim(`   pattern: ${params.pattern}`));
          if (params.glob) {
            console.log(chalk.dim(`   glob: ${params.glob}`));
          }
        } else if (name === GadgetName.Finish && params.summary) {
          console.log(chalk.dim(`   ${params.summary}`));
        } else {
          // Generic param display for other gadgets (excluding reason which is shown above)
          const { reason: _reason, ...otherParams } = params;
          const paramStr = this.truncateParams(otherParams);
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
  documenting(filePath: string, byteDiff?: number, isNew?: boolean): void {
    this.filesDocumented++;
    if (byteDiff !== undefined) {
      this.bytesSinceCheckpoint += byteDiff;
      this.totalBytes += byteDiff;
    }

    const progressStr = "";

    if (this.verbose) {
      let diffStr = "";
      if (byteDiff !== undefined) {
        if (byteDiff > 0) {
          diffStr = " " + chalk.green(`+${byteDiff}B`);
        } else if (byteDiff < 0) {
          diffStr = " " + chalk.red(`${byteDiff}B`);
        } else {
          diffStr = " " + chalk.dim("±0B");
        }
      }
      const marker = isNew !== undefined ? (isNew ? chalk.yellow(" [new]") : chalk.blue(" [upd]")) : "";
      console.log(
        chalk.green("✓") + " " +
        chalk.white("Documented") + " " +
        chalk.cyan(filePath) +
        marker +
        diffStr +
        chalk.magenta(progressStr)
      );
    } else {
      console.log("Documenting " + filePath + progressStr);
    }
  }

  // Set initial total bytes (from existing model files)
  setInitialBytes(bytes: number): void {
    this.totalBytes = bytes;
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
      // Bytes line
      const diffStr = this.bytesSinceCheckpoint >= 0
        ? chalk.green(`+${this.bytesSinceCheckpoint}B`)
        : chalk.red(`${this.bytesSinceCheckpoint}B`);
      console.log(
        chalk.magenta(`📝 ${this.progressLabel}: `) +
          chalk.white(this.formatBytes(this.totalBytes)) +
          chalk.dim(" (") + diffStr + chalk.dim(" since last checkpoint)")
      );
      // Reset checkpoint counter
      this.bytesSinceCheckpoint = 0;
    }
  }

  // Final summary
  summary(): void {
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);

    console.log();
    if (this.verbose) {
      console.log(chalk.blue("━━━ Summary ━━━"));
      console.log(chalk.white(`Files documented: ${this.filesDocumented}`));
      console.log(chalk.white(`${this.progressLabel}: ${this.formatBytes(this.totalBytes)}`));
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

  // Format bytes for display
  private formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024) {
      return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
    } else if (bytes >= 1024) {
      return `${(bytes / 1024).toFixed(1)}KB`;
    }
    return `${bytes}B`;
  }
}
