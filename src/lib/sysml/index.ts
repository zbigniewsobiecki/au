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
