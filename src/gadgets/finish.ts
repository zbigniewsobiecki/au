import { createGadget, z, TaskCompletionSignal } from "llmist";

export const finish = createGadget({
  name: "Finish",
  description: `Signal that documentation work is complete.

Call this gadget when you have:
1. Documented all source files in the repository
2. Documented all directories
3. Created the root repository understanding

This will terminate the agent loop.`,
  schema: z.object({
    summary: z
      .string()
      .describe("Brief summary of what was documented (e.g., '42 files, 12 directories')"),
  }),
  execute: async ({ summary }) => {
    throw new TaskCompletionSignal(`Documentation complete: ${summary}`);
  },
});
