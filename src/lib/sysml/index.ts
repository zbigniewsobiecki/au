/**
 * SysML v2 reverse engineering library.
 * Exports all SysML-related utilities.
 */

// Discovery
export {
  discoverProject,
  loadOrDiscoverProject,
  type ProjectMetadata,
  type ProjectType,
  type ArchitectureStyle,
  type PrimaryLanguage,
  type ExternalDependency,
} from "./discovery.js";

// Patterns
export {
  SCHEMA_PRIORITY_PATTERNS,
  universalPatterns,
  languagePatterns,
  frameworkPatterns,
  getPatternsForLanguage,
  getExtensionsForLanguage,
  getCyclePatterns,
  cycleNames,
  cycleGoals,
  type LanguagePatterns,
} from "./patterns.js";

// Generator
export {
  generateStdlib,
  generateProjectFile,
  generateSystemContext,
  generateRequirements,
  generateStructureTemplate,
  generateDataModelTemplate,
  generateBehaviorTemplate,
  generateVerificationTemplate,
  generateAnalysisTemplate,
  generateModelIndex,
  generateInitialFiles,
  discoverModelPackages,
  regenerateModelIndex,
  escapeSysmlString,
  pathToIdentifier,
  indent,
  formatDocComment,
  type GeneratedFiles,
} from "./generator.js";

// Validator
export {
  validateSysml,
  formatValidationIssues,
  validateMultiple,
  type ValidationIssue,
  type ValidationResult,
} from "./validator.js";

// Matcher (for search/replace operations)
export {
  findMatch,
  findAllMatches,
  applyReplacement,
  formatContext,
  formatDiff,
  type MatchStrategy,
  type MatchResult,
  type MatchFailure,
  type MatchSuggestion,
} from "./matcher.js";

// Coverage Checker
export {
  checkCycleCoverage,
  findCoveredFiles,
  formatCoverageResult,
  // Manifest coverage checking
  discoverAllSourceFiles,
  checkManifestCoverage,
  formatManifestCoverageResult,
  suggestPatternsForUncoveredFiles,
  // @SourceFile path validation
  validateSourceFilePaths,
  // Cycle output directory mapping
  CYCLE_OUTPUT_DIRS,
  type CoverageResult,
  type CoverageContext,
  type ManifestCoverageResult,
  type SourceFileError,
  type SourceFileValidationResult,
} from "./coverage-checker.js";
