import { render } from "./templates.js";

export const ASK_SYSTEM_PROMPT = (options: { sysmlOnly?: boolean; auOnly?: boolean; codeOnly?: boolean } = {}) => {
  // auOnly is deprecated alias for sysmlOnly
  const modelOnly = options.sysmlOnly ?? options.auOnly ?? false;
  return render("ask/sysml-system", {
    sysmlOnly: modelOnly,
    codeOnly: options.codeOnly ?? false,
  });
};

export const ASK_INITIAL_PROMPT = (question: string, options: { sysmlOnly?: boolean; auOnly?: boolean; codeOnly?: boolean } = {}) => {
  // auOnly is deprecated alias for sysmlOnly
  const modelOnly = options.sysmlOnly ?? options.auOnly ?? false;
  return render("ask/sysml-initial", {
    question,
    sysmlOnly: modelOnly,
    codeOnly: options.codeOnly ?? false,
  });
};

export const REFINE_SYSTEM_PROMPT = () => render("ask/refine-system", {});

export const REFINE_INITIAL_PROMPT = (question: string, proposal: string) =>
  render("ask/refine-initial", { question, proposal });
