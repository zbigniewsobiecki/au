/**
 * Project type detection for SysML reverse engineering.
 * Analyzes package manifests and file structure to identify the project's
 * language, framework, and architecture style.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import fg from "fast-glob";

export type ProjectType =
  | "web-app"
  | "api"
  | "library"
  | "cli"
  | "microservice"
  | "monolith"
  | "embedded"
  | "desktop"
  | "mobile"
  | "unknown";

export type ArchitectureStyle =
  | "layered"
  | "hexagonal"
  | "modular"
  | "microservice"
  | "monolith"
  | "monorepo"
  | "plugin"
  | "event-driven"
  | "unknown";

export type PrimaryLanguage =
  | "typescript"
  | "javascript"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "csharp"
  | "cpp"
  | "unknown";

export interface ExternalDependency {
  name: string;
  version?: string;
  purpose: string;
  type: "database" | "cache" | "queue" | "api" | "runtime" | "library" | "tool" | "other";
}

export interface ProjectMetadata {
  name: string;
  description: string;
  version?: string;
  projectType: ProjectType;
  primaryLanguage: PrimaryLanguage;
  secondaryLanguages: string[];
  runtime?: string;
  framework?: string;
  architectureStyle: ArchitectureStyle;
  entryPoints: string[];
  externalDependencies: ExternalDependency[];
  ports: {
    http?: boolean;
    grpc?: boolean;
    cli?: boolean;
    websocket?: boolean;
    tcp?: boolean;
    embedded?: boolean;
  };
  discoveredAt: string;
  manifestFile?: string;
  discoveredEntities?: string[];  // Entity names found from model files
  discoveredDomains?: string[];   // Domain names from controllers (Auth, Customer, etc.)
}

/**
 * Language detection from file extensions count.
 */
interface LanguageStats {
  typescript: number;
  javascript: number;
  python: number;
  go: number;
  rust: number;
  java: number;
  csharp: number;
  cpp: number;
}

/**
 * Detect the primary programming language from file counts.
 */
function detectPrimaryLanguage(stats: LanguageStats): PrimaryLanguage {
  const entries = Object.entries(stats) as [PrimaryLanguage, number][];
  const sorted = entries.sort((a, b) => b[1] - a[1]);

  if (sorted[0][1] === 0) {
    return "unknown";
  }

  return sorted[0][0];
}

/**
 * Count files by language extension.
 */
async function countFilesByLanguage(basePath: string): Promise<LanguageStats> {
  const stats: LanguageStats = {
    typescript: 0,
    javascript: 0,
    python: 0,
    go: 0,
    rust: 0,
    java: 0,
    csharp: 0,
    cpp: 0,
  };

  const patterns = [
    "**/*.ts",
    "**/*.tsx",
    "**/*.js",
    "**/*.jsx",
    "**/*.py",
    "**/*.go",
    "**/*.rs",
    "**/*.java",
    "**/*.cs",
    "**/*.cpp",
    "**/*.cc",
    "**/*.hpp",
  ];

  const files = await fg(patterns, {
    cwd: basePath,
    ignore: ["**/node_modules/**", "**/vendor/**", "**/target/**", "**/dist/**", "**/.git/**"],
    onlyFiles: true,
  });

  for (const file of files) {
    if (file.endsWith(".ts") || file.endsWith(".tsx")) {
      stats.typescript++;
    } else if (file.endsWith(".js") || file.endsWith(".jsx")) {
      stats.javascript++;
    } else if (file.endsWith(".py")) {
      stats.python++;
    } else if (file.endsWith(".go")) {
      stats.go++;
    } else if (file.endsWith(".rs")) {
      stats.rust++;
    } else if (file.endsWith(".java")) {
      stats.java++;
    } else if (file.endsWith(".cs")) {
      stats.csharp++;
    } else if (file.endsWith(".cpp") || file.endsWith(".cc") || file.endsWith(".hpp")) {
      stats.cpp++;
    }
  }

  return stats;
}

/**
 * Detect framework from package.json dependencies.
 */
function detectFrameworkFromNpm(
  dependencies: Record<string, string>,
  devDependencies: Record<string, string>
): string | undefined {
  const allDeps = { ...dependencies, ...devDependencies };

  // Check for specific frameworks
  if (allDeps["next"]) return "nextjs";
  if (allDeps["nuxt"]) return "nuxt";
  if (allDeps["@angular/core"]) return "angular";
  if (allDeps["vue"]) return "vue";
  if (allDeps["react"]) return "react";
  if (allDeps["@nestjs/core"]) return "nestjs";
  if (allDeps["express"]) return "express";
  if (allDeps["fastify"]) return "fastify";
  if (allDeps["hono"]) return "hono";
  if (allDeps["koa"]) return "koa";
  if (allDeps["electron"]) return "electron";

  return undefined;
}

/**
 * Detect project type from framework and dependencies.
 */
function detectProjectType(
  framework: string | undefined,
  dependencies: Record<string, string>,
  hasDockerfile: boolean,
  entryPoints: string[]
): ProjectType {
  // CLI detection
  if (entryPoints.some((e) => e.includes("cli") || e.includes("bin"))) {
    return "cli";
  }

  // Framework-based detection
  if (framework) {
    if (["nextjs", "nuxt", "angular", "vue", "react"].includes(framework)) {
      return "web-app";
    }
    if (["nestjs", "express", "fastify", "hono", "koa"].includes(framework)) {
      return "api";
    }
    if (framework === "electron") {
      return "desktop";
    }
  }

  // Library detection
  if (dependencies["@types/node"] && !dependencies["express"] && !dependencies["fastify"]) {
    const hasMain = entryPoints.some((e) => e.includes("index") || e.includes("lib"));
    if (hasMain) {
      return "library";
    }
  }

  // Microservice detection (Docker + small scope)
  if (hasDockerfile) {
    return "microservice";
  }

  return "unknown";
}

/**
 * Detect architecture style from directory structure.
 */
async function detectArchitectureStyle(basePath: string): Promise<ArchitectureStyle> {
  const dirs = await fg(["**/"], {
    cwd: basePath,
    onlyDirectories: true,
    deep: 3,
    ignore: ["**/node_modules/**", "**/vendor/**", "**/target/**", "**/dist/**", "**/.git/**"],
  });

  const dirNames = new Set(dirs.map((d) => d.split("/").pop()?.toLowerCase()).filter(Boolean));

  // Hexagonal/Ports-Adapters
  if (
    (dirNames.has("ports") && dirNames.has("adapters")) ||
    (dirNames.has("domain") && dirNames.has("infrastructure") && dirNames.has("application"))
  ) {
    return "hexagonal";
  }

  // Layered architecture
  if (
    (dirNames.has("controllers") && dirNames.has("services")) ||
    (dirNames.has("api") && dirNames.has("services") && dirNames.has("data")) ||
    (dirNames.has("presentation") && dirNames.has("business") && dirNames.has("data"))
  ) {
    return "layered";
  }

  // Event-driven
  if (
    dirNames.has("events") ||
    dirNames.has("handlers") ||
    dirNames.has("subscribers") ||
    dirNames.has("listeners")
  ) {
    return "event-driven";
  }

  // Plugin architecture
  if (dirNames.has("plugins") || dirNames.has("extensions") || dirNames.has("addons")) {
    return "plugin";
  }

  // Monorepo (apps/, packages/, libs/ at root level)
  if (dirNames.has("apps") || (dirNames.has("packages") && dirs.some(d => d.startsWith("apps/") || d.startsWith("packages/")))) {
    return "monorepo" as ArchitectureStyle;
  }

  // Modular
  if (dirNames.has("modules") || dirNames.has("packages") || dirNames.has("libs")) {
    return "modular";
  }

  return "unknown";
}

/**
 * Extract external dependencies from package.json.
 */
function extractExternalDependencies(
  dependencies: Record<string, string>,
  devDependencies: Record<string, string>
): ExternalDependency[] {
  const result: ExternalDependency[] = [];
  const allDeps = { ...dependencies };

  // Database clients
  const dbClients: Record<string, string> = {
    pg: "PostgreSQL",
    mysql2: "MySQL",
    mongodb: "MongoDB",
    redis: "Redis",
    ioredis: "Redis",
    prisma: "Prisma ORM",
    typeorm: "TypeORM",
    sequelize: "Sequelize",
    mongoose: "MongoDB",
    sqlite3: "SQLite",
    "better-sqlite3": "SQLite",
  };

  for (const [dep, dbName] of Object.entries(dbClients)) {
    if (allDeps[dep]) {
      result.push({
        name: dbName,
        version: allDeps[dep],
        purpose: "Data persistence",
        type: dep.includes("redis") ? "cache" : "database",
      });
    }
  }

  // Message queues
  const queues: Record<string, string> = {
    amqplib: "RabbitMQ",
    "bull": "Redis Queue",
    bullmq: "Redis Queue",
    kafkajs: "Kafka",
    "@aws-sdk/client-sqs": "AWS SQS",
  };

  for (const [dep, queueName] of Object.entries(queues)) {
    if (allDeps[dep]) {
      result.push({
        name: queueName,
        version: allDeps[dep],
        purpose: "Message queue",
        type: "queue",
      });
    }
  }

  // APIs
  if (allDeps["axios"] || allDeps["node-fetch"] || allDeps["got"]) {
    result.push({
      name: "HTTP Client",
      purpose: "External API communication",
      type: "api",
    });
  }

  return result;
}

/**
 * Scan monorepo packages for frameworks.
 */
async function scanMonorepoPackages(basePath: string): Promise<{
  frameworks: string[];
  allDeps: Record<string, string>;
  entryPoints: string[];
}> {
  const frameworks: string[] = [];
  const allDeps: Record<string, string> = {};
  const entryPoints: string[] = [];

  // Look for package.json in apps/* and packages/*
  const packageFiles = await fg(["apps/*/package.json", "packages/*/package.json"], {
    cwd: basePath,
    onlyFiles: true,
  });

  for (const pkgFile of packageFiles) {
    try {
      const content = await readFile(join(basePath, pkgFile), "utf-8");
      const pkg = JSON.parse(content) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        main?: string;
        scripts?: Record<string, string>;
      };

      const deps = pkg.dependencies ?? {};
      const devDeps = pkg.devDependencies ?? {};

      // Merge dependencies
      Object.assign(allDeps, deps, devDeps);

      // Detect framework in this package
      const framework = detectFrameworkFromNpm(deps, devDeps);
      if (framework && !frameworks.includes(framework)) {
        frameworks.push(framework);
      }

      // Track entry points - prioritize apps over packages
      const dir = pkgFile.replace("/package.json", "");
      const isApp = dir.startsWith("apps/");

      if (isApp) {
        // For apps, infer entry point from scripts.dev or scripts.start
        const scripts = pkg.scripts ?? {};
        const devScript = scripts.dev ?? scripts.start ?? "";
        // Extract file path from common patterns: "tsx watch src/server.ts", "ts-node src/index.ts", "node dist/index.js"
        const match = devScript.match(/(?:tsx\s+(?:watch\s+)?|ts-node\s+|node\s+)([^\s]+)/);
        if (match) {
          entryPoints.push(join(dir, match[1]));
        } else if (devScript.includes("vite") || devScript.includes("next")) {
          // For Vite/Next.js apps, use conventional entry point
          entryPoints.push(join(dir, "src/main.tsx"));
        }
      } else if (pkg.main) {
        // For packages, use main only if it's a library (skip utility packages)
        // Skip utility packages like eslint-config, typescript-config
        if (!dir.includes("eslint-config") && !dir.includes("typescript-config")) {
          entryPoints.push(join(dir, pkg.main));
        }
      }
    } catch {
      // Skip unreadable packages
    }
  }

  return { frameworks, allDeps, entryPoints };
}

/**
 * Parse package.json to extract project metadata.
 */
async function parsePackageJson(
  basePath: string
): Promise<Partial<ProjectMetadata> | null> {
  const packageJsonPath = join(basePath, "package.json");

  try {
    const content = await readFile(packageJsonPath, "utf-8");
    const pkg = JSON.parse(content) as {
      name?: string;
      version?: string;
      description?: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      main?: string;
      bin?: string | Record<string, string>;
      scripts?: Record<string, string>;
      workspaces?: string[] | { packages: string[] };
    };

    let dependencies = pkg.dependencies ?? {};
    let devDependencies = pkg.devDependencies ?? {};
    let framework = detectFrameworkFromNpm(dependencies, devDependencies);
    let frameworks: string[] = framework ? [framework] : [];

    // Detect entry points
    const entryPoints: string[] = [];
    if (pkg.main) {
      entryPoints.push(pkg.main);
    }
    if (pkg.bin) {
      if (typeof pkg.bin === "string") {
        entryPoints.push(pkg.bin);
      } else {
        entryPoints.push(...Object.values(pkg.bin));
      }
    }

    // Check if this is a monorepo (has workspaces)
    const isMonorepo = pkg.workspaces !== undefined;
    if (isMonorepo) {
      const monorepoData = await scanMonorepoPackages(basePath);
      frameworks = [...new Set([...frameworks, ...monorepoData.frameworks])];
      entryPoints.push(...monorepoData.entryPoints);
      // Merge all dependencies for external dependency detection
      dependencies = { ...dependencies, ...monorepoData.allDeps };
    }

    // Check for Dockerfile
    let hasDockerfile = false;
    try {
      await stat(join(basePath, "Dockerfile"));
      hasDockerfile = true;
    } catch {
      // No Dockerfile
    }

    // Determine project type based on discovered frameworks
    let projectType: ProjectType = "unknown";
    if (isMonorepo) {
      projectType = "monolith"; // Monorepos are typically full-stack apps
      // Refine based on frameworks
      if (frameworks.some(f => ["react", "vue", "angular", "nextjs", "nuxt"].includes(f))) {
        projectType = "web-app";
      }
    } else {
      projectType = detectProjectType(framework, dependencies, hasDockerfile, entryPoints);
    }

    // Use the first detected framework, or combine for monorepos
    const frameworkStr = frameworks.length > 1
      ? frameworks.join(" + ")
      : frameworks[0];

    return {
      name: pkg.name ?? "unknown",
      description: pkg.description ?? "",
      version: pkg.version,
      framework: frameworkStr,
      projectType,
      entryPoints,
      externalDependencies: extractExternalDependencies(dependencies, devDependencies),
      manifestFile: "package.json",
      runtime: devDependencies["typescript"] || dependencies["typescript"] ? "Node.js + TypeScript" : "Node.js",
    };
  } catch {
    return null;
  }
}

/**
 * Parse Cargo.toml for Rust projects.
 */
async function parseCargoToml(basePath: string): Promise<Partial<ProjectMetadata> | null> {
  const cargoPath = join(basePath, "Cargo.toml");

  try {
    const content = await readFile(cargoPath, "utf-8");

    // Simple TOML parsing for basic fields
    const nameMatch = content.match(/^name\s*=\s*"([^"]+)"/m);
    const versionMatch = content.match(/^version\s*=\s*"([^"]+)"/m);
    const descMatch = content.match(/^description\s*=\s*"([^"]+)"/m);

    // Check for bin vs lib
    const hasBin = content.includes("[[bin]]") || content.includes("[lib]") === false;
    const hasLib = content.includes("[lib]");

    return {
      name: nameMatch?.[1] ?? "unknown",
      description: descMatch?.[1] ?? "",
      version: versionMatch?.[1],
      projectType: hasBin && !hasLib ? "cli" : "library",
      manifestFile: "Cargo.toml",
      runtime: "Rust",
    };
  } catch {
    return null;
  }
}

/**
 * Parse go.mod for Go projects.
 */
async function parseGoMod(basePath: string): Promise<Partial<ProjectMetadata> | null> {
  const goModPath = join(basePath, "go.mod");

  try {
    const content = await readFile(goModPath, "utf-8");

    const moduleMatch = content.match(/^module\s+(\S+)/m);
    const goVersionMatch = content.match(/^go\s+(\S+)/m);

    // Check for main.go to determine project type
    let projectType: ProjectType = "library";
    try {
      await stat(join(basePath, "main.go"));
      projectType = "cli";
    } catch {
      try {
        await stat(join(basePath, "cmd"));
        projectType = "cli";
      } catch {
        // Default to library
      }
    }

    return {
      name: moduleMatch?.[1]?.split("/").pop() ?? "unknown",
      description: "",
      projectType,
      manifestFile: "go.mod",
      runtime: `Go ${goVersionMatch?.[1] ?? ""}`.trim(),
    };
  } catch {
    return null;
  }
}

/**
 * Parse pyproject.toml for Python projects.
 */
async function parsePyprojectToml(basePath: string): Promise<Partial<ProjectMetadata> | null> {
  const pyprojectPath = join(basePath, "pyproject.toml");

  try {
    const content = await readFile(pyprojectPath, "utf-8");

    const nameMatch = content.match(/^name\s*=\s*"([^"]+)"/m);
    const versionMatch = content.match(/^version\s*=\s*"([^"]+)"/m);
    const descMatch = content.match(/^description\s*=\s*"([^"]+)"/m);

    // Detect framework from dependencies
    let framework: string | undefined;
    if (content.includes("fastapi")) {
      framework = "fastapi";
    } else if (content.includes("django")) {
      framework = "django";
    } else if (content.includes("flask")) {
      framework = "flask";
    }

    return {
      name: nameMatch?.[1] ?? "unknown",
      description: descMatch?.[1] ?? "",
      version: versionMatch?.[1],
      framework,
      projectType: framework ? "api" : "library",
      manifestFile: "pyproject.toml",
      runtime: "Python",
    };
  } catch {
    return null;
  }
}

/**
 * Find entry point files.
 */
async function findEntryPoints(
  basePath: string,
  language: PrimaryLanguage
): Promise<string[]> {
  const patterns: Record<string, string[]> = {
    typescript: ["index.ts", "main.ts", "app.ts", "server.ts", "src/index.ts", "src/main.ts"],
    javascript: ["index.js", "main.js", "app.js", "server.js", "src/index.js", "src/main.js"],
    python: ["__main__.py", "main.py", "app.py", "manage.py", "src/__main__.py"],
    go: ["main.go", "cmd/**/main.go"],
    rust: ["src/main.rs", "src/lib.rs"],
    java: ["**/Main.java", "**/Application.java"],
    csharp: ["Program.cs", "**/Program.cs"],
    cpp: ["main.cpp", "main.cc", "src/main.cpp"],
    unknown: [],
  };

  const searchPatterns = patterns[language] ?? [];
  if (searchPatterns.length === 0) {
    return [];
  }

  const files = await fg(searchPatterns, {
    cwd: basePath,
    ignore: ["**/node_modules/**", "**/vendor/**", "**/target/**", "**/dist/**"],
  });

  return files;
}

/**
 * Detect ports (interfaces) the system exposes.
 */
async function detectPorts(basePath: string, metadata: Partial<ProjectMetadata>): Promise<ProjectMetadata["ports"]> {
  const ports: ProjectMetadata["ports"] = {};

  // Check for HTTP frameworks (handle combined frameworks like "express + react")
  const httpFrameworks = ["express", "fastify", "nestjs", "hono", "koa", "fastapi", "flask", "django", "gin", "echo"];
  if (metadata.framework && httpFrameworks.some(f => metadata.framework!.includes(f))) {
    ports.http = true;
  }

  // Check for CLI indicators
  if (metadata.entryPoints?.some((e) => e.includes("cli") || e.includes("bin"))) {
    ports.cli = true;
  }

  // Search for gRPC
  const grpcFiles = await fg(["**/*.proto", "**/grpc/**"], {
    cwd: basePath,
    ignore: ["**/node_modules/**", "**/vendor/**"],
  });
  if (grpcFiles.length > 0) {
    ports.grpc = true;
  }

  // Search for WebSocket
  const wsIndicators = await fg(["**/websocket*", "**/ws.*", "**/socket*"], {
    cwd: basePath,
    ignore: ["**/node_modules/**", "**/vendor/**"],
  });
  if (wsIndicators.length > 0) {
    ports.websocket = true;
  }

  return ports;
}

/**
 * Extract entity names from model/entity files.
 * Looks for patterns like User.model.ts, Customer.entity.ts, etc.
 */
async function extractEntitiesFromFiles(basePath: string): Promise<string[]> {
  const modelFiles = await fg([
    "**/models/*.model.ts",
    "**/models/*.ts",
    "**/entities/*.entity.ts",
    "**/entities/*.ts"
  ], {
    cwd: basePath,
    ignore: ["**/node_modules/**", "**/dist/**", "**/*.d.ts", "**/db.ts", "**/index.ts"]
  });

  const entities = new Set<string>();
  for (const file of modelFiles) {
    // Extract entity name from "User.model.ts" -> "User" or "models/User.ts" -> "User"
    const match = file.match(/\/([A-Z][a-zA-Z]+)(?:\.model|\.entity)?\.ts$/);
    if (match) entities.add(match[1]);
  }
  return [...entities].sort();
}

/**
 * Extract domain names from controller files.
 * Looks for patterns like auth.controller.ts, customer.controller.ts, etc.
 */
async function extractDomainsFromControllers(basePath: string): Promise<string[]> {
  const controllerFiles = await fg([
    "**/controllers/*.controller.ts",
    "**/controllers/*.ts"
  ], {
    cwd: basePath,
    ignore: ["**/node_modules/**", "**/dist/**", "**/*.d.ts", "**/index.ts"]
  });

  const domains = new Set<string>();
  for (const file of controllerFiles) {
    // Extract domain from "auth.controller.ts" -> "Auth" or "controllers/user.ts" -> "User"
    const match = file.match(/\/([a-z]+)(?:\.controller)?\.ts$/i);
    if (match) {
      const name = match[1];
      domains.add(name.charAt(0).toUpperCase() + name.slice(1));
    }
  }
  return [...domains].sort();
}

/**
 * Main discovery function - analyzes a codebase and returns metadata.
 */
export async function discoverProject(basePath: string = "."): Promise<ProjectMetadata> {
  // Count files by language
  const languageStats = await countFilesByLanguage(basePath);
  const primaryLanguage = detectPrimaryLanguage(languageStats);

  // Get secondary languages
  const secondaryLanguages = (Object.entries(languageStats) as [string, number][])
    .filter(([lang, count]) => lang !== primaryLanguage && count > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([lang]) => lang);

  // Try to parse manifest files in order of preference
  let manifestData: Partial<ProjectMetadata> | null = null;

  if (primaryLanguage === "typescript" || primaryLanguage === "javascript") {
    manifestData = await parsePackageJson(basePath);
  } else if (primaryLanguage === "rust") {
    manifestData = await parseCargoToml(basePath);
  } else if (primaryLanguage === "go") {
    manifestData = await parseGoMod(basePath);
  } else if (primaryLanguage === "python") {
    manifestData = await parsePyprojectToml(basePath);
  }

  // Fallback to trying all manifest parsers
  if (!manifestData) {
    manifestData =
      (await parsePackageJson(basePath)) ??
      (await parseCargoToml(basePath)) ??
      (await parseGoMod(basePath)) ??
      (await parsePyprojectToml(basePath)) ??
      {};
  }

  // Detect architecture style
  const architectureStyle = await detectArchitectureStyle(basePath);

  // Find entry points
  const entryPoints =
    (manifestData.entryPoints && manifestData.entryPoints.length > 0)
      ? manifestData.entryPoints
      : await findEntryPoints(basePath, primaryLanguage);

  // Build base metadata
  const metadata: Partial<ProjectMetadata> = {
    name: manifestData.name ?? "unknown",
    description: manifestData.description ?? "",
    version: manifestData.version,
    projectType: manifestData.projectType ?? "unknown",
    primaryLanguage,
    secondaryLanguages,
    runtime: manifestData.runtime,
    framework: manifestData.framework,
    architectureStyle,
    entryPoints,
    externalDependencies: manifestData.externalDependencies ?? [],
    manifestFile: manifestData.manifestFile,
    discoveredAt: new Date().toISOString(),
  };

  // Detect ports
  const ports = await detectPorts(basePath, metadata);

  return {
    name: metadata.name ?? "unknown",
    description: metadata.description ?? "",
    version: metadata.version,
    projectType: metadata.projectType ?? "unknown",
    primaryLanguage,
    secondaryLanguages,
    runtime: metadata.runtime,
    framework: metadata.framework,
    architectureStyle,
    entryPoints: entryPoints ?? [],
    externalDependencies: metadata.externalDependencies ?? [],
    ports,
    discoveredAt: metadata.discoveredAt ?? new Date().toISOString(),
    manifestFile: metadata.manifestFile,
  };
}

/**
 * Load existing project metadata from .sysml/_project.sysml or discover it.
 */
export async function loadOrDiscoverProject(basePath: string = "."): Promise<ProjectMetadata> {
  const projectFile = join(basePath, ".sysml", "_project.sysml");

  try {
    const content = await readFile(projectFile, "utf-8");
    // Extract metadata from SysML comment block
    const metaMatch = content.match(/\/\*\s*META:\s*([\s\S]*?)\s*\*\//);
    if (metaMatch) {
      return JSON.parse(metaMatch[1]) as ProjectMetadata;
    }
  } catch {
    // File doesn't exist, discover
  }

  return discoverProject(basePath);
}
