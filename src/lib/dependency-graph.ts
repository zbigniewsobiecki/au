import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { findAuFiles, getSourceFromAuPath } from "./au-paths.js";

interface Dependency {
  ref: string;
  symbols?: string[];
}

interface DependencyInfo {
  /** Files this file depends on (from depends_on field) */
  dependsOn: string[];
  /** Files that depend on this file (reverse lookup) */
  usedBy: string[];
  /** Symbols referenced from each dependency */
  symbolsByDep: Map<string, string[]>;
}

export type DependencyGraph = Map<string, DependencyInfo>;

/**
 * Build a dependency graph from all .au files in the codebase.
 * Returns a map of source file paths to their dependency information.
 */
export async function buildDependencyGraph(basePath: string = "."): Promise<DependencyGraph> {
  const { files: auFiles } = await findAuFiles(basePath, true);
  const graph: DependencyGraph = new Map();

  // First pass: collect all depends_on relationships
  for (const auFile of auFiles) {
    const sourcePath = getSourceFromAuPath(auFile);
    const fullAuPath = join(basePath, auFile);

    // Initialize entry
    if (!graph.has(sourcePath)) {
      graph.set(sourcePath, {
        dependsOn: [],
        usedBy: [],
        symbolsByDep: new Map(),
      });
    }

    try {
      const content = await readFile(fullAuPath, "utf-8");
      const doc = parse(content);

      if (!doc) continue;

      // Extract depends_on relationships
      const dependsOn: Dependency[] = doc?.relationships?.depends_on || [];
      for (const dep of dependsOn) {
        if (dep.ref && dep.ref.startsWith("au:")) {
          const targetPath = dep.ref.replace(/^au:/, "");
          const info = graph.get(sourcePath)!;
          info.dependsOn.push(targetPath);
          if (dep.symbols && dep.symbols.length > 0) {
            info.symbolsByDep.set(targetPath, dep.symbols);
          }
        }
      }

      // Also check collaborates_with under understanding
      const collaborates = doc?.understanding?.collaborates_with || [];
      for (const collab of collaborates) {
        if (collab.path && collab.path.startsWith("au:")) {
          const targetPath = collab.path.replace(/^au:/, "");
          const info = graph.get(sourcePath)!;
          if (!info.dependsOn.includes(targetPath)) {
            info.dependsOn.push(targetPath);
          }
        }
      }
    } catch {
      // Can't read file, skip
    }
  }

  // Second pass: build reverse lookup (usedBy)
  for (const [sourcePath, info] of graph) {
    for (const depPath of info.dependsOn) {
      if (!graph.has(depPath)) {
        graph.set(depPath, {
          dependsOn: [],
          usedBy: [],
          symbolsByDep: new Map(),
        });
      }
      const depInfo = graph.get(depPath)!;
      if (!depInfo.usedBy.includes(sourcePath)) {
        depInfo.usedBy.push(sourcePath);
      }
    }
  }

  return graph;
}

/**
 * Find all files that depend on any of the given changed files.
 * Returns a list of source file paths that may need updates.
 */
export function findDependents(graph: DependencyGraph, changedFiles: string[]): string[] {
  const dependents = new Set<string>();

  for (const changedFile of changedFiles) {
    const info = graph.get(changedFile);
    if (info) {
      for (const usedBy of info.usedBy) {
        dependents.add(usedBy);
      }
    }
  }

  // Remove the changed files themselves from dependents
  for (const changedFile of changedFiles) {
    dependents.delete(changedFile);
  }

  return Array.from(dependents).sort();
}

/**
 * Get detailed dependency information for display.
 */
export function getDependencyDetails(
  graph: DependencyGraph,
  sourcePath: string
): { dependsOn: Array<{ path: string; symbols: string[] }>; usedBy: string[] } | null {
  const info = graph.get(sourcePath);
  if (!info) return null;

  return {
    dependsOn: info.dependsOn.map((dep) => ({
      path: dep,
      symbols: info.symbolsByDep.get(dep) || [],
    })),
    usedBy: info.usedBy,
  };
}

/**
 * Format dependency information for agent context.
 */
export function formatDependentsForContext(
  graph: DependencyGraph,
  changedFiles: string[]
): string {
  const lines: string[] = [];

  for (const changedFile of changedFiles) {
    const info = graph.get(changedFile);
    if (info && info.usedBy.length > 0) {
      lines.push(`\n${changedFile} is referenced by:`);
      for (const usedBy of info.usedBy) {
        const userInfo = graph.get(usedBy);
        const symbols = userInfo?.symbolsByDep.get(changedFile) || [];
        if (symbols.length > 0) {
          lines.push(`  - ${usedBy} (uses: ${symbols.join(", ")})`);
        } else {
          lines.push(`  - ${usedBy}`);
        }
      }
    }
  }

  return lines.join("\n");
}
