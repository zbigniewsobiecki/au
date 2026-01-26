import { createGadget, z } from "llmist";
import { getFileDiff } from "../lib/git-utils.js";
import { parsePathList } from "../lib/command-utils.js";

export const gitDiff = createGadget({
  name: "GitDiff",
  description: `Get the git diff for specific file(s) to see exactly what changed.
Returns the diff output showing lines added (+) and removed (-).
Use this to understand the actual code changes before updating SysML files.

IMPORTANT: Pay attention to:
- Lines starting with '-' were REMOVED from the codebase
- Lines starting with '+' were ADDED to the codebase
- If code was REMOVED, ensure the AU update no longer describes that code`,
  schema: z.object({
    baseBranch: z.string().describe("Base branch to compare against (e.g., 'main', 'dev')"),
    paths: z.string().describe("File path(s) to get diff for, one per line"),
  }),
  execute: async ({ baseBranch, paths }) => {
    const pathList = parsePathList(paths);

    if (pathList.length === 0) {
      return "No file paths provided.";
    }

    const diffs = await Promise.all(
      pathList.map((p) => getFileDiff(baseBranch, p))
    );

    return diffs.join("\n\n");
  },
});
