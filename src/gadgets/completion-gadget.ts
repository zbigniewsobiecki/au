import { createGadget, z, TaskCompletionSignal } from "llmist";

/**
 * Creates a completion gadget that signals task completion.
 * All completion gadgets have the same structure with a summary parameter.
 */
export function createCompletionGadget(config: {
  name: string;
  description: string;
  messagePrefix: string;
}) {
  return createGadget({
    name: config.name,
    description: config.description,
    schema: z.object({
      summary: z.string().describe("Brief summary of completed work"),
    }),
    execute: async ({ summary }) => {
      throw new TaskCompletionSignal(`${config.messagePrefix}: ${summary}`);
    },
  });
}
