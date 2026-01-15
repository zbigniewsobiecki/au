import { render } from "./templates.js";

export const ASK_SYSTEM_PROMPT = (options: { auOnly?: boolean; codeOnly?: boolean } = {}) =>
  render("ask/system", {
    auOnly: options.auOnly ?? false,
    codeOnly: options.codeOnly ?? false,
  });
export const ASK_INITIAL_PROMPT = (question: string, options: { auOnly?: boolean; codeOnly?: boolean } = {}) =>
  render("ask/initial", {
    question,
    auOnly: options.auOnly ?? false,
    codeOnly: options.codeOnly ?? false,
  });

export const REFINE_SYSTEM_PROMPT = () => render("ask/refine-system", {});

export const REFINE_INITIAL_PROMPT = (question: string, proposal: string) =>
  render("ask/refine-initial", { question, proposal });
