import { render } from "./templates.js";

export const ASK_SYSTEM_PROMPT = render("ask/system");
export const ASK_INITIAL_PROMPT = (question: string) =>
  render("ask/initial", { question });
