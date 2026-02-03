/**
 * Cycle State Store - persists per-cycle state (readFiles) to disk.
 *
 * Stored at .sysml/_cycle-state.json so that resume picks up
 * where it left off, preventing readFiles from resetting to empty.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

const STATE_FILE = join(".sysml", "_cycle-state.json");

interface CycleStateEntry {
  readFiles: string[];
  lastUpdated: string;
}

interface CycleStateStore {
  [cycleKey: string]: CycleStateEntry;
}

/**
 * Load persisted readFiles for a given cycle.
 * Returns an empty set if no state exists.
 */
export async function loadCycleReadFiles(cycle: number): Promise<Set<string>> {
  try {
    const raw = await readFile(STATE_FILE, "utf-8");
    const store: CycleStateStore = JSON.parse(raw);
    const entry = store[`cycle${cycle}`];
    if (entry?.readFiles) {
      return new Set(entry.readFiles);
    }
  } catch {
    // File doesn't exist or is malformed — start fresh
  }
  return new Set();
}

/**
 * Save readFiles for a given cycle.
 * Merges into the existing store so other cycles' state is preserved.
 */
export async function saveCycleReadFiles(cycle: number, readFiles: Set<string>): Promise<void> {
  let store: CycleStateStore = {};
  try {
    const raw = await readFile(STATE_FILE, "utf-8");
    store = JSON.parse(raw);
  } catch {
    // File doesn't exist yet — start fresh
  }

  store[`cycle${cycle}`] = {
    readFiles: [...readFiles].sort(),
    lastUpdated: new Date().toISOString(),
  };

  await mkdir(dirname(STATE_FILE), { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(store, null, 2) + "\n", "utf-8");
}
