/**
 * Re-export sysml-parser functions.
 *
 * Chevrotain grammar warnings are suppressed via the preload script
 * in bin/suppress-chevrotain-warnings.cjs.
 */

export { validateDocument, parseDocument } from "sysml-parser";
export type { ValidationResult as SysmlParserResult } from "sysml-parser";
