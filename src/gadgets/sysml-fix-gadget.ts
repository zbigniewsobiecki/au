/**
 * SysML Fix Gadget - signals completion of SysML model fixing.
 */

import { createCompletionGadget } from "./completion-gadget.js";

/**
 * FinishSysmlFix gadget - signals that SysML model fixing is complete.
 */
export const finishSysmlFix = createCompletionGadget({
  name: "FinishSysmlFix",
  description: `Signal that SysML model fixing is complete.
Call this after all fixable validation issues have been addressed.`,
  messagePrefix: "SysML fix complete",
});
