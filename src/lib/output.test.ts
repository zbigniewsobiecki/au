import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { Output } from "./output.js";

describe("Output", () => {
  let output: Output;
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  describe("verbose mode", () => {
    beforeEach(() => {
      output = new Output({ verbose: true });
    });

    it("info logs in verbose mode", () => {
      output.info("Test message");
      expect(consoleSpy).toHaveBeenCalled();
    });

    it("iteration logs header", () => {
      output.iteration(1);
      expect(consoleSpy).toHaveBeenCalled();
      const calls = consoleSpy.mock.calls.flat().join(" ");
      expect(calls).toContain("Iteration 1");
    });

    it("thinkingChunk writes to stdout", () => {
      output.thinkingChunk("some thinking");
      expect(stdoutSpy).toHaveBeenCalled();
    });

    it("thinkingEnd logs newline", () => {
      output.thinkingEnd();
      expect(consoleSpy).toHaveBeenCalled();
    });

    it("gadgetCall logs gadget name", () => {
      output.gadgetCall("ReadFiles");
      expect(consoleSpy).toHaveBeenCalled();
      const calls = consoleSpy.mock.calls.flat().join(" ");
      expect(calls).toContain("ReadFiles");
    });

    it("gadgetResult logs with summary", () => {
      output.gadgetResult("ReadFiles", "1.5kb");
      expect(consoleSpy).toHaveBeenCalled();
      const calls = consoleSpy.mock.calls.flat().join(" ");
      expect(calls).toContain("ReadFiles");
      expect(calls).toContain("1.5kb");
    });
  });

  describe("non-verbose mode", () => {
    beforeEach(() => {
      output = new Output({ verbose: false });
    });

    it("info does not log", () => {
      output.info("Test message");
      expect(consoleSpy).not.toHaveBeenCalled();
    });

    it("iteration does not log", () => {
      output.iteration(1);
      expect(consoleSpy).not.toHaveBeenCalled();
    });

    it("thinkingChunk does not write", () => {
      output.thinkingChunk("some thinking");
      expect(stdoutSpy).not.toHaveBeenCalled();
    });

    it("thinkingEnd does not log", () => {
      output.thinkingEnd();
      expect(consoleSpy).not.toHaveBeenCalled();
    });

    it("gadgetCall does not log", () => {
      output.gadgetCall("ReadFiles");
      expect(consoleSpy).not.toHaveBeenCalled();
    });

    it("gadgetResult does not log", () => {
      output.gadgetResult("ReadFiles", "1.5kb");
      expect(consoleSpy).not.toHaveBeenCalled();
    });
  });

  describe("always visible methods", () => {
    beforeEach(() => {
      output = new Output({ verbose: false });
    });

    it("success always logs", () => {
      output.success("Success message");
      expect(consoleSpy).toHaveBeenCalled();
      const calls = consoleSpy.mock.calls.flat().join(" ");
      expect(calls).toContain("Success message");
    });

    it("warn always logs", () => {
      output.warn("Warning message");
      expect(consoleSpy).toHaveBeenCalled();
      const calls = consoleSpy.mock.calls.flat().join(" ");
      expect(calls).toContain("Warning message");
    });

    it("error always logs", () => {
      output.error("Error message");
      expect(consoleSpy).toHaveBeenCalled();
      const calls = consoleSpy.mock.calls.flat().join(" ");
      expect(calls).toContain("Error message");
    });

    it("gadgetError always logs", () => {
      output.gadgetError("AUUpdate", "File not found");
      expect(consoleSpy).toHaveBeenCalled();
      const calls = consoleSpy.mock.calls.flat().join(" ");
      expect(calls).toContain("AUUpdate");
      expect(calls).toContain("File not found");
    });
  });

  describe("documenting", () => {
    it("logs in verbose mode with diff", () => {
      output = new Output({ verbose: true });
      output.documenting("src/index.ts", 10);
      expect(consoleSpy).toHaveBeenCalled();
      const calls = consoleSpy.mock.calls.flat().join(" ");
      expect(calls).toContain("src/index.ts");
      expect(calls).toContain("+10");
    });

    it("logs in non-verbose mode", () => {
      output = new Output({ verbose: false });
      output.documenting("src/index.ts");
      expect(consoleSpy).toHaveBeenCalled();
      const calls = consoleSpy.mock.calls.flat().join(" ");
      expect(calls).toContain("src/index.ts");
    });
  });

  describe("iterationStats", () => {
    it("tracks cumulative tokens and cost", () => {
      output = new Output({ verbose: true });
      output.iteration(1);
      output.iterationStats(1000, 500, 0.05);
      output.iterationStats(2000, 1000, 0.10);

      // Should have accumulated stats for summary
      // We can check by calling summary
      output.summary();

      const calls = consoleSpy.mock.calls.flat().join(" ");
      // Should show total cost of $0.15
      expect(calls).toContain("$0.15");
    });

    it("formats tokens correctly", () => {
      output = new Output({ verbose: true });
      output.iteration(1);
      // 1500 total tokens should show as "1.5k tokens"
      output.iterationStats(1000, 500, 0.05);

      const calls = consoleSpy.mock.calls.flat().join(" ");
      expect(calls).toContain("1.5k tokens");
    });

    it("formats small token counts without k suffix", () => {
      output = new Output({ verbose: true });
      output.iteration(1);
      // 500 total tokens should show as "500 tokens"
      output.iterationStats(300, 200, 0.01);

      const calls = consoleSpy.mock.calls.flat().join(" ");
      expect(calls).toContain("500 tokens");
    });
  });

  describe("cost formatting in summary", () => {
    it("formats costs >= $1 with 2 decimals", () => {
      output = new Output({ verbose: true });
      output.iteration(1);
      output.iterationStats(10000, 5000, 1.50);
      output.summary();

      const calls = consoleSpy.mock.calls.flat().join(" ");
      expect(calls).toContain("$1.50");
    });

    it("formats costs >= $0.01 with 3 decimals", () => {
      output = new Output({ verbose: true });
      output.iteration(1);
      output.iterationStats(1000, 500, 0.025);
      output.summary();

      const calls = consoleSpy.mock.calls.flat().join(" ");
      expect(calls).toContain("$0.025");
    });

    it("formats costs < $0.01 with 4 decimals", () => {
      output = new Output({ verbose: true });
      output.iteration(1);
      output.iterationStats(100, 50, 0.0025);
      output.summary();

      const calls = consoleSpy.mock.calls.flat().join(" ");
      expect(calls).toContain("$0.0025");
    });
  });

  describe("setInitialLines", () => {
    it("sets initial line count for tracking", () => {
      output = new Output({ verbose: true });
      output.setInitialLines(500);
      output.documenting("file.ts", 50);
      output.summary();

      const calls = consoleSpy.mock.calls.flat().join(" ");
      expect(calls).toContain("550 lines");
    });
  });

  describe("summary", () => {
    it("shows file count in verbose mode", () => {
      output = new Output({ verbose: true });
      output.documenting("a.ts");
      output.documenting("b.ts");
      output.summary();

      const calls = consoleSpy.mock.calls.flat().join(" ");
      expect(calls).toContain("Files documented: 2");
    });

    it("shows compact summary in non-verbose mode", () => {
      output = new Output({ verbose: false });
      output.documenting("a.ts");
      output.summary();

      const calls = consoleSpy.mock.calls.flat().join(" ");
      expect(calls).toContain("Done");
      expect(calls).toContain("1 files");
    });
  });
});
