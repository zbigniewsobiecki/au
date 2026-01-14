import { createGadget, z } from "llmist";
import { getChangedFiles, type ChangedFile } from "../lib/git-utils.js";

function formatChangedFiles(files: ChangedFile[]): string {
  if (files.length === 0) {
    return "No files changed between branches.";
  }

  const statusLabels: Record<string, string> = {
    A: "added",
    M: "modified",
    D: "deleted",
    R: "renamed",
  };

  const lines = files.map((f) => {
    const status = statusLabels[f.status] || f.status;
    if (f.status === "R" && f.oldPath) {
      return `${status}: ${f.oldPath} -> ${f.path}`;
    }
    return `${status}: ${f.path}`;
  });

  return `Changed files (${files.length}):\n${lines.join("\n")}`;
}

export const gitDiffList = createGadget({
  name: "GitDiffList",
  description: `List all files changed between the base branch and HEAD.
Shows the change type (added, modified, deleted, renamed) for each file.
Use this to understand the scope of changes before examining specific diffs.`,
  schema: z.object({
    baseBranch: z.string().describe("Base branch to compare against (e.g., 'main', 'dev')"),
  }),
  execute: async ({ baseBranch }) => {
    const changes = await getChangedFiles(baseBranch);
    return formatChangedFiles(changes);
  },
});
