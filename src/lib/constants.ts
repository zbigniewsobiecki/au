/**
 * Gadget names used throughout the application.
 */
export const GadgetName = {
  ReadFiles: "ReadFiles",
  ReadDirs: "ReadDirs",
  AUUpdate: "AUUpdate",
  AURead: "AURead",
  AUList: "AUList",
  RipGrep: "RipGrep",
  Finish: "Finish",
} as const;

export type GadgetNameType = (typeof GadgetName)[keyof typeof GadgetName];

/**
 * AU file format constants.
 */
export const AU_SEPARATOR = "===";
export const NO_EXISTING_MARKER = "No existing";

/**
 * Glob patterns for finding files.
 */
export const GlobPatterns = {
  /** Pattern for finding AU files */
  auFiles: ["**/.au", "**/*.au"],

  /** Pattern for root AU file */
  rootAuFile: ".au",

  /** Pattern for source files */
  sourceFiles: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"],

  /** Directories to always ignore */
  ignoreDirectories: ["node_modules", ".git", "dist", "build", ".next", ".cache"],

  /** Ignore patterns for source file scanning (used by validator/progress-tracker) */
  sourceIgnore: [
    "node_modules/**",
    "dist/**",
    "build/**",
    "**/*.test.ts",
    "**/*.spec.ts",
    "**/*.d.ts",
  ],
} as const;

/**
 * Default ignore patterns for AU files.
 */
export const AU_IGNORE_PATTERNS = ["*.au", ".au", "**/*.au", "**/.au"];

/**
 * Checks if content indicates no existing AU files.
 */
export function hasNoExisting(content: string): boolean {
  return content.includes(NO_EXISTING_MARKER);
}

/**
 * Checks if a gadget is a file-reading gadget (returns size summary).
 */
export function isFileReadingGadget(name: string): boolean {
  return name === GadgetName.ReadFiles || name === GadgetName.ReadDirs;
}
