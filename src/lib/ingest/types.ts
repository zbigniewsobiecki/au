/**
 * Types for the ingest command.
 */

import type { ProjectMetadata } from "../sysml/index.js";

/**
 * State for a single cycle.
 */
export interface CycleState {
  cycle: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cost: number;
  filesWritten: number;
  coverage?: {
    targetFiles: number;
    readFiles: number;
    percentage: number;
  };
}

/**
 * Entity created during SysML generation.
 */
export interface CreatedEntity {
  type: string;   // e.g., "item def", "enum def", "requirement def", "action def"
  name: string;   // e.g., "User", "OrderStatus", "FR001"
  file: string;   // e.g., "data/entities.sysml"
}

/**
 * State for iterative multi-turn cycle processing.
 * Uses seed+explore model: LLM discovers files rather than pre-computed list.
 */
export interface CycleIterationState {
  readFiles: Set<string>;        // Files read so far (tracked)
  currentBatch: string[];        // Files in current FileViewer
  turnCount: number;
  maxTurns: number;              // Safety limit
  createdEntities: CreatedEntity[];  // Entities created so far (to prevent duplicates)
}

/**
 * Manifest hints to guide LLM exploration during a cycle.
 */
export interface ManifestHints {
  directories: string[];         // Relevant directories for this cycle
  filePatterns: string[] | null; // File patterns to search (e.g., "src/**/*.service.ts")
  sourceFiles: string[] | null;  // Source files to cover (supports glob patterns)
  expectedOutputs: string[] | null;       // Expected SysML outputs
  expectedFileCount: number | null;       // Estimated number of files to analyze
}

/**
 * Overall ingest state.
 */
export interface IngestState {
  currentCycle: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;
  totalCost: number;
  totalFilesWritten: number;
  cycleHistory: CycleState[];
  metadata: ProjectMetadata | null;
}

/**
 * Options for running an agent turn.
 */
export interface CycleTurnOptions {
  model: string;
  verbose: boolean;
  rpm: number;
  tpm: number;
  maxIterations: number;
  batchSize: number;
}

/**
 * Result from an agent turn.
 */
export interface CycleTurnResult {
  nextFiles: string[];
  summary: string[];
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cost: number;
  filesWritten: number;
}

/**
 * Callback for file write events.
 */
export type FileWriteCallback = (path: string, mode: string, delta: string | null) => void;
