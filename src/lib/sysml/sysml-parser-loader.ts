/**
 * Re-export parser functions from the embedded SysML parser.
 */

export { validateDocument, parseDocument } from "../../parser/index.js";
export type { ValidationResult as SysmlParserResult } from "../../parser/index.js";
