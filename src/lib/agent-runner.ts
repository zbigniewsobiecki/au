import type { Agent } from "llmist";
import { Output } from "./output.js";
import { TextBlockState, endTextBlock, formatResultSize } from "./command-utils.js";
import { isFileReadingGadget, isSysMLWriteGadget } from "./constants.js";
import { parseSysMLWriteResult, displaySysMLWriteVerbose } from "./sysml-write-display.js";

/**
 * Options for running an agent with event streaming.
 */
export interface AgentRunnerOptions {
  out: Output;
  textState: TextBlockState;
  verbose?: boolean;
  /** Callback for text events */
  onText?: (content: string) => void;
  /** Callback for gadget results (after standard logging) */
  onGadgetResult?: (gadgetName: string, result: string | undefined) => void;
}

/**
 * Runs an agent and handles event streaming with standard logging.
 * Returns the accumulated text content from the agent.
 */
export async function runAgentWithEvents(
  agent: Agent,
  options: AgentRunnerOptions
): Promise<string> {
  const { out, textState, verbose = true, onText, onGadgetResult } = options;

  let textContent = "";

  for await (const event of agent.run()) {
    if (event.type === "text") {
      textContent += event.content;
      if (verbose) {
        textState.inTextBlock = true;
        out.thinkingChunk(event.content);
      }
      onText?.(event.content);
    } else if (event.type === "gadget_call") {
      if (verbose) {
        endTextBlock(textState, out);
        const params = event.call.parameters as Record<string, unknown>;
        out.gadgetCall(event.call.gadgetName, params);
      }
    } else if (event.type === "gadget_result") {
      const result = event.result;

      if (verbose) {
        if (result.error) {
          out.gadgetError(result.gadgetName, result.error);
        } else if (isSysMLWriteGadget(result.gadgetName) && result.result) {
          const parsed = parseSysMLWriteResult(result.result, result.gadgetName);
          displaySysMLWriteVerbose(parsed);
        } else if (result.gadgetName === "VerifyFinding") {
          // VerifyFinding details already shown in gadgetCall — just show compact ✓
          out.gadgetResult(result.gadgetName);
        } else {
          let summary: string | undefined;
          if (isFileReadingGadget(result.gadgetName)) {
            summary = formatResultSize(result.result);
          }
          out.gadgetResult(result.gadgetName, summary);
        }
      }

      onGadgetResult?.(result.gadgetName, result.result);
    }
  }

  if (verbose) {
    endTextBlock(textState, out);
  }

  return textContent;
}
