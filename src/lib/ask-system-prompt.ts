import { render } from "./templates.js";

export const ASK_SYSTEM_PROMPT = (options: { sysmlOnly?: boolean; codeOnly?: boolean } = {}) => {
  return render("ask/sysml-system", {
    sysmlOnly: options.sysmlOnly ?? false,
    codeOnly: options.codeOnly ?? false,
  });
};

export const ASK_INITIAL_PROMPT = (question: string, options: { sysmlOnly?: boolean; codeOnly?: boolean } = {}) => {
  return render("ask/sysml-initial", {
    question,
    sysmlOnly: options.sysmlOnly ?? false,
    codeOnly: options.codeOnly ?? false,
  });
};

export const REFINE_SYSTEM_PROMPT = () => render("ask/refine-system", {});

export const REFINE_INITIAL_PROMPT = (question: string, proposal: string) =>
  render("ask/refine-initial", { question, proposal });
