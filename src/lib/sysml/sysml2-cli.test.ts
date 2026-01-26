/**
 * Tests for sysml2 CLI wrapper
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, rm, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { setElement } from "./sysml2-cli.js";

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
    it("should abort on semantic errors when allowSemanticErrors is false", async () => {
      // Create a model with semantic error
      const modelFile = join(testDir, "model.sysml");
      await writeFile(modelFile, "package Test { item def X { attribute foo : UndefinedType; } }");

      // Create fragment to add
      const fragment = "item def NewItem { attribute bar : String; }";

      // Without allowSemanticErrors, should fail with semantic error
      const result = await setElement(modelFile, fragment, "Test", {
        allowSemanticErrors: false,
      });

      // Should report failure and exit code 2 (semantic error)
      expect(result.exitCode).toBe(2);
      expect(result.success).toBe(false);

      // File should be unchanged
      const content = await readFile(modelFile, "utf-8");
      expect(content).not.toContain("NewItem");
    });

    it("should write file with semantic errors when allowSemanticErrors is true", async () => {
      // Create a model with semantic error
      const modelFile = join(testDir, "model.sysml");
      await writeFile(modelFile, "package Test { item def X { attribute foo : UndefinedType; } }");

      // Create fragment to add
      const fragment = "item def NewItem { attribute bar : String; }";

      // With allowSemanticErrors, should succeed with exit code 2
      const result = await setElement(modelFile, fragment, "Test", {
        allowSemanticErrors: true,
      });

      // Should report exit code 2 (semantic error) but syntaxValid should be true
      expect(result.exitCode).toBe(2);
      expect(result.syntaxValid).toBe(true);
      expect(result.added).toBeGreaterThan(0);

      // File should be modified
      const content = await readFile(modelFile, "utf-8");
      expect(content).toContain("NewItem");
    });

    it("should still abort on parse errors even with allowSemanticErrors", async () => {
      // Create a valid model
      const modelFile = join(testDir, "model.sysml");
      await writeFile(modelFile, "package Test { item def X; }");
      const originalContent = await readFile(modelFile, "utf-8");

      // Create fragment with parse error
      const fragment = "item def Bad {{{";

      // With allowSemanticErrors, parse errors should still abort
      const result = await setElement(modelFile, fragment, "Test", {
        allowSemanticErrors: true,
      });

      // Should report failure with exit code 1 (parse error)
      expect(result.exitCode).toBe(1);
      expect(result.syntaxValid).toBe(false);

      // File should be unchanged
      const content = await readFile(modelFile, "utf-8");
      expect(content).toBe(originalContent);
    });

    it("should return success for clean model with allowSemanticErrors", async () => {
      // Create a valid model
      const modelFile = join(testDir, "model.sysml");
      await writeFile(modelFile, "package Test { item def X; }");

      // Create valid fragment
      const fragment = "item def Y;";

      // Should succeed with exit code 0
      const result = await setElement(modelFile, fragment, "Test", {
        allowSemanticErrors: true,
      });

      expect(result.exitCode).toBe(0);
      expect(result.success).toBe(true);
      expect(result.syntaxValid).toBe(true);
      expect(result.added).toBeGreaterThan(0);

      // File should contain the new item
      const content = await readFile(modelFile, "utf-8");
      expect(content).toContain("item def Y");
    });

    it("should report counts in JSON output with allowSemanticErrors", async () => {
      // Create a model
      const modelFile = join(testDir, "model.sysml");
      await writeFile(modelFile, "package Test { item def X { attribute foo : UndefinedType; } }");

      // Add multiple items
      const fragment = "item def A; item def B;";

      const result = await setElement(modelFile, fragment, "Test", {
        allowSemanticErrors: true,
      });

      // Should report accurate counts
      expect(result.added).toBe(2);
    });
  });
});
