/**
 * Layered string matching for SysML search/replace operations.
 * Inspired by cascade's matcher pattern with strategies:
 * exact → whitespace → indentation → fuzzy
 */

export type MatchStrategy = "exact" | "whitespace" | "indentation" | "fuzzy";

export interface MatchResult {
  found: boolean;
  strategy: MatchStrategy;
  confidence: number;
  matchedContent: string;
  startIndex: number;
  endIndex: number;
  startLine: number;
  endLine: number;
}

export interface MatchFailure {
  found: false;
  suggestions: MatchSuggestion[];
  message: string;
}

export interface MatchSuggestion {
  content: string;
  startLine: number;
  endLine: number;
  similarity: number;
}

/**
 * Find a match for the search string in the content using layered strategies.
 * Tries exact → whitespace-normalized → indentation-normalized → fuzzy in order.
 */
export function findMatch(content: string, search: string): MatchResult | MatchFailure {
  const lines = content.split("\n");

  // Strategy 1: Exact match
  const exactMatch = findExactMatch(content, search);
  if (exactMatch) {
    return {
      found: true,
      strategy: "exact",
      confidence: 1.0,
      ...exactMatch,
    };
  }

  // Strategy 2: Whitespace-normalized match (collapse multiple spaces/tabs)
  const whitespaceMatch = findWhitespaceMatch(content, search);
  if (whitespaceMatch) {
    return {
      found: true,
      strategy: "whitespace",
      confidence: 0.95,
      ...whitespaceMatch,
    };
  }

  // Strategy 3: Indentation-normalized match (ignore leading whitespace differences)
  const indentMatch = findIndentationMatch(content, search);
  if (indentMatch) {
    return {
      found: true,
      strategy: "indentation",
      confidence: 0.9,
      ...indentMatch,
    };
  }

  // Strategy 4: Fuzzy match (line-by-line similarity)
  const fuzzyMatch = findFuzzyMatch(content, search);
  if (fuzzyMatch && fuzzyMatch.confidence >= 0.8) {
    return {
      found: true,
      strategy: "fuzzy",
      ...fuzzyMatch,
    };
  }

  // No match found - generate suggestions
  return getMatchFailure(content, search, lines);
}

/**
 * Find all matches for the search string in the content.
 */
export function findAllMatches(content: string, search: string): MatchResult[] {
  const matches: MatchResult[] = [];
  let searchStart = 0;

  while (searchStart < content.length) {
    const remaining = content.slice(searchStart);
    const match = findMatch(remaining, search);

    if (!match.found) break;

    // Adjust indices to account for searchStart offset
    matches.push({
      ...match,
      startIndex: match.startIndex + searchStart,
      endIndex: match.endIndex + searchStart,
      startLine: match.startLine + countLines(content.slice(0, searchStart)),
      endLine: match.endLine + countLines(content.slice(0, searchStart)),
    });

    searchStart += match.endIndex;
  }

  return matches;
}

/**
 * Apply a replacement at the matched location.
 */
export function applyReplacement(
  content: string,
  match: MatchResult,
  replacement: string
): string {
  return (
    content.slice(0, match.startIndex) +
    replacement +
    content.slice(match.endIndex)
  );
}

/**
 * Format match context with line numbers for display.
 */
export function formatContext(
  content: string,
  startLine: number,
  endLine: number,
  highlightType: "before" | "after" = "before",
  contextLines: number = 2
): string {
  const lines = content.split("\n");
  const result: string[] = [];

  const displayStart = Math.max(0, startLine - 1 - contextLines);
  const displayEnd = Math.min(lines.length - 1, endLine - 1 + contextLines);

  const maxLineNum = displayEnd + 1;
  const lineNumWidth = String(maxLineNum).length;

  for (let i = displayStart; i <= displayEnd; i++) {
    const lineNum = String(i + 1).padStart(lineNumWidth, " ");
    const isHighlighted = i >= startLine - 1 && i <= endLine - 1;
    const marker = isHighlighted ? (highlightType === "before" ? "<" : ">") : " ";

    result.push(`${marker} ${lineNum} | ${lines[i]}`);
  }

  return result.join("\n");
}

/**
 * Format a diff showing before/after with line numbers.
 */
export function formatDiff(
  originalContent: string,
  newContent: string,
  match: MatchResult,
  replacement: string,
  contextLines: number = 2
): string {
  const originalLines = originalContent.split("\n");
  const newLines = newContent.split("\n");

  const result: string[] = [];

  // Calculate line range for the change
  const startLine = match.startLine;
  const endLine = match.endLine;
  const replacementLineCount = replacement.split("\n").length;
  const newEndLine = startLine + replacementLineCount - 1;

  // Display range with context
  const displayStart = Math.max(1, startLine - contextLines);
  const originalDisplayEnd = Math.min(originalLines.length, endLine + contextLines);
  const newDisplayEnd = Math.min(newLines.length, newEndLine + contextLines);

  const maxLineNum = Math.max(originalDisplayEnd, newDisplayEnd);
  const lineNumWidth = String(maxLineNum).length;

  result.push(`=== Edit (lines ${startLine}-${endLine}) ===`);
  result.push("--- BEFORE ---");

  // Show before section
  for (let i = displayStart - 1; i < originalDisplayEnd; i++) {
    const lineNum = String(i + 1).padStart(lineNumWidth, " ");
    const isChanged = i >= startLine - 1 && i <= endLine - 1;
    const marker = isChanged ? "<" : " ";
    result.push(`${marker} ${lineNum} | ${originalLines[i]}`);
  }

  result.push("");
  result.push("--- AFTER ---");

  // Show after section
  for (let i = displayStart - 1; i < newDisplayEnd; i++) {
    const lineNum = String(i + 1).padStart(lineNumWidth, " ");
    const isChanged = i >= startLine - 1 && i <= newEndLine - 1;
    const marker = isChanged ? ">" : " ";
    result.push(`${marker} ${lineNum} | ${newLines[i]}`);
  }

  return result.join("\n");
}

// ============================================================================
// Internal matching strategies
// ============================================================================

interface PartialMatch {
  matchedContent: string;
  startIndex: number;
  endIndex: number;
  startLine: number;
  endLine: number;
}

function findExactMatch(content: string, search: string): PartialMatch | null {
  const index = content.indexOf(search);
  if (index === -1) return null;

  return {
    matchedContent: search,
    startIndex: index,
    endIndex: index + search.length,
    startLine: countLines(content.slice(0, index)) + 1,
    endLine: countLines(content.slice(0, index + search.length)),
  };
}

function findWhitespaceMatch(content: string, search: string): PartialMatch | null {
  // Normalize whitespace: collapse multiple spaces/tabs to single space
  const normalizeWs = (s: string) => s.replace(/[ \t]+/g, " ");

  const normalizedContent = normalizeWs(content);
  const normalizedSearch = normalizeWs(search);

  const normalizedIndex = normalizedContent.indexOf(normalizedSearch);
  if (normalizedIndex === -1) return null;

  // Map back to original content position
  const { originalStart, originalEnd } = mapNormalizedToOriginal(
    content,
    normalizedIndex,
    normalizedIndex + normalizedSearch.length
  );

  return {
    matchedContent: content.slice(originalStart, originalEnd),
    startIndex: originalStart,
    endIndex: originalEnd,
    startLine: countLines(content.slice(0, originalStart)) + 1,
    endLine: countLines(content.slice(0, originalEnd)),
  };
}

function findIndentationMatch(content: string, search: string): PartialMatch | null {
  // Normalize by trimming leading whitespace from each line
  const normalizeIndent = (s: string) =>
    s
      .split("\n")
      .map((line) => line.trimStart())
      .join("\n");

  const normalizedContent = normalizeIndent(content);
  const normalizedSearch = normalizeIndent(search);

  const normalizedIndex = normalizedContent.indexOf(normalizedSearch);
  if (normalizedIndex === -1) return null;

  // Count which line the match starts on in normalized content
  const normalizedBefore = normalizedContent.slice(0, normalizedIndex);
  const startLineInNormalized = normalizedBefore.split("\n").length;

  // Find the corresponding lines in original content
  const originalLines = content.split("\n");
  const searchLines = search.split("\n");

  // Find the start position in original content
  let originalLineIndex = startLineInNormalized - 1;
  let originalStartIndex = 0;

  for (let i = 0; i < originalLineIndex; i++) {
    originalStartIndex += originalLines[i].length + 1; // +1 for newline
  }

  // Find the end position
  const endLineIndex = originalLineIndex + searchLines.length - 1;
  let originalEndIndex = originalStartIndex;

  for (let i = originalLineIndex; i <= endLineIndex && i < originalLines.length; i++) {
    originalEndIndex += originalLines[i].length + (i < endLineIndex ? 1 : 0);
  }

  return {
    matchedContent: content.slice(originalStartIndex, originalEndIndex),
    startIndex: originalStartIndex,
    endIndex: originalEndIndex,
    startLine: originalLineIndex + 1,
    endLine: endLineIndex + 1,
  };
}

interface FuzzyMatchResult extends PartialMatch {
  confidence: number;
}

function findFuzzyMatch(content: string, search: string): FuzzyMatchResult | null {
  const contentLines = content.split("\n");
  const searchLines = search.split("\n");

  if (searchLines.length === 0) return null;

  let bestMatch: FuzzyMatchResult | null = null;
  let bestScore = 0;

  // Slide search window over content
  for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
    const windowLines = contentLines.slice(i, i + searchLines.length);
    const similarity = calculateLineSimilarity(windowLines, searchLines);

    if (similarity > bestScore && similarity >= 0.7) {
      bestScore = similarity;

      // Calculate character positions
      let startIndex = 0;
      for (let j = 0; j < i; j++) {
        startIndex += contentLines[j].length + 1;
      }

      let endIndex = startIndex;
      for (let j = 0; j < searchLines.length; j++) {
        endIndex += contentLines[i + j].length + (j < searchLines.length - 1 ? 1 : 0);
      }

      bestMatch = {
        confidence: similarity,
        matchedContent: windowLines.join("\n"),
        startIndex,
        endIndex,
        startLine: i + 1,
        endLine: i + searchLines.length,
      };
    }
  }

  return bestMatch;
}

// ============================================================================
// Helper functions
// ============================================================================

function countLines(text: string): number {
  if (text === "") return 0;
  return text.split("\n").length;
}

function mapNormalizedToOriginal(
  original: string,
  normalizedStart: number,
  normalizedEnd: number
): { originalStart: number; originalEnd: number } {
  // Map positions from whitespace-normalized string back to original
  const normalizeWs = (s: string) => s.replace(/[ \t]+/g, " ");

  let originalPos = 0;
  let normalizedPos = 0;
  let originalStart = 0;
  let originalEnd = 0;

  while (originalPos < original.length && normalizedPos < normalizedEnd) {
    if (normalizedPos === normalizedStart) {
      originalStart = originalPos;
    }

    const char = original[originalPos];
    const nextChar = original[originalPos + 1];

    // Check if we're in a whitespace run
    if ((char === " " || char === "\t") && (nextChar === " " || nextChar === "\t")) {
      // Skip additional whitespace in original
      originalPos++;
      continue;
    }

    originalPos++;
    normalizedPos++;
  }

  originalEnd = originalPos;

  return { originalStart, originalEnd };
}

function calculateLineSimilarity(lines1: string[], lines2: string[]): number {
  if (lines1.length !== lines2.length) return 0;
  if (lines1.length === 0) return 1;

  let totalSimilarity = 0;

  for (let i = 0; i < lines1.length; i++) {
    totalSimilarity += stringSimilarity(lines1[i].trim(), lines2[i].trim());
  }

  return totalSimilarity / lines1.length;
}

function stringSimilarity(s1: string, s2: string): number {
  if (s1 === s2) return 1;
  if (s1.length === 0 || s2.length === 0) return 0;

  // Simple Levenshtein-based similarity
  const maxLen = Math.max(s1.length, s2.length);
  const distance = levenshteinDistance(s1, s2);

  return 1 - distance / maxLen;
}

function levenshteinDistance(s1: string, s2: string): number {
  const m = s1.length;
  const n = s2.length;

  // Use two rows instead of full matrix for memory efficiency
  let prevRow = new Array(n + 1);
  let currRow = new Array(n + 1);

  for (let j = 0; j <= n; j++) {
    prevRow[j] = j;
  }

  for (let i = 1; i <= m; i++) {
    currRow[0] = i;

    for (let j = 1; j <= n; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      currRow[j] = Math.min(
        prevRow[j] + 1, // deletion
        currRow[j - 1] + 1, // insertion
        prevRow[j - 1] + cost // substitution
      );
    }

    [prevRow, currRow] = [currRow, prevRow];
  }

  return prevRow[n];
}

function getMatchFailure(
  content: string,
  search: string,
  lines: string[]
): MatchFailure {
  const suggestions: MatchSuggestion[] = [];
  const searchLines = search.split("\n");

  // Find similar content blocks
  for (let i = 0; i <= lines.length - searchLines.length; i++) {
    const windowLines = lines.slice(i, i + searchLines.length);
    const similarity = calculateLineSimilarity(windowLines, searchLines);

    if (similarity >= 0.5) {
      suggestions.push({
        content: windowLines.join("\n"),
        startLine: i + 1,
        endLine: i + searchLines.length,
        similarity,
      });
    }
  }

  // Sort by similarity descending
  suggestions.sort((a, b) => b.similarity - a.similarity);

  // Keep top 3
  const topSuggestions = suggestions.slice(0, 3);

  let message = `Search content NOT FOUND`;
  if (topSuggestions.length > 0) {
    message += `\n\nSIMILAR CONTENT FOUND (did you mean one of these?):\n`;
    for (const suggestion of topSuggestions) {
      const percentage = Math.round(suggestion.similarity * 100);
      message += `\n--- lines ${suggestion.startLine}-${suggestion.endLine} (${percentage}% match) ---\n`;
      message += "```\n" + suggestion.content + "\n```\n";
    }
    message += `\nTIP: Re-read the file with SysMLRead to get current content.`;
  } else {
    message += `\n\nNo similar content found. The file may have changed significantly.`;
    message += `\nTIP: Re-read the file with SysMLRead to get current content.`;
  }

  return {
    found: false,
    suggestions: topSuggestions,
    message,
  };
}
