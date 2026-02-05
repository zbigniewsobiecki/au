/**
 * Ingest module - utilities for the ingest command.
 */

// Constants
export {
  TOTAL_CYCLES,
  SYSML_DIR,
  STANDARD_IGNORE_PATTERNS,
  CYCLE_SYSML_PATTERNS,
} from "./constants.js";

// Types
export type {
  CycleState,
  CreatedEntity,
  CycleIterationState,
  ManifestHints,
  IngestState,
  CycleTurnOptions,
  CycleTurnResult,
  FileWriteCallback,
} from "./types.js";

// File utilities
export {
  findManifestCycle,
  isHighPrioritySchema,
  expandManifestGlobs,
  expandDirectoryPatterns,
  getFilesForCycle,
  readFileContents,
  selectInitialBatch,
} from "./file-utils.js";

// Entity parsing
export { extractEntitiesFromSysml } from "./entity-parser.js";

// Token tracking
export {
  formatCost,
  formatTokenUsage,
  formatTurnSummary,
  formatCycleSummary,
} from "./token-tracking.js";

// Model I/O
export {
  readExistingModel,
  generateInitialModel,
  validateInitialModel,
  updateModelIndex,
} from "./model-io.js";

// Manifest hints
export { getManifestHintsForCycle } from "./manifest-hints.js";

// Coverage utilities
export type { CoverageVerification, HeuristicCoverage } from "./coverage-utils.js";
export {
  verifyCycleCoverage,
  verifyCoverageHeuristically,
} from "./coverage-utils.js";

// Cycle state persistence
export {
  loadCycleReadFiles,
  saveCycleReadFiles,
} from "./cycle-state-store.js";

// Cycle runner
export type {
  TrailingMessageContext,
  RetryTrailingContext,
  AgentTurnConfig,
} from "./cycle-runner.js";
export {
  runAgentTurn,
  runCycleTurn,
  runRetryTurn,
  runCycle0Turn,
} from "./cycle-runner.js";
