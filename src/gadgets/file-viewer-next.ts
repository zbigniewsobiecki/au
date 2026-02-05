import { createGadget, z } from "llmist";
import { readFile } from "node:fs/promises";
import { parsePathList } from "../lib/command-utils.js";
import { createFileFilter } from "../lib/file-filter.js";
import {
  checkCycleCoverage,
  formatCoverageResult,
  type CoverageContext,
} from "../lib/sysml/index.js";
import { validateModelFull } from "../lib/sysml/sysml2-cli.js";
import { GADGET_REASON_DESCRIPTION } from "../lib/constants.js";

/**
 * Coverage context for the FileViewerNextFileSet gadget.
 * When set, the gadget validates coverage before allowing completion.
 */
let coverageContext: CoverageContext | null = null;

/**
 * Set the coverage context for the FileViewerNextFileSet gadget.
 * Call this before running a cycle to enable coverage validation.
 */
export function setCoverageContext(context: CoverageContext | null): void {
  coverageContext = context;
}

/**
 * Get the current coverage context.
 */
export function getCoverageContext(): CoverageContext | null {
  return coverageContext;
}

/**
 * Stall state shared with cycle-runner.
 * When set, the gadget injects uncovered files into the agent's file selection.
 */
let stallState: {
  writesWithoutIncrease: number;
  missingFiles: string[];
  coveragePercent?: number;
} | null = null;

/**
 * Set the stall state for uncovered-file injection.
 * Call from cycle-runner to make stall info visible to the gadget.
 */
export function setStallState(state: typeof stallState): void {
  stallState = state;
}

/**
 * Whether validation enforcement is enabled.
 * When true, requesting new files is blocked while validation errors exist.
 */
let validationEnforcementEnabled = false;

/**
 * Enable or disable validation enforcement for new file requests.
 */
export function setValidationEnforcement(enabled: boolean): void {
  validationEnforcementEnabled = enabled;
}

export const fileViewerNextFileSet = createGadget({
  name: "FileViewerNextFileSet",
  description: `Select the next batch of files and read their contents in one step.
Call EXACTLY ONCE per turn.
Pass file paths as a newline-separated string.
Pass an empty string when all documentation is complete.
Returns file contents directly — no need for a separate ReadFiles call.

Example:
  paths="src/index.ts
src/lib/utils.ts
package.json"
  paths=""  // Done - no more files to view

**IMPORTANT**: When you pass paths="", the system will verify that all expected
source files have been covered with \`// Source:\` comments. If coverage is
incomplete, you'll receive an error listing the missing files.`,
  schema: z.object({
    reason: z.string().describe(GADGET_REASON_DESCRIPTION),
    paths: z.string().default("").describe("File paths to view next, one per line. Empty string when done."),
  }),
  execute: async ({ reason, paths }) => {
    const pathList = parsePathList(paths);

    // When stalled, inject uncovered files into the agent's file selection
    let injectedFiles: string[] = [];
    let injectionStallCount = 0;
    let injectionCoveragePct = 0;
    if (stallState && pathList.length > 0 && stallState.missingFiles.length > 0) {
      injectionStallCount = stallState.writesWithoutIncrease;
      injectionCoveragePct = stallState.coveragePercent ?? 0;
      if (stallState.writesWithoutIncrease >= 6) {
        // Hard override: replace ALL agent paths with uncovered files
        injectedFiles = stallState.missingFiles.slice(0, pathList.length);
        stallState.missingFiles.splice(0, injectedFiles.length);
        console.log(`\x1b[33m   ⚡ Stall override (x${stallState.writesWithoutIncrease}): replacing all ${pathList.length} paths with ${injectedFiles.length} uncovered files\x1b[0m`);
        pathList.length = 0;
        pathList.push(...injectedFiles);
      } else if (stallState.writesWithoutIncrease >= 1) {
        // Soft inject: replace half the agent paths with uncovered files
        const halfCount = Math.ceil(pathList.length / 2);
        injectedFiles = stallState.missingFiles.slice(0, halfCount);
        stallState.missingFiles.splice(0, injectedFiles.length);
        console.log(`\x1b[33m   ⚡ Stall inject (x${stallState.writesWithoutIncrease}): replacing ${halfCount} of ${pathList.length} paths with ${injectedFiles.length} uncovered files\x1b[0m`);
        pathList.splice(0, halfCount, ...injectedFiles);
      }
    }

    if (pathList.length === 0) {
      // LLM is signaling completion - validate coverage if context is set
      if (coverageContext) {
        const { cycle, basePath, minCoveragePercent = 80, readFiles } = coverageContext;

        const coverage = await checkCycleCoverage(cycle, basePath, readFiles);

        if (coverage.missingFiles.length > 0 && coverage.coveragePercent < minCoveragePercent) {
          // Coverage is incomplete - reject completion and list missing files
          const header = `ERROR: Cannot complete cycle ${cycle} - coverage too low (${coverage.coveragePercent}% < ${minCoveragePercent}% threshold)`;
          const details = formatCoverageResult(coverage);
          const instructions = `
You MUST cover the missing files before completing this cycle:
1. Use ReadFiles to read the missing files listed above
2. Add SysML definitions with \`// Source: <filepath>\` comments
3. Then call FileViewerNextFileSet(paths="") again

The missing files MUST be documented before you can finish.`;

          return `${header}\n\n${details}\n${instructions}`;
        }
      }

      return "DONE: No more files requested.";
    }

    // Block new file requests while syntax errors exist (semantic errors are non-blocking)
    if (validationEnforcementEnabled) {
      try {
        const validation = await validateModelFull(".sysml");
        if (validation.exitCode === 1) {
          return `ERROR: Cannot request new files while syntax errors exist.

Fix all syntax errors first, then request new file batches.
Use SysMLRead to examine files with errors and SysMLWrite to fix them.
Validation re-runs automatically after each write.`;
        }
      } catch {
        // sysml2 not available - allow the request
      }
    }

    // Read file contents (same logic as ReadFiles gadget)
    const filter = await createFileFilter();
    const fileContents: string[] = [];

    for (const filePath of pathList) {
      if (!filter.accepts(filePath)) {
        continue;
      }
      try {
        const content = await readFile(filePath, "utf-8");
        fileContents.push(`=== ${filePath} ===\n${content}`);
      } catch (error) {
        fileContents.push(`=== ${filePath} ===\nError reading file: ${error}`);
      }
    }

    // Build directive for injected files
    let directive = "";
    if (injectedFiles.length > 0) {
      const fileList = injectedFiles.map(f => `- ${f}`).join("\n");
      if (injectionStallCount >= 6) {
        directive = `⚡ COVERAGE STALL — MANDATORY COVERAGE REQUIRED
The following ${injectedFiles.length} files were injected because coverage is stalled at ${injectionCoveragePct}%.
You MUST create @SourceFile annotations for EACH of them:
${fileList}
Do NOT rewrite existing definitions. ONLY write new elements for these uncovered files.
ALL paths in this batch are uncovered — document every single one.

`;
      } else if (injectionStallCount >= 3) {
        directive = `⚡ COVERAGE STALL — MANDATORY COVERAGE REQUIRED
The following ${injectedFiles.length} files were injected because coverage is stalled at ${injectionCoveragePct}%.
You MUST create @SourceFile annotations for EACH of them:
${fileList}
Do NOT rewrite existing definitions. ONLY write new elements for these uncovered files.

`;
      } else {
        directive = `⚡ COVERAGE STALL — These ${injectedFiles.length} files were injected because coverage is stalled at ${injectionCoveragePct}%.
You MUST create @SourceFile annotations for EACH of them:
${fileList}
Do NOT rewrite existing definitions. ONLY write new elements for these uncovered files.

`;
      }
    }

    const header = `[${reason}] Selected ${pathList.length} files:`;
    if (fileContents.length === 0) {
      return `${directive}${header}\n\nNo valid files to read (all filtered out or do not exist).`;
    }

    return `${directive}${header}\n\n${fileContents.join("\n\n")}`;
  },
});
