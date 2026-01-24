/**
 * VerifyFinding Gadget
 * Records verification findings during agentic SysML model verification.
 */

import { createGadget, z } from "llmist";

/**
 * Verification finding categories.
 */
export type FindingCategory = "error" | "warning" | "suggestion";

/**
 * Verification domains - areas of the SysML model being verified.
 */
export type FindingDomain = "structure" | "data" | "behavior" | "verification" | "quality";

/**
 * A single verification finding.
 */
export interface VerificationFinding {
  category: FindingCategory;
  domain: FindingDomain;
  file?: string;
  issue: string;
  recommendation?: string;
}

/**
 * Module-level storage for findings collected during agentic verification.
 * Reset before each verification run.
 */
let collectedFindings: VerificationFinding[] = [];

/**
 * Reset the collected findings (call before starting verification).
 */
export function resetCollectedFindings(): void {
  collectedFindings = [];
}

/**
 * Get all collected findings.
 */
export function getCollectedFindings(): VerificationFinding[] {
  return [...collectedFindings];
}

/**
 * VerifyFinding gadget - records a verification finding during analysis.
 */
export const verifyFinding = createGadget({
  name: "VerifyFinding",
  description: `Report a verification finding in the SysML model.
Use this when you find issues, inconsistencies, or improvement opportunities.

Categories:
- error: Critical issues that indicate incorrect modeling
- warning: Issues that should be addressed but aren't critical
- suggestion: Improvements that could enhance the model

Domains:
- structure: Package organization, module decomposition, layers, imports
- data: Entity completeness, attribute coverage, type consistency, enums
- behavior: Action completeness, state machines, operations
- verification: Test mappings, requirement traceability
- quality: Naming conventions, documentation, unused elements`,
  examples: [
    {
      comment: "Report missing entity definition",
      params: {
        category: "error",
        domain: "data",
        file: "data/entities.sysml",
        issue: "User entity in Prisma schema has no corresponding 'item def User' in SysML",
        recommendation: "Add 'item def User' with attributes matching the Prisma model",
      },
    },
    {
      comment: "Report naming convention issue",
      params: {
        category: "suggestion",
        domain: "quality",
        file: "structure/modules.sysml",
        issue: "Package name 'userService' uses camelCase instead of PascalCase",
        recommendation: "Rename to 'UserService' for consistency",
      },
    },
  ],
  schema: z.object({
    category: z.enum(["error", "warning", "suggestion"]).describe("Issue severity level"),
    domain: z.enum(["structure", "data", "behavior", "verification", "quality"]).describe("Verification domain"),
    file: z.string().optional().describe("File path relative to .sysml/ (if applicable)"),
    issue: z.string().describe("Clear description of the issue found"),
    recommendation: z.string().optional().describe("Suggested fix or improvement"),
  }),
  execute: async ({ category, domain, file, issue, recommendation }) => {
    const finding: VerificationFinding = {
      category: category as FindingCategory,
      domain: domain as FindingDomain,
      file,
      issue,
      recommendation,
    };

    collectedFindings.push(finding);

    const prefix = category === "error" ? "ERROR" : category === "warning" ? "WARNING" : "SUGGESTION";
    const fileInfo = file ? ` in ${file}` : "";

    return `[${prefix}] ${domain}${fileInfo}: ${issue}`;
  },
});
