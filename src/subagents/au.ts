import {
  Gadget,
  z,
  createSubagent,
  TaskCompletionSignal,
  resolveValue,
} from "llmist";
import type { ExecutionContext } from "llmist";
import { auRead, auList } from "../gadgets/index.js";

/**
 * Internal gadget for the AU agent to report its final result.
 * Uses TaskCompletionSignal to properly terminate the agent loop.
 */
class ReportResult extends Gadget({
  name: "ReportResult",
  description:
    "Report the final answer to the question. Call this when you have gathered enough information to provide a comprehensive answer.",
  schema: z.object({
    answer: z
      .string()
      .describe("Your comprehensive answer synthesizing findings from the codebase understanding."),
  }),
}) {
  execute(params: this["params"]): string {
    throw new TaskCompletionSignal(params.answer);
  }
}

/**
 * System prompt for the AU subagent.
 */
const SYSTEM_PROMPT = `You are an AI assistant that answers questions about codebases using pre-captured semantic understanding.

## Available Gadgets

### AUList
List all existing understanding entries with their contents. Use this first to see what documentation exists across the codebase.

### AURead
Read the understanding for a specific file or directory. Returns concise summaries of purpose, exports, dependencies, and patterns.

### ReportResult
**IMPORTANT**: When you have gathered enough information to answer the question, you MUST call ReportResult with your complete answer. This returns your answer to the caller.

## Strategy

1. **Use AUList first**: See what documentation exists across the codebase
2. **Drill down with AURead**: Get detailed understanding of specific files/directories
3. **Follow relationships**: Understanding entries document dependencies - use them to navigate
4. **Report your answer**: When you have enough information, call ReportResult with a comprehensive answer

## Guidelines

- Be concise but thorough
- Reference specific file paths when relevant
- If you can't find information about something, say so in your answer
- Stop exploring once you have enough information to answer confidently
- **Always call ReportResult when done** - this is how your answer gets returned
`;

/**
 * AU subagent - queries codebase understanding autonomously.
 *
 * This subagent runs its own agent loop using AURead and AUList gadgets
 * to answer questions about a codebase based on captured understanding.
 * It operates in AU-only mode, meaning it cannot access source code directly.
 *
 * @example
 * ```typescript
 * // In your agent
 * const au = new AU();
 * registry.register('AskAboutCodebase', au);
 *
 * // The agent can now call:
 * // AskAboutCodebase(question="How does authentication work?")
 * ```
 */
export class AU extends Gadget({
  name: "AskAboutCodebase",
  description: `Query the semantic understanding of a codebase.
This gadget uses pre-captured semantic understanding to answer questions about code architecture, patterns, and relationships.
Use this for understanding how systems work, finding entry points, or exploring dependencies.
Returns a comprehensive answer synthesized from the codebase understanding.`,
  schema: z.object({
    question: z
      .string()
      .describe(
        "The question to answer about the codebase, e.g., 'How does the authentication flow work?' or 'What are the main entry points?'"
      ),
    path: z
      .string()
      .optional()
      .describe("Working directory containing the codebase (default: current)"),
    maxIterations: z
      .number()
      .optional()
      .describe(
        "Maximum number of steps before giving up (default: 10, configurable via CLI)"
      ),
    model: z
      .string()
      .optional()
      .describe(
        "Model to use for the agent (default: inherit from parent agent, configurable via CLI)"
      ),
  }),
  timeoutMs: 120000, // 2 minutes - reading AU files is fast
}) {
  async execute(
    params: this["params"],
    ctx?: ExecutionContext
  ): Promise<string> {
    const { question, path = "." } = params;
    const logger = ctx?.logger;
    logger?.debug(
      `[AskAboutCodebase] Starting question="${question.slice(0, 50)}..."`
    );

    // Change working directory if needed
    const originalCwd = process.cwd();
    if (path !== ".") {
      process.chdir(path);
    }

    try {
      // Pre-load AU list as synthetic gadget call for efficiency
      let initialAuList: string | null = null;
      try {
        initialAuList = (await auList.execute({ path: "." })) as string;
      } catch {
        // Ignore - best effort
      }

      // Resolve maxIterations with config inheritance
      const maxIterations = resolveValue(ctx!, "AskAboutCodebase", {
        runtime: params.maxIterations,
        subagentKey: "maxIterations",
        defaultValue: 10,
      });

      // Build internal agent using createSubagent helper
      // This handles model resolution, tree sharing, abort signals, etc.
      const builder = createSubagent(ctx!, {
        name: "AskAboutCodebase",
        gadgets: [new ReportResult(), auRead, auList],
        systemPrompt: SYSTEM_PROMPT,
        model: params.model,
        defaultModel: "sonnet",
        maxIterations,
      });

      // Inject pre-loaded AU list as synthetic call
      if (initialAuList) {
        builder.withSyntheticGadgetCall(
          "AUList",
          { path: "." },
          initialAuList,
          "auto_list"
        );
      }

      // Run the subagent loop
      logger?.debug(
        `[AskAboutCodebase] Starting agent loop maxIterations=${maxIterations}`
      );
      const agent = builder.ask(`Answer this question about the codebase:\n\n${question}`);
      let reportedResult: string | undefined;
      let finalText = "";

      for await (const event of agent.run()) {
        // Check for abort
        if (ctx?.signal?.aborted) break;

        if (event.type === "gadget_result") {
          // Capture result when ReportResult completes
          if (
            event.result.gadgetName === "ReportResult" &&
            event.result.breaksLoop
          ) {
            reportedResult = event.result.result;
          }
        } else if (event.type === "text") {
          // Capture final text response
          finalText = event.content;
        }
      }

      // Return result: ReportResult > text > fallback
      return (
        reportedResult ||
        finalText ||
        "Could not find an answer in the codebase understanding."
      );
    } finally {
      // Restore working directory
      process.chdir(originalCwd);
    }
  }
}
