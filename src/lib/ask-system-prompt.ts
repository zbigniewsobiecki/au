import { render } from "./templates.js";

export const ASK_SYSTEM_PROMPT = (options: { sysmlOnly?: boolean; codeOnly?: boolean; preload?: boolean } = {}) => {
  return render("ask/sysml-system", {
    sysmlOnly: options.sysmlOnly ?? false,
    codeOnly: options.codeOnly ?? false,
    preload: options.preload ?? false,
  });
};

export const ASK_INITIAL_PROMPT = (question: string, options: { sysmlOnly?: boolean; codeOnly?: boolean; preload?: boolean } = {}) => {
  return render("ask/sysml-initial", {
    question,
    sysmlOnly: options.sysmlOnly ?? false,
    codeOnly: options.codeOnly ?? false,
    preload: options.preload ?? false,
  });
};

export const REFINE_SYSTEM_PROMPT = (options: { preload?: boolean } = {}) =>
  render("ask/refine-system", { preload: options.preload ?? false });

export const REFINE_INITIAL_PROMPT = (
  question: string,
  proposal: string,
  options: { preload?: boolean } = {}
) =>
  render("ask/refine-initial", {
    question,
    proposal,
    preload: options.preload ?? false
  });
