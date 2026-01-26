/**
 * Constants for the ingest command.
 */

/** Total number of cycles for model generation (Cycles 1-6, Cycle 0 is discovery) */
export const TOTAL_CYCLES = 6;

/** SysML output directory */
export const SYSML_DIR = ".sysml";

/**
 * Standard ignore patterns for file discovery.
 * Used by all file expansion and discovery functions.
 */
export const STANDARD_IGNORE_PATTERNS = [
  "**/node_modules/**",
  "**/vendor/**",
  "**/target/**",
  "**/dist/**",
  "**/build/**",
  "**/.git/**",
  "**/.sysml/**",
];

/**
 * Cycle → SysML directory mapping.
 * Each cycle only sees output from previous cycles to enforce cycle boundaries.
 * This prevents the LLM from seeing empty templates for future cycles
 * and attempting to populate them prematurely.
 *
 * Cycle 0 is special: it discovers the repository and creates a manifest.
 */
export const CYCLE_SYSML_PATTERNS: Record<number, string[]> = {
  0: ["SysMLPrimitives.sysml", "_project.sysml"],  // Cycle 0: Discovery - no prior SysML output
  1: ["SysMLPrimitives.sysml", "_project.sysml"],  // Primitives only
  2: ["SysMLPrimitives.sysml", "_project.sysml", "context/**/*.sysml"],  // + Cycle 1 output
  3: ["SysMLPrimitives.sysml", "_project.sysml", "context/**/*.sysml", "structure/**/*.sysml"],  // + Cycle 2
  4: ["SysMLPrimitives.sysml", "_project.sysml", "context/**/*.sysml", "structure/**/*.sysml", "data/**/*.sysml"],  // + Cycle 3
  5: ["SysMLPrimitives.sysml", "_project.sysml", "context/**/*.sysml", "structure/**/*.sysml", "data/**/*.sysml", "behavior/**/*.sysml"],  // + Cycle 4
  6: ["**/*.sysml"],  // Full model for final analysis
};
