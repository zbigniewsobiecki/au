import { createGadget, z } from "llmist";
import { parsePathList } from "../lib/command-utils.js";
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
  description: `Select the next batch of files to view in the file viewer.
Call EXACTLY ONCE per turn.
Pass file paths as a newline-separated string.
Pass an empty string when all documentation is complete.

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

    if (pathList.length === 0) {
      // LLM is signaling completion - validate coverage if context is set
      if (coverageContext) {
        const { cycle, basePath, minCoveragePercent = 80 } = coverageContext;

        const coverage = await checkCycleCoverage(cycle, basePath);

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

    // Block new file requests while validation errors exist
    if (validationEnforcementEnabled) {
      try {
        const validation = await validateModelFull(".sysml");
        if (validation.exitCode !== 0) {
          return `ERROR: Cannot request new files while validation errors exist.

Fix all validation errors first, then request new file batches.
Use SysMLRead to examine files with errors and SysMLWrite to fix them.
Validation re-runs automatically after each write.`;
        }
      } catch {
        // sysml2 not available - allow the request
      }
    }

    return `[${reason}] Selected ${pathList.length} files: ${pathList.join(", ")}`;
  },
});
