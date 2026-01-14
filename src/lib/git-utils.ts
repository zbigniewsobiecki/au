import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export type ChangeStatus = "A" | "M" | "D" | "R";

export interface ChangedFile {
  path: string;
  status: ChangeStatus;
  oldPath?: string; // For renames
}

/**
 * Check if the current directory is a git repository.
 */
export async function isGitRepo(): Promise<boolean> {
  try {
    await execAsync("git rev-parse --is-inside-work-tree");
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect the default branch (main or master).
 * Throws if neither exists.
 */
export async function detectBaseBranch(): Promise<string> {
  try {
    // Try to get the default branch from remote
    const { stdout } = await execAsync("git remote show origin 2>/dev/null | grep 'HEAD branch' | cut -d: -f2");
    const branch = stdout.trim();
    if (branch) {
      return branch;
    }
  } catch {
    // Fall through to manual detection
  }

  // Check if main exists
  try {
    await execAsync("git rev-parse --verify main");
    return "main";
  } catch {
    // main doesn't exist
  }

  // Check if master exists
  try {
    await execAsync("git rev-parse --verify master");
    return "master";
  } catch {
    // master doesn't exist
  }

  throw new Error("Could not detect base branch. Neither 'main' nor 'master' exists.");
}

/**
 * Get the list of files changed between the base branch and HEAD.
 * Uses three-dot diff to compare against merge-base.
 */
export async function getChangedFiles(baseBranch: string): Promise<ChangedFile[]> {
  const { stdout } = await execAsync(`git diff ${baseBranch}...HEAD --name-status`);

  if (!stdout.trim()) {
    return [];
  }

  const files: ChangedFile[] = [];
  const lines = stdout.trim().split("\n");

  for (const line of lines) {
    const parts = line.split("\t");
    const status = parts[0].charAt(0) as ChangeStatus;

    if (status === "R") {
      // Rename: R100\toldPath\tnewPath
      files.push({
        path: parts[2],
        status: "R",
        oldPath: parts[1],
      });
    } else {
      files.push({
        path: parts[1],
        status,
      });
    }
  }

  return files;
}

/**
 * Get the current branch name.
 */
export async function getCurrentBranch(): Promise<string> {
  const { stdout } = await execAsync("git branch --show-current");
  return stdout.trim();
}

/**
 * Check if there are uncommitted changes.
 */
export async function hasUncommittedChanges(): Promise<boolean> {
  try {
    const { stdout } = await execAsync("git status --porcelain");
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Filter changed files to only include source files.
 */
export function filterSourceFiles(files: ChangedFile[], patterns: string[]): ChangedFile[] {
  return files.filter((file) => {
    return patterns.some((pattern) => {
      // Simple glob matching for *.ext patterns
      if (pattern.startsWith("*.")) {
        const ext = pattern.slice(1); // .ts, .tsx, etc.
        return file.path.endsWith(ext);
      }
      return false;
    });
  });
}

/**
 * Get the git diff for a specific file between the base branch and HEAD.
 * Uses three-dot diff to compare against merge-base.
 */
export async function getFileDiff(baseBranch: string, filePath: string): Promise<string> {
  const { stdout } = await execAsync(`git diff ${baseBranch}...HEAD -- "${filePath}"`);
  return `=== ${filePath} ===\n${stdout || "(no changes)"}`;
}
