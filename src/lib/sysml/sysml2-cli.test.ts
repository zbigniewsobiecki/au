/**
 * Tests for sysml2 CLI wrapper
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, rm, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { setElement, deleteElements, listElements } from "./sysml2-cli.js";

// Check if sysml2 CLI is available
function hasSysml2(): boolean {
  try {
    execSync("which sysml2", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const describeSysml2 = hasSysml2() ? describe : describe.skip;

describeSysml2("sysml2 CLI wrapper", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `sysml2-cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
    // Create .sysml directory for library resolution
    await mkdir(join(testDir, ".sysml"), { recursive: true });
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("setElement with allowSemanticErrors", () => {
    it("without flag, semantic errors cause failure (exit 2, file unchanged)", async () => {
      // Create a model with semantic error (UndefinedType)
      const modelFile = join(testDir, "model.sysml");
      await writeFile(modelFile, "package Test { item def X { attribute foo : UndefinedType; } }");

      const fragment = "item def NewItem { attribute bar : String; }";

      const result = await setElement(modelFile, fragment, "Test");

      // Should report failure with exit code 2 (semantic error)
      expect(result.exitCode).toBe(2);
      expect(result.success).toBe(false);
      expect(result.syntaxValid).toBe(true);

      // File should be unchanged - semantic errors block writes without flag
      const content = await readFile(modelFile, "utf-8");
      expect(content).not.toContain("NewItem");
    });

    it("with flag, semantic errors allow write (exit 2, file modified)", async () => {
      // Create a model with semantic error (UndefinedType)
      const modelFile = join(testDir, "model.sysml");
      await writeFile(modelFile, "package Test { item def X { attribute foo : UndefinedType; } }");

      const fragment = "item def NewItem { attribute bar : String; }";

      const result = await setElement(modelFile, fragment, "Test", {
        allowSemanticErrors: true,
      });

      // Should report success despite exit code 2 (semantic error allowed)
      expect(result.exitCode).toBe(2);
      expect(result.success).toBe(true);
      expect(result.syntaxValid).toBe(true);

      // File should be modified - semantic errors allowed with flag
      const content = await readFile(modelFile, "utf-8");
      expect(content).toContain("NewItem");
    });

    it("parse errors always fail regardless of flag", async () => {
      const modelFile = join(testDir, "model.sysml");
      await writeFile(modelFile, "package Test { item def X; }");
      const originalContent = await readFile(modelFile, "utf-8");

      const fragment = "item def Bad {{{";

      const result = await setElement(modelFile, fragment, "Test", {
        allowSemanticErrors: true,
      });

      expect(result.exitCode).toBe(1);
      expect(result.syntaxValid).toBe(false);
      expect(result.success).toBe(false);

      // File should be unchanged
      const content = await readFile(modelFile, "utf-8");
      expect(content).toBe(originalContent);
    });

    it("clean model succeeds", async () => {
      const modelFile = join(testDir, "model.sysml");
      await writeFile(modelFile, "package Test { item def X; }");

      const fragment = "item def Y;";

      const result = await setElement(modelFile, fragment, "Test");

      expect(result.exitCode).toBe(0);
      expect(result.success).toBe(true);
      expect(result.syntaxValid).toBe(true);
      expect(result.added).toBeGreaterThan(0);

      const content = await readFile(modelFile, "utf-8");
      expect(content).toContain("item def Y");
    });
  });

  describe("listElements", () => {
    it("should list elements from a file", async () => {
      const modelFile = join(testDir, "model.sysml");
      await writeFile(modelFile, "package Pkg { part def Car; part def Truck; }");

      const entries = await listElements([modelFile], { parseOnly: true });

      expect(entries.length).toBeGreaterThanOrEqual(1);
      const names = entries.map((e) => e.name);
      expect(names).toContain("Pkg");
    });

    it("should list elements from stdin", async () => {
      const content = "package Demo { item def Widget; enum def Color { enum Red; enum Blue; } }";

      const entries = await listElements([], { stdin: content, parseOnly: true });

      expect(entries.length).toBeGreaterThanOrEqual(1);
      const names = entries.map((e) => e.name);
      expect(names).toContain("Demo");
    });

    it("should list children with select pattern", async () => {
      const modelFile = join(testDir, "model.sysml");
      await writeFile(modelFile, "package Pkg { part def Car; part def Truck; }");

      const entries = await listElements([modelFile], {
        parseOnly: true,
        select: ["Pkg::*"],
      });

      const names = entries.map((e) => e.name);
      expect(names).toContain("Car");
      expect(names).toContain("Truck");
    });

    it("should list from a directory recursively", async () => {
      const subDir = join(testDir, "models");
      await mkdir(subDir, { recursive: true });
      await writeFile(join(subDir, "a.sysml"), "package A { part def X; }");
      await writeFile(join(subDir, "b.sysml"), "package B { part def Y; }");

      const entries = await listElements([subDir], { recursive: true, parseOnly: true });

      const names = entries.map((e) => e.name);
      expect(names).toContain("A");
      expect(names).toContain("B");
    });

    it("should return empty array for empty input", async () => {
      const entries = await listElements([], { stdin: "", parseOnly: true });
      expect(entries).toEqual([]);
    });

    it("should return empty array on syntax errors without throwing", async () => {
      const entries = await listElements([], { stdin: "not valid {{{", parseOnly: true });
      expect(Array.isArray(entries)).toBe(true);
    });
  });
});
