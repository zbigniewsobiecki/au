/**
 * Description for the 'reason' parameter required on all SysML gadgets.
 * The LLM must explain why it's calling the gadget and what it expects.
 */
export const GADGET_REASON_DESCRIPTION =
  "Explain why you're calling this gadget and what you expect from it";

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
  // SysML gadgets
  SysMLWrite: "SysMLWrite",
  SysMLRead: "SysMLRead",
  SysMLList: "SysMLList",
  ProjectMetaRead: "ProjectMetaRead",
  ProjectMetaDiscover: "ProjectMetaDiscover",
  ProjectMetaUpdate: "ProjectMetaUpdate",
  FileDiscover: "FileDiscover",
  FileDiscoverCustom: "FileDiscoverCustom",
  CycleInfo: "CycleInfo",
  // Manifest gadgets (Cycle 0)
  ManifestWrite: "ManifestWrite",
  ManifestRead: "ManifestRead",
  CountPatterns: "CountPatterns",
} as const;

export type GadgetNameType = (typeof GadgetName)[keyof typeof GadgetName];

/**
 * AU file format constants.
 */
export const AU_SEPARATOR = "===";
export const NO_EXISTING_MARKER = "No existing";

/**
 * Glob patterns for finding files.
 * Note: Directory ignores (node_modules, dist, etc.) come from .gitignore
 */
export const GlobPatterns = {
  /** Pattern for finding AU files */
  auFiles: ["**/.au", "**/*.au"],

  /** Pattern for root AU file */
  rootAuFile: ".au",

  /** Pattern for source files */
  sourceFiles: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"],

  /** File patterns to ignore during source scanning (non-directory patterns only) */
  sourceIgnore: [
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
