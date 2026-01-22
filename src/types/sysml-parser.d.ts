/**
 * Type declarations for sysml-parser package.
 */
declare module "sysml-parser" {
  export interface Diagnostic {
    message: string;
    severity: 1 | 2 | 3 | 4; // 1=error, 2=warning, 3=info, 4=hint
    range?: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    };
  }

  export interface ValidationResult {
    ast?: unknown;
    diagnostics: Diagnostic[];
    errors: Diagnostic[];
    warnings: Diagnostic[];
    hints: Diagnostic[];
    isValid: boolean;
  }

  export interface ParseResult {
    ast?: unknown;
    lexerErrors: Array<{ message: string; line: number; column: number }>;
    parserErrors: Array<{ message: string; line: number; column: number }>;
    hasErrors: boolean;
  }

  export function validateDocument(
    content: string,
    uri?: string
  ): Promise<ValidationResult>;

  export function parseDocument(
    content: string,
    uri?: string
  ): Promise<ParseResult>;

  export function validateFile(filePath: string): Promise<ValidationResult>;

  export function parseFile(filePath: string): Promise<ParseResult>;
}
