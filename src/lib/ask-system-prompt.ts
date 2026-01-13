import { render } from "./templates.js";

export const ASK_SYSTEM_PROMPT = (options: { auOnly?: boolean; codeOnly?: boolean } = {}) =>
  render("ask/system", {
    auOnly: options.auOnly ?? false,
    codeOnly: options.codeOnly ?? false,
  });
export const ASK_INITIAL_PROMPT = (question: string) =>
  render("ask/initial", { question });
