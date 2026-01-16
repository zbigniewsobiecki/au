import { createCompletionGadget } from "./completion-gadget.js";

export const finish = createCompletionGadget({
  name: "Finish",
  description: `Signal that documentation work is complete.

Call this gadget when you have:
1. Documented all source files in the repository
2. Documented all directories
3. Created the root repository understanding

This will terminate the agent loop.`,
  messagePrefix: "Documentation complete",
});
