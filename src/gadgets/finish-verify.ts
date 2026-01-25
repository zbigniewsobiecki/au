/**
 * FinishVerify Gadget
 * Signals completion of agentic SysML model verification.
 */

import { createCompletionGadget } from "./completion-gadget.js";

/**
 * FinishVerify gadget - signals that SysML model verification is complete.
 */
export const finishVerify = createCompletionGadget({
  name: "FinishVerify",
  description: `Signal that SysML model verification is complete.
Call this after you have thoroughly reviewed the model and reported all findings.

Before calling this:
1. Review all SysML files for the verification domains
2. Report all issues found using VerifyFinding
3. Provide a brief summary of the verification results`,
  messagePrefix: "SysML verification complete",
});
