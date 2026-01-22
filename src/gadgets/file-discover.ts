/**
 * File Discovery Gadget
 * Finds relevant files for each SysML reverse engineering cycle.
 */

import { createGadget, z } from "llmist";
import fg from "fast-glob";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  getCyclePatterns,
  cycleNames,
  cycleGoals,
  type ProjectMetadata,
} from "../lib/sysml/index.js";
import { GADGET_REASON_DESCRIPTION } from "../lib/constants.js";

const PROJECT_META_PATH = ".sysml/_project.sysml";

/**
 * Extract metadata JSON from SysML file.
 */
function extractMetadata(content: string): ProjectMetadata | null {
  const metaMatch = content.match(/\/\*\s*META:\s*([\s\S]*?)\s*\*\//);
  if (metaMatch) {
    try {
      return JSON.parse(metaMatch[1]) as ProjectMetadata;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Load project metadata or return undefined.
 */
async function loadProjectMetadata(): Promise<ProjectMetadata | undefined> {
  try {
    const content = await readFile(PROJECT_META_PATH, "utf-8");
    return extractMetadata(content) ?? undefined;
  } catch {
    return undefined;
  }
}

export const fileDiscover = createGadget({
  name: "FileDiscover",
  description: `Discover relevant source files for analysis.
Returns a list of files matching patterns relevant to the focus area.

**Usage:**
FileDiscover(maxFiles=50)`,
  schema: z.object({
    reason: z.string().describe(GADGET_REASON_DESCRIPTION),
    cycle: z
      .number()
      .min(1)
      .max(6)
      .describe("Task focus area (1-6)"),
    maxFiles: z
      .number()
      .default(100)
      .describe("Maximum number of files to return"),
    includeContent: z
      .boolean()
      .default(false)
      .describe("Include file content previews (first 500 chars)"),
  }),
  execute: async ({ reason: _reason, cycle, maxFiles, includeContent }) => {
    // Load project metadata for language-specific patterns
    const metadata = await loadProjectMetadata();
    const language = metadata?.primaryLanguage;

    // Get patterns for this cycle
    const patterns = getCyclePatterns(cycle, language);

    if (patterns.length === 0) {
      return `Error: No patterns defined for cycle ${cycle}`;
    }

    // Find matching files
    const files = await fg(patterns, {
      cwd: ".",
      ignore: [
        "**/node_modules/**",
        "**/vendor/**",
        "**/target/**",
        "**/dist/**",
        "**/build/**",
        "**/.git/**",
        "**/.sysml/**",
        "**/*.au",
      ],
      onlyFiles: true,
    });

    // Sort and limit
    const sortedFiles = files.sort().slice(0, maxFiles);

    const cycleName = cycleNames[cycle] ?? `Cycle ${cycle}`;
    const cycleGoal = cycleGoals[cycle] ?? "";

    let output = `=== Cycle ${cycle}: ${cycleName} ===
Goal: ${cycleGoal}

Language: ${language ?? "unknown (run ProjectMetaDiscover first)"}
Patterns searched: ${patterns.slice(0, 5).join(", ")}${patterns.length > 5 ? ` +${patterns.length - 5} more` : ""}

Found ${files.length} files${files.length > maxFiles ? ` (showing first ${maxFiles})` : ""}:

`;

    for (const file of sortedFiles) {
      output += `- ${file}\n`;

      if (includeContent) {
        try {
          const content = await readFile(file, "utf-8");
          const preview = content.slice(0, 500).replace(/\n/g, "\n    ");
          output += `    Preview:\n    ${preview}${content.length > 500 ? "\n    ..." : ""}\n\n`;
        } catch {
          output += `    (could not read file)\n\n`;
        }
      }
    }

    if (files.length === 0) {
      output += "(no files matching the patterns found)\n";
    }

    return output;
  },
});

export const fileDiscoverCustom = createGadget({
  name: "FileDiscoverCustom",
  description: `Discover files using custom glob patterns.

**Usage:**
FileDiscoverCustom(patterns="**/routes/**/*.ts,**/api/**/*.ts")

Pass patterns as comma-separated string.`,
  schema: z.object({
    reason: z.string().describe(GADGET_REASON_DESCRIPTION),
    patterns: z
      .string()
      .describe("Comma-separated glob patterns to search for (e.g., '**/routes/**/*.ts,**/api/**/*.ts')"),
    maxFiles: z
      .number()
      .default(100)
      .describe("Maximum number of files to return"),
  }),
  execute: async ({ reason: _reason, patterns: patternsStr, maxFiles }) => {
    // Parse comma-separated patterns
    const patterns = patternsStr.split(",").map(p => p.trim()).filter(p => p.length > 0);
    if (patterns.length === 0) {
      return "Error: No valid patterns provided";
    }

    const files = await fg(patterns, {
      cwd: ".",
      ignore: [
        "**/node_modules/**",
        "**/vendor/**",
        "**/target/**",
        "**/dist/**",
        "**/build/**",
        "**/.git/**",
        "**/.sysml/**",
      ],
      onlyFiles: true,
    });

    const sortedFiles = files.sort().slice(0, maxFiles);

    let output = `=== Custom File Discovery ===
Patterns: ${patterns.join(", ")}
Found ${files.length} files${files.length > maxFiles ? ` (showing first ${maxFiles})` : ""}:

`;

    for (const file of sortedFiles) {
      output += `- ${file}\n`;
    }

    if (files.length === 0) {
      output += "(no files matching the patterns found)\n";
    }

    return output;
  },
});

export const cycleInfo = createGadget({
  name: "CycleInfo",
  description: `Get information about a specific SysML reverse engineering cycle.

**Usage:**
CycleInfo(cycle=1)`,
  schema: z.object({
    reason: z.string().describe(GADGET_REASON_DESCRIPTION),
    cycle: z
      .number()
      .min(1)
      .max(6)
      .describe("Cycle number (1-6)"),
  }),
  execute: async ({ reason: _reason, cycle }) => {
    const metadata = await loadProjectMetadata();
    const language = metadata?.primaryLanguage;
    const patterns = getCyclePatterns(cycle, language);

    const cycleName = cycleNames[cycle] ?? `Cycle ${cycle}`;
    const cycleGoal = cycleGoals[cycle] ?? "";

    const cycleDetails: Record<number, string> = {
      1: `**Discovery & Context**
Focus: Understanding system boundaries and dependencies

Files to examine (priority order):
1. README* - Project description and purpose
2. Package manifests - Dependencies reveal technology stack
3. docker-compose*, Dockerfile* - External services and deployment
4. .env*, config/* - Configuration surface
5. Directory structure - Architectural hints

Questions to answer:
- What type of project is this? (web app, API, library, CLI, embedded, etc.)
- What language(s) and runtime(s)?
- What external systems does it depend on?
- What are the main entry points?

SysML output:
- SystemContext package with external dependencies
- SystemRequirements package with discovered requirements`,

      2: `**Structure & Modules**
Focus: Mapping codebase organization into SysML parts

Universal patterns to detect:
- Layered architecture (presentation/api/service/data)
- Hexagonal/ports-adapters patterns
- Plugin/extension architecture
- Microservice boundaries
- Package/module hierarchy

Files to examine:
1. Top-level directories
2. Module definitions (mod.rs, __init__.py, index.*, package.json in subdirs)
3. Dependency injection / wiring files
4. Route/endpoint registration

Questions to answer:
- How is the code organized?
- What are the main modules/packages?
- What architectural pattern is used?
- How do modules depend on each other?

SysML output:
- SystemArchitecture package with module definitions
- Module interfaces and connections`,

      3: `**Data & Types**
Focus: Extracting data structures and constraints

Universal type sources:
- Language type files (.d.ts, type hints in Python, structs in Go/Rust)
- Schema files (SQL, Prisma, GraphQL, Protobuf)
- API specs (OpenAPI, JSON Schema)
- Serialization (JSON examples, test fixtures)

Files to examine:
1. Type definition files
2. Schema/migration files
3. API specification files
4. Model/entity directories
5. Test fixtures (reveal data shapes)

Questions to answer:
- What are the core domain entities?
- What are the data transfer shapes (API request/response)?
- What constraints/validations exist?
- What relationships between types?

SysML output:
- DataModel package with entities, DTOs, enums, events`,

      4: `**Behavior & Logic**
Focus: Capturing request processing and state management

Universal behavior sources:
- Controller/handler files
- Service/use-case files
- State management (Redux, Vuex, or any state pattern)
- Event handlers/listeners
- Middleware/interceptors
- Background jobs/workers

Files to examine:
1. Files handling entry points (routes, commands)
2. Business logic files (services, use cases)
3. State management files
4. Event/message handlers
5. Middleware chains

Questions to answer:
- What are the main operations/actions?
- What is the flow for each operation?
- What states can entities be in?
- What events are emitted/handled?
- What are the side effects?

SysML output:
- SystemBehavior package with operations, state machines, event handlers`,

      5: `**Verification & Quality**
Focus: Mapping tests to requirements and operations

Universal test patterns:
- Unit tests (test individual functions/methods)
- Integration tests (test module interactions)
- E2E tests (test full flows)
- Performance tests (load, stress)
- Property-based tests

Files to examine:
1. Test directories and files
2. Test configuration files
3. CI/CD pipeline definitions
4. Coverage reports (if present)

Questions to answer:
- What operations/components have tests?
- What requirements do tests verify?
- What is the test coverage strategy?
- What test categories exist?

SysML output:
- Verification package with test mappings and coverage analysis`,

      6: `**Analysis & Properties**
Focus: Non-functional characteristics and analysis cases

Universal analysis sources:
- Caching patterns → Performance
- Error handling → Reliability
- Auth/authz → Security
- Rate limiting → Scalability
- Logging/monitoring → Observability
- Transaction handling → Consistency

Files to examine:
1. Middleware/interceptor files
2. Configuration for caching, rate limits
3. Error handling patterns
4. Security configuration
5. Monitoring/logging setup

Questions to answer:
- What performance characteristics are targeted?
- What reliability patterns are used?
- What security controls exist?
- What operational concerns are addressed?

SysML output:
- Analysis package with performance, reliability, security profiles`,
    };

    return `=== Cycle ${cycle}: ${cycleName} ===
Goal: ${cycleGoal}

${cycleDetails[cycle] ?? "No detailed information available."}

Language-specific patterns for ${language ?? "unknown"}:
${patterns.slice(0, 10).join("\n")}${patterns.length > 10 ? `\n... +${patterns.length - 10} more patterns` : ""}`;
  },
});
