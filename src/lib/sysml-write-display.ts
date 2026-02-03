/**
 * Shared parse + display functions for SysMLWrite/SysMLCreate gadget results.
 * Used by both ingest (cycle-runner.ts) and validate (validate.ts) commands.
 */

import chalk from "chalk";
import { extractDiffFromResult } from "./diff-utils.js";

export interface ParsedSysMLWriteResult {
  path: string;
  status: string;    // "success" | "unchanged" | "error" | "warning"
  mode: string;      // "upsert" | "create" | "delete" | "reset"
  delta: string | null;
  diff: string | null;
  isError: boolean;
  isNoOp: boolean;
  errorDetails: string | null;
}

/**
 * Parse the structured result string from SysMLWrite/SysMLCreate.
 * Result format: "path=.sysml/foo.sysml status=success mode=upsert delta=+50 bytes\n..."
 */
export function parseSysMLWriteResult(result: string, gadgetName: string): ParsedSysMLWriteResult {
  const pathMatch = result.match(/^path=(\S+)/);
  const statusMatch = result.match(/status=(\w+)/);
  const modeMatch = result.match(/mode=(\w+)/);
  const deltaMatch = result.match(/delta=([+-]?\d+ bytes)/);

  const path = pathMatch ? pathMatch[1] : result.split("\n")[0];
  const status = statusMatch ? statusMatch[1] : "";
  let mode = modeMatch ? modeMatch[1] : "";
  if (!mode && gadgetName === "SysMLCreate") {
    mode = result.includes("Reset package") ? "reset" : "create";
  }
  const delta = deltaMatch ? deltaMatch[1] : null;
  const diff = extractDiffFromResult(result);
  const isError = status === "error";
  const isNoOp = status === "unchanged" || status === "warning";

  let errorDetails: string | null = null;
  if (isError) {
    const lines = result.split("\n").slice(1).join("\n").trim();
    if (lines) {
      errorDetails = lines;
    }
  }

  return { path, status, mode, delta, diff, isError, isNoOp, errorDetails };
}

/**
 * Verbose display: ✓ path [mode] (delta) + colored diff, or ✗ path [error] + details.
 */
export function displaySysMLWriteVerbose(parsed: ParsedSysMLWriteResult): void {
  if (parsed.isError) {
    console.log(chalk.red(`   ✗ ${parsed.path} [error]`));
    if (parsed.errorDetails) {
      console.log(chalk.red(`      ${parsed.errorDetails.split("\n").join("\n      ")}`));
    }
    return;
  }

  const modeStr = parsed.mode === "create" ? chalk.yellow("[new]")
    : parsed.mode === "reset" ? chalk.magenta("[reset]")
    : parsed.mode === "upsert" ? chalk.blue("[set]")
    : parsed.mode === "delete" ? chalk.red("[del]")
    : "";
  const deltaStr = parsed.delta
    ? (parsed.delta.startsWith("-") ? chalk.red(` (${parsed.delta})`) : chalk.dim(` (${parsed.delta})`))
    : "";
  const prefix = parsed.isNoOp ? chalk.yellow("   ⚠️") : chalk.green("   ✓");
  console.log(`${prefix} ${parsed.path} ${modeStr}${deltaStr}`);

  // Display colored diff if available
  if (parsed.diff) {
    const indentedDiff = parsed.diff.split("\n").map((line) => {
      const colored = line.startsWith("- ")
        ? chalk.red(line)
        : line.startsWith("+ ")
          ? chalk.green(line)
          : line.startsWith("  ")
            ? chalk.dim(line)
            : line.startsWith("...")
              ? chalk.dim(line)
              : line;
      return `      ${colored}`;
    }).join("\n");
    console.log(indentedDiff);
  }
}

/**
 * Non-verbose compact display: "  Wrote: path" or "  ⚠️ No change: path" or "  ✗ Error: path".
 */
export function displaySysMLWriteCompact(parsed: ParsedSysMLWriteResult): void {
  if (parsed.isError) {
    console.log(`  ${chalk.red("✗")} Error: ${parsed.path}`);
  } else if (parsed.isNoOp) {
    console.log(`  ${chalk.yellow("⚠️")} No change: ${parsed.path}`);
  } else {
    console.log(`  Wrote: ${parsed.path}`);
  }
}
