/**
 * Language-specific file patterns for SysML reverse engineering.
 * These patterns help identify relevant files for each analysis cycle.
 */

/**
 * High-priority schema patterns that should:
 * 1. Always be included in file discovery (not subject to maxFiles limit)
 * 2. Have higher truncation limits (100k chars instead of 10k)
 * 3. Be processed first in each cycle
 */
export const SCHEMA_PRIORITY_PATTERNS = [
  "**/*.prisma",
  "**/*.graphql",
  "**/*.gql",
  "**/*.proto",
  "**/*.sql",
];

export interface LanguagePatterns {
  extensions: string[];
  entryPoints: string[];
  configFiles: string[];
  typeDefinitions: string[];
  schemaFiles: string[];
  testFiles: string[];
  apiSpecs: string[];
  buildFiles: string[];
}

/**
 * Universal patterns that apply across all languages.
 */
export const universalPatterns = {
  packageManifests: [
    "package.json",
    "Cargo.toml",
    "go.mod",
    "pyproject.toml",
    "setup.py",
    "requirements.txt",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "*.csproj",
    "*.fsproj",
    "Gemfile",
    "composer.json",
    "Makefile",
    "CMakeLists.txt",
  ],
  entryPointPatterns: [
    "**/main.*",
    "**/index.*",
    "**/app.*",
    "**/server.*",
    "**/cli.*",
    "**/__main__.py",
    "**/main.go",
    "**/Program.cs",
    "**/Main.java",
    "**/lib.rs",
    "**/mod.rs",
  ],
  configPatterns: [
    ".env*",
    "**/.env*",
    "**/config.*",
    "**/settings.*",
    "**/*.config.*",
    "**/appsettings.json",
    "**/application.yml",
    "**/application.yaml",
    "**/application.properties",
  ],
  typeDefinitionPatterns: [
    "**/*.d.ts",
    "**/types.*",
    "**/interfaces.*",
    "**/*.proto",
    "**/*.graphql",
    "**/*.gql",
    "**/*.thrift",
    "**/*.avsc",
  ],
  schemaPatterns: [
    "**/schema.*",
    "**/*.schema.*",
    "**/migrations/**",
    "**/*.sql",
    "**/*.prisma",
    "**/models/**",
    "**/entities/**",
  ],
  testPatterns: [
    "**/*_test.*",
    "**/*.test.*",
    "**/*.spec.*",
    "**/test_*.*",
    "**/*Test.*",
    "**/*_spec.*",
    "**/tests/**",
    "**/__tests__/**",
  ],
  apiSpecPatterns: [
    "**/openapi.*",
    "**/swagger.*",
    "**/api.*",
    "**/*.raml",
    "**/asyncapi.*",
  ],
  buildPatterns: [
    "Dockerfile*",
    "**/Dockerfile*",
    "docker-compose*",
    "**/docker-compose*",
    ".github/workflows/*.yml",
    ".gitlab-ci.yml",
    "Jenkinsfile",
    "azure-pipelines.yml",
    "Makefile",
    "**/build.*",
    "webpack.config.*",
    "vite.config.*",
    "rollup.config.*",
    "tsconfig*.json",
    "babel.config.*",
  ],
  documentationPatterns: [
    "README*",
    "CONTRIBUTING*",
    "CHANGELOG*",
    "docs/**",
    "**/docs/**",
  ],
};

/**
 * Language-specific patterns.
 */
export const languagePatterns: Record<string, LanguagePatterns> = {
  typescript: {
    extensions: [".ts", ".tsx", ".mts", ".cts"],
    entryPoints: ["index.ts", "main.ts", "app.ts", "server.ts", "cli.ts"],
    configFiles: ["tsconfig.json", "tsconfig.*.json"],
    typeDefinitions: [
      "**/*.d.ts",
      "**/types.ts",
      "**/types/**/*.ts",
      "**/*.types.ts",
      "**/interfaces/**/*.ts",
      "**/models/**/*.ts",
      "**/entities/**/*.ts",
      "**/enums/**/*.ts",
      "**/dto/**/*.ts",
      "**/dtos/**/*.ts",
      "**/schemas/**/*.ts",
      "packages/shared-types/**/*.ts",  // Monorepo shared types
    ],
    schemaFiles: ["**/*.prisma", "**/*.graphql", "**/schema.ts", "**/migrations/**/*.ts"],
    testFiles: ["**/*.test.ts", "**/*.spec.ts", "**/__tests__/**/*.ts", "**/test/**/*.ts", "**/tests/**/*.ts"],
    apiSpecs: ["**/openapi.ts", "**/swagger.ts"],
    buildFiles: ["tsconfig.json", "webpack.config.ts", "vite.config.ts"],
  },
  javascript: {
    extensions: [".js", ".jsx", ".mjs", ".cjs"],
    entryPoints: ["index.js", "main.js", "app.js", "server.js", "cli.js"],
    configFiles: ["jsconfig.json"],
    typeDefinitions: ["**/*.d.ts", "**/types.js"],
    schemaFiles: ["**/*.graphql", "**/schema.js"],
    testFiles: ["**/*.test.js", "**/*.spec.js", "**/__tests__/**/*.js"],
    apiSpecs: ["**/openapi.js", "**/swagger.js"],
    buildFiles: ["webpack.config.js", "vite.config.js", "rollup.config.js"],
  },
  python: {
    extensions: [".py", ".pyx", ".pyi"],
    entryPoints: ["__main__.py", "main.py", "app.py", "cli.py", "manage.py"],
    configFiles: ["pyproject.toml", "setup.py", "setup.cfg", "tox.ini"],
    typeDefinitions: ["**/*.pyi", "**/py.typed"],
    schemaFiles: ["**/models.py", "**/schema.py", "**/schemas.py", "alembic/**"],
    testFiles: ["**/test_*.py", "**/*_test.py", "**/tests/**/*.py"],
    apiSpecs: ["**/openapi.py", "**/api.py"],
    buildFiles: ["pyproject.toml", "setup.py", "Makefile"],
  },
  go: {
    extensions: [".go"],
    entryPoints: ["main.go", "cmd/**/main.go"],
    configFiles: ["go.mod", "go.sum"],
    typeDefinitions: ["**/*.go"],
    schemaFiles: ["**/*.proto", "**/models/**/*.go"],
    testFiles: ["**/*_test.go"],
    apiSpecs: ["**/openapi.go", "**/api/**/*.go"],
    buildFiles: ["Makefile", "go.mod"],
  },
  rust: {
    extensions: [".rs"],
    entryPoints: ["main.rs", "lib.rs", "src/main.rs", "src/lib.rs"],
    configFiles: ["Cargo.toml", "Cargo.lock"],
    typeDefinitions: ["**/*.rs"],
    schemaFiles: ["**/*.proto", "**/models/**/*.rs"],
    testFiles: ["**/tests/**/*.rs", "**/*_test.rs"],
    apiSpecs: ["**/openapi.rs"],
    buildFiles: ["Cargo.toml", "build.rs"],
  },
  java: {
    extensions: [".java"],
    entryPoints: ["**/Main.java", "**/Application.java", "**/*Application.java"],
    configFiles: ["pom.xml", "build.gradle", "build.gradle.kts"],
    typeDefinitions: ["**/dto/**/*.java", "**/model/**/*.java"],
    schemaFiles: ["**/*.proto", "**/entity/**/*.java", "src/main/resources/**/*.sql"],
    testFiles: ["**/*Test.java", "**/test/**/*.java"],
    apiSpecs: ["**/openapi.*", "**/swagger.*"],
    buildFiles: ["pom.xml", "build.gradle", "Makefile"],
  },
  csharp: {
    extensions: [".cs"],
    entryPoints: ["Program.cs", "**/Program.cs"],
    configFiles: ["*.csproj", "*.sln", "appsettings.json", "appsettings.*.json"],
    typeDefinitions: ["**/Dto/**/*.cs", "**/Models/**/*.cs"],
    schemaFiles: ["**/*.proto", "**/Entities/**/*.cs", "**/Migrations/**/*.cs"],
    testFiles: ["**/*Tests.cs", "**/*Test.cs", "**/Tests/**/*.cs"],
    apiSpecs: ["**/openapi.*", "**/swagger.*"],
    buildFiles: ["*.csproj", "*.sln", "Makefile"],
  },
  cpp: {
    extensions: [".cpp", ".cc", ".cxx", ".hpp", ".h", ".hxx"],
    entryPoints: ["main.cpp", "main.cc", "**/main.cpp"],
    configFiles: ["CMakeLists.txt", "Makefile", "*.vcxproj"],
    typeDefinitions: ["**/*.hpp", "**/*.h", "**/include/**"],
    schemaFiles: ["**/*.proto", "**/*.thrift"],
    testFiles: ["**/*_test.cpp", "**/test_*.cpp", "**/tests/**/*.cpp"],
    apiSpecs: [],
    buildFiles: ["CMakeLists.txt", "Makefile", "conanfile.txt"],
  },
};

/**
 * Framework-specific patterns.
 */
export const frameworkPatterns: Record<string, string[]> = {
  // JavaScript/TypeScript frameworks
  react: ["**/App.tsx", "**/App.jsx", "**/components/**", "**/hooks/**", "**/pages/**"],
  nextjs: ["pages/**", "app/**", "next.config.*"],
  vue: ["**/App.vue", "**/*.vue", "vue.config.*", "nuxt.config.*"],
  angular: ["**/*.component.ts", "**/*.module.ts", "angular.json"],
  express: ["**/routes/**", "**/middleware/**", "**/controllers/**"],
  nestjs: ["**/*.module.ts", "**/*.controller.ts", "**/*.service.ts"],

  // Python frameworks
  django: ["**/views.py", "**/urls.py", "**/admin.py", "manage.py"],
  fastapi: ["**/routers/**", "**/endpoints/**", "main.py"],
  flask: ["**/routes/**", "**/blueprints/**", "app.py"],

  // Java frameworks
  spring: ["**/*Controller.java", "**/*Service.java", "**/*Repository.java"],

  // Go frameworks
  gin: ["**/handlers/**", "**/routes/**"],
  echo: ["**/handlers/**", "**/routes/**"],
};

/**
 * Get patterns for a specific language.
 */
export function getPatternsForLanguage(language: string): LanguagePatterns | undefined {
  return languagePatterns[language.toLowerCase()];
}

/**
 * Get all file extensions for a language.
 */
export function getExtensionsForLanguage(language: string): string[] {
  const patterns = languagePatterns[language.toLowerCase()];
  return patterns?.extensions ?? [];
}

/**
 * Get glob patterns for a specific cycle and language.
 */
export function getCyclePatterns(cycle: number, language?: string): string[] {
  const langPatterns = language ? languagePatterns[language.toLowerCase()] : undefined;

  switch (cycle) {
    case 1: // Discovery & Context
      return [
        ...universalPatterns.packageManifests,
        ...universalPatterns.documentationPatterns,
        ...universalPatterns.buildPatterns,
        ...universalPatterns.configPatterns,
      ];

    case 2: // Structure & Modules
      return [
        ...(langPatterns?.entryPoints ?? universalPatterns.entryPointPatterns),
        ...(langPatterns?.configFiles ?? []),
        "**/mod.rs",
        "**/__init__.py",
        "**/index.*",
      ];

    case 3: // Data & Types
      return [
        ...(langPatterns?.typeDefinitions ?? universalPatterns.typeDefinitionPatterns),
        ...(langPatterns?.schemaFiles ?? universalPatterns.schemaPatterns),
      ];

    case 4: // Behavior & Logic
      return [
        ...(langPatterns?.entryPoints ?? []),
        "**/routes/**",
        "**/controllers/**",
        "**/handlers/**",
        "**/services/**",
        "**/middleware/**",
        "**/commands/**",
      ];

    case 5: // Verification & Quality
      return [
        ...(langPatterns?.testFiles ?? universalPatterns.testPatterns),
        ".github/workflows/*.yml",
        ".gitlab-ci.yml",
        "Jenkinsfile",
      ];

    case 6: // Analysis & Properties
      return [
        ...universalPatterns.configPatterns,
        "**/middleware/**",
        "**/security/**",
        "**/auth/**",
        "**/cache/**",
        "**/metrics/**",
        "**/logging/**",
      ];

    default:
      return [];
  }
}

/**
 * Cycle names for display.
 */
export const cycleNames: Record<number, string> = {
  0: "Repository Discovery",
  1: "Discovery & Context",
  2: "Structure & Modules",
  3: "Data & Types",
  4: "Behavior & Logic",
  5: "Verification & Quality",
  6: "Analysis & Properties",
};

/**
 * Cycle goals for prompts.
 */
export const cycleGoals: Record<number, string> = {
  0: "Explore repository and create manifest with file lists and counts for subsequent cycles",
  1: "Understand what kind of system this is and its boundaries",
  2: "Map the codebase structure into SysML parts",
  3: "Extract all data structures and their constraints",
  4: "Capture how the system processes requests and manages state",
  5: "Map tests to requirements and operations",
  6: "Define non-functional characteristics and analysis cases",
};
