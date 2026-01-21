import { createGadget, z } from "llmist";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

// Store target directory (set by document command)
let allowedTargetDir: string | null = null;

export function setTargetDir(dir: string) {
  allowedTargetDir = resolve(dir);
}

export const writeDoc = createGadget({
  name: "WriteFile",
  maxConcurrent: 1,
  description: `Write a SINGLE documentation file. You may only call this gadget ONCE per turn.

⚠️ ONE WriteFile PER TURN: You can call AURead, ReadFiles, and other read gadgets freely,
but only ONE WriteFile call per turn. After WriteFile, STOP and wait for confirmation.

Parameters:
- filePath: Path within the docs directory (e.g., "guides/auth.md")
- content: Complete file content including any frontmatter

QUALITY REQUIREMENTS:
- Each document should be 80-150 lines minimum
- Include detailed explanations, not just bullet points
- Add code examples with imports and realistic values
- Include cross-references to related documents`,
  examples: [
    {
      comment: "Write a markdown doc with frontmatter",
      params: {
        filePath: "guides/authentication.md",
        content: `---
title: "Authentication"
description: "How auth works"
sidebar:
  order: 1
---

## Overview

This guide covers authentication...`,
      },
    },
  ],
  schema: z.object({
    filePath: z.string().describe("Path within docs directory"),
    content: z.string().describe("Complete file content"),
  }),
  execute: async ({ filePath, content }) => {
    if (!allowedTargetDir) {
      return "Error: Target directory not configured";
    }

    // Validate path is within target
    const fullPath = resolve(allowedTargetDir, filePath);
    if (!fullPath.startsWith(allowedTargetDir)) {
      return `Error: Path must be within ${allowedTargetDir}`;
    }

    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf-8");

    const bytes = Buffer.byteLength(content, "utf-8");
    return `Written: ${filePath} (${bytes} bytes)`;
  },
});
