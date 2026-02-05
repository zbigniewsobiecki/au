import { Command, Flags } from "@oclif/core";
import { LLMist } from "llmist";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { loadManifest, readDirs, setCoverageContext, getCoverageContext, setMinManifestCoverage, setValidationEnforcement, syncManifestOutputs } from "../gadgets/index.js";
import {
  checkCycleCoverage,
  CYCLE_OUTPUT_DIRS,
  cycleNames,
  cycleGoals,
  generateDataModelTemplate,
  type ProjectMetadata,
} from "../lib/sysml/index.js";
import { validateModelFull } from "../lib/sysml/sysml2-cli.js";
import { Output } from "../lib/output.js";
import { render } from "../lib/templates.js";
import { agentFlags, withWorkingDirectory } from "../lib/command-utils.js";
import { discoverProject } from "../lib/sysml/index.js";
import { estimateTokens, formatTokens } from "../lib/formatting.js";

// Import from extracted ingest modules
import {
  TOTAL_CYCLES,
  SYSML_DIR,
  type CycleState,
  type CycleIterationState,
  type IngestState,
  type CycleTurnOptions,
  getFilesForCycle,
  readFileContents,
  readExistingModel,
  generateInitialModel,
  validateInitialModel,
  updateModelIndex,
  getManifestHintsForCycle,
  verifyCoverageHeuristically,
  formatCost,
  formatCycleSummary,
  runCycleTurn,
  runRetryTurn,
  runCycle0Turn,
  loadCycleReadFiles,
  saveCycleReadFiles,
} from "../lib/ingest/index.js";

export default class Ingest extends Command {
  static description = "Reverse engineer a codebase into SysML v2 models";

  static examples = [
    "<%= config.bin %> ingest",
    "<%= config.bin %> ingest --cycle 0",
    "<%= config.bin %> ingest --cycle 1",
    "<%= config.bin %> ingest --cycle 3 --model opus",
    "<%= config.bin %> ingest --purge",
    "<%= config.bin %> ingest --skip-cycle0",
    "<%= config.bin %> ingest -v",
  ];

  static flags = {
    ...agentFlags,
    cycle: Flags.integer({
      char: "c",
      description: "Run only a specific cycle (0-6). Cycle 0 is repository discovery.",
      min: 0,
      max: 6,
    }),
    purge: Flags.boolean({
      description: "Remove existing .sysml directory before starting",
      default: false,
    }),
    "skip-init": Flags.boolean({
      description: "Skip initial file generation (use existing model)",
      default: false,
    }),
    "skip-cycle0": Flags.boolean({
      description: "Skip Cycle 0 (repository discovery). Uses existing manifest or falls back to hardcoded patterns.",
      default: false,
    }),
    "max-files-per-turn": Flags.integer({
      char: "b",
      description: "Batch size for file viewer (default: 8)",
      default: 8,
      min: 3,
      max: 15,
    }),
    "coverage-threshold": Flags.integer({
      description: "Minimum coverage % required per cycle (default: 95)",
      default: 95,
      min: 0,
      max: 100,
    }),
    "manifest-coverage-threshold": Flags.integer({
      description: "Minimum manifest coverage % for Cycle 0 (default: 95). Config files are auto-excluded.",
      default: 95,
      min: 0,
      max: 100,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Ingest);
    const out = new Output({ verbose: flags.verbose });
    const { restore } = withWorkingDirectory(flags.path, out);

    // Set manifest coverage threshold (affects ManifestWrite validation in Cycle 0)
    if (flags["manifest-coverage-threshold"] !== undefined) {
      setMinManifestCoverage(flags["manifest-coverage-threshold"]);
    }

    try {
      // Purge existing model if requested
      if (flags.purge) {
        out.info("Purging existing .sysml directory...");
        try {
          await rm(SYSML_DIR, { recursive: true, force: true });
          out.success("Removed existing SysML model");
        } catch {
          // Directory doesn't exist, that's fine
        }
      }

      // Initialize state
      const state: IngestState = {
        currentCycle: flags.cycle ?? 1,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCachedTokens: 0,
        totalCost: 0,
        totalFilesWritten: 0,
        cycleHistory: [],
        metadata: null,
      };

      // Discover project metadata
      out.info("Discovering project metadata...");
      state.metadata = await discoverProject(".");
      out.success(`Discovered: ${state.metadata.name} (${state.metadata.primaryLanguage})`);

      if (flags.verbose) {
        console.log(`  Type: ${state.metadata.projectType}`);
        console.log(`  Framework: ${state.metadata.framework ?? "none"}`);
        console.log(`  Architecture: ${state.metadata.architectureStyle}`);
      }

      // Generate initial files if not skipping
      if (!flags["skip-init"]) {
        out.info("Generating initial SysML model structure...");
        await generateInitialModel(state.metadata, out, flags.verbose);

        // Validate initial files - warn but continue (LLM cycles will fix errors)
        const validationPassed = await validateInitialModel(out, flags.verbose);
        if (!validationPassed) {
          out.warn("Initial SysML files have validation errors. These will be fixed during ingestion cycles.");
        }
      }

      // Run cycles
      const client = new LLMist();

      // Determine if we should run Cycle 0
      const runCycle0 = !flags["skip-cycle0"] && (
        flags.cycle === 0 ||  // Explicitly requested Cycle 0
        flags.cycle === undefined  // Full run (no specific cycle requested)
      );

      // Run Cycle 0 (repository discovery) if needed
      if (runCycle0) {
        const existingManifest = await loadManifest();
        if (existingManifest && Object.keys(existingManifest.cycles).length > 0) {
          if (flags.verbose) {
            console.log();
            console.log(`\x1b[34m━━━ Cycle 0: Repository Discovery ━━━\x1b[0m`);
            console.log(`\x1b[32m   ✓ Manifest already exists (${Object.keys(existingManifest.cycles).length} cycles defined)\x1b[0m`);
          } else {
            console.log(`[Cycle 0] Repository Discovery - skipped (manifest exists)`);
          }
        } else {
          const cycle0Result = await this.runCycle0(client, state, flags, out);
          state.cycleHistory.push(cycle0Result);
          state.totalInputTokens += cycle0Result.inputTokens;
          state.totalOutputTokens += cycle0Result.outputTokens;
          state.totalCachedTokens += cycle0Result.cachedTokens;
          state.totalCost += cycle0Result.cost;

          // Regenerate data/_index.sysml with discovered entity stubs
          const manifest = await loadManifest();
          if (manifest?.discoveredEntities || manifest?.discoveredDomains) {
            const dataModel = generateDataModelTemplate(
              manifest.discoveredEntities,
              manifest.discoveredDomains
            );
            await writeFile(
              join(SYSML_DIR, "data/_index.sysml"),
              dataModel,
              "utf-8"
            );
            if (flags.verbose) {
              const entityCount = manifest.discoveredEntities?.length ?? 0;
              const domainCount = manifest.discoveredDomains?.length ?? 0;
              console.log(`\x1b[2m   Regenerated data/_index.sysml with ${entityCount} entity stubs, ${domainCount} domains\x1b[0m`);
            }
          }
        }
      }

      // If only Cycle 0 was requested, we're done
      if (flags.cycle === 0) {
        this.printSummary(state, flags.verbose);
        return;
      }

      // Determine cycles 1-6 to run
      const startCycle = flags.cycle ?? 1;
      const endCycle = flags.cycle ?? TOTAL_CYCLES;

      for (let cycle = startCycle; cycle <= endCycle; cycle++) {
        state.currentCycle = cycle;

        // Resume: skip cycles already at/above coverage threshold
        const preCoverage = await checkCycleCoverage(cycle, ".");
        if (preCoverage.expectedFiles.length > 0 && preCoverage.coveragePercent >= flags["coverage-threshold"]) {
          if (flags.verbose) {
            console.log();
            console.log(`\x1b[34m━━━ Cycle ${cycle}/${TOTAL_CYCLES}: ${cycleNames[cycle] ?? `Cycle ${cycle}`} ━━━\x1b[0m`);
            console.log(`\x1b[32m   ✓ Already complete (${preCoverage.coveragePercent}% coverage, ${preCoverage.expectedFiles.length - preCoverage.missingFiles.length}/${preCoverage.expectedFiles.length} files)\x1b[0m`);
          } else {
            console.log(`[Cycle ${cycle}/${TOTAL_CYCLES}] ${cycleNames[cycle] ?? `Cycle ${cycle}`} - skipped (${preCoverage.coveragePercent}% complete)`);
          }
          await syncManifestOutputs(cycle, ".");
          await updateModelIndex(state.metadata, flags.verbose);
          continue;
        }

        // Set coverage context and validation enforcement for the FileViewerNextFileSet gadget
        // Load persisted readFiles so the gadget can use unified coverage
        const gadgetReadFiles = await loadCycleReadFiles(cycle);
        setCoverageContext({
          cycle,
          basePath: ".",
          minCoveragePercent: flags["coverage-threshold"],
          readFiles: gadgetReadFiles,
        });
        setValidationEnforcement(true);

        const cycleResult = await this.runCycle(client, state, flags, out);

        // Post-cycle coverage validation and retry (unified metric)
        const cycleReadFiles = await loadCycleReadFiles(cycle);
        const coverage = await checkCycleCoverage(cycle, ".", cycleReadFiles);
        if (coverage.missingFiles.length > 0 && coverage.coveragePercent < flags["coverage-threshold"]) {
          if (flags.verbose) {
            out.warn(`Cycle ${cycle} incomplete: ${coverage.missingFiles.length} files not covered (${coverage.coveragePercent}%)`);
          }

          // Run retry phase
          const retryResult = await this.runCycleRetry(client, state, flags, out, coverage);

          // Accumulate retry results
          cycleResult.inputTokens += retryResult.inputTokens;
          cycleResult.outputTokens += retryResult.outputTokens;
          cycleResult.cachedTokens += retryResult.cachedTokens;
          cycleResult.cost += retryResult.cost;
          cycleResult.filesWritten += retryResult.filesWritten;
        }

        // Post-cycle validation safety net: warn if validation errors remain
        try {
          const finalValidation = await validateModelFull(".sysml");
          if (finalValidation.exitCode !== 0) {
            const errorType = finalValidation.exitCode === 1 ? "Syntax" : "Semantic";
            out.warn(`Cycle ${cycle} has ${errorType.toLowerCase()} validation errors. Run 'au validate --fix' to resolve.`);
          }
        } catch {
          // sysml2 not available
        }

        // Clear coverage context and validation enforcement after cycle completes
        setCoverageContext(null);
        setValidationEnforcement(false);

        // Sync manifest with actual outputs from this cycle
        const syncResult = await syncManifestOutputs(cycle, ".");
        if (syncResult.added.length > 0 && flags.verbose) {
          console.log(`\x1b[2m   Registered ${syncResult.added.length} new output files in manifest\x1b[0m`);
        }

        // Update _model.sysml to import all discovered packages
        await updateModelIndex(state.metadata, flags.verbose);

        state.cycleHistory.push(cycleResult);

        state.totalInputTokens += cycleResult.inputTokens;
        state.totalOutputTokens += cycleResult.outputTokens;
        state.totalCachedTokens += cycleResult.cachedTokens;
        state.totalCost += cycleResult.cost;
        state.totalFilesWritten += cycleResult.filesWritten;
      }

      // Print summary
      this.printSummary(state, flags.verbose);
    } finally {
      restore();
    }
  }

  private async runCycle(
    client: LLMist,
    state: IngestState,
    flags: {
      model: string;
      verbose: boolean;
      rpm: number;
      tpm: number;
      "max-iterations": number;
      "max-files-per-turn": number;
      "coverage-threshold": number;
    },
    out: Output
  ): Promise<CycleState> {
    const cycle = state.currentCycle;
    const cycleName = cycleNames[cycle] ?? `Cycle ${cycle}`;
    const cycleGoal = cycleGoals[cycle] ?? "";
    const batchSize = flags["max-files-per-turn"];

    // Display cycle header
    if (flags.verbose) {
      console.log();
      console.log(`\x1b[34m━━━ Cycle ${cycle}/${TOTAL_CYCLES}: ${cycleName} ━━━\x1b[0m`);
      console.log(`\x1b[2m   Goal: ${cycleGoal}\x1b[0m`);
    } else {
      console.log(`[Cycle ${cycle}/${TOTAL_CYCLES}] ${cycleName}`);
    }

    // Get seed files (can be empty - that's OK with exploration model)
    let seedFiles = await getFilesForCycle(cycle, state.metadata?.primaryLanguage, batchSize);
    const manifestHints = await getManifestHintsForCycle(cycle, state.metadata?.primaryLanguage);

    // Resume: filter seed files to only uncovered ones
    const resumeCoverage = await checkCycleCoverage(cycle, ".");
    const isResuming = resumeCoverage.coveredFiles.length > 0;
    if (isResuming && resumeCoverage.missingFiles.length > 0) {
      const missingSet = new Set(resumeCoverage.missingFiles);
      const filtered = seedFiles.filter(f => missingSet.has(f));
      // If all seed files are already covered but other files are missing, use those instead
      if (filtered.length === 0) {
        seedFiles = resumeCoverage.missingFiles.slice(0, batchSize);
      } else {
        seedFiles = filtered;
      }
      if (flags.verbose) {
        console.log(`\x1b[2m   Resume: seeding ${seedFiles.length} uncovered files (${resumeCoverage.coveredFiles.length} already documented)\x1b[0m`);
      }
    } else if (isResuming && resumeCoverage.missingFiles.length === 0) {
      // Everything covered — Change 1 should have caught this, but guard anyway
      seedFiles = [];
    }

    if (flags.verbose) {
      if (seedFiles.length > 0) {
        console.log(`\x1b[2m   Seed files: ${seedFiles.length}\x1b[0m`);
      } else {
        console.log(`\x1b[2m   No seed files - LLM will explore using hints\x1b[0m`);
      }
      if (manifestHints?.directories && manifestHints.directories.length > 0) {
        console.log(`\x1b[2m   Hint directories: ${manifestHints.directories.length}\x1b[0m`);
      }
      if (manifestHints?.expectedFileCount) {
        console.log(`\x1b[2m   Expected files: ~${manifestHints.expectedFileCount}\x1b[0m`);
      }
    }

    // Initialize iteration state — load persisted readFiles for resume
    const persistedReadFiles = await loadCycleReadFiles(cycle);
    const iterState: CycleIterationState = {
      readFiles: persistedReadFiles,
      currentBatch: seedFiles,
      turnCount: 0,
      maxTurns: 100,
      createdEntities: [],
    };

    // Wire live readFiles into coverage context so the gadget sees updates mid-cycle
    const currentContext = getCoverageContext();
    if (currentContext) {
      currentContext.readFiles = iterState.readFiles;
    }

    // Read stable content once (for caching)
    const existingModel = await readExistingModel(cycle, isResuming);
    const repoMap = await readDirs.execute({
      paths: ".",
      depth: 4,
      includeGitIgnored: false,
    }) as string;

    // Get cycle-specific prompt
    const cyclePrompt = render(`sysml/cycle${cycle}`, {
      metadata: state.metadata,
      files: seedFiles,
      sourceFiles: manifestHints?.sourceFiles ?? null,
      totalCount: seedFiles.length,
      isIterative: true,
    });

    const systemPrompt = render("sysml/system", {});

    // Read initial batch contents
    let fileViewerContents = seedFiles.length > 0
      ? await readFileContents(seedFiles)
      : "";
    const previousTurnSummary: string[] = [];

    // Initialize cycle state
    const cycleState: CycleState = {
      cycle,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      cost: 0,
      filesWritten: 0,
    };

    // Create options object
    const options: CycleTurnOptions = {
      model: flags.model,
      verbose: flags.verbose,
      rpm: flags.rpm,
      tpm: flags.tpm,
      maxIterations: flags["max-iterations"],
      batchSize,
    };

    let totalTurns = 0;
    let llmDone = false;

    // Show initial context composition
    if (flags.verbose) {
      const contextTokens = {
        system: estimateTokens(systemPrompt),
        repoMap: estimateTokens(repoMap),
        existingModel: estimateTokens(existingModel),
        cyclePrompt: estimateTokens(cyclePrompt),
      };
      const totalContext = contextTokens.system + contextTokens.repoMap + contextTokens.existingModel + contextTokens.cyclePrompt;
      console.log(`\x1b[2m   Base context: ${formatTokens(totalContext)} tokens (cached across turns)\x1b[0m`);
    }

    // Iterative turn loop
    while (!llmDone && iterState.turnCount < iterState.maxTurns) {
      iterState.turnCount++;

      const userMessage = render("sysml/user", {
        cycle,
        totalCycles: TOTAL_CYCLES,
        cyclePrompt,
        repoMap,
        existingModel: existingModel || undefined,
        fileViewerContents,
        manifestHints,
        readCount: iterState.readFiles.size,
        previousTurnSummary: previousTurnSummary.length > 0 ? previousTurnSummary : undefined,
        createdEntities: iterState.createdEntities.length > 0 ? iterState.createdEntities : undefined,
        isIterative: true,
        isLastCycle: cycle === TOTAL_CYCLES,
        batchSize,
      });

      // Compute unified coverage (read ∩ documented)
      const docCoverage = await checkCycleCoverage(cycle, ".", iterState.readFiles);

      // Run single turn
      const turnResult = await runCycleTurn(
        client,
        systemPrompt,
        userMessage,
        iterState,
        cycleState,
        options,
        out,
        {
          expectedCount: manifestHints?.expectedFileCount ?? seedFiles.length,
          cycle,
          language: state.metadata?.primaryLanguage,
          docCoveragePercent: docCoverage.coveragePercent,
          docMissingFiles: docCoverage.missingFiles,
        }
      );

      // Display validation errors to CLI user
      if (turnResult.validationResult && turnResult.validationResult.exitCode !== 0) {
        const errorType = turnResult.validationResult.exitCode === 1 ? "Syntax" : "Semantic";
        out.warn(`${errorType} validation errors (exit code ${turnResult.validationResult.exitCode})`);
      }

      totalTurns += turnResult.turns;

      // Track files read and persist for resume
      for (const file of iterState.currentBatch) {
        iterState.readFiles.add(file);
      }
      await saveCycleReadFiles(cycle, iterState.readFiles);

      // Update summary for next turn
      if (turnResult.summary.length > 0) {
        previousTurnSummary.length = 0;
        previousTurnSummary.push(...turnResult.summary.slice(-5));
      }

      // Check if LLM is done
      if (turnResult.nextFiles.length === 0) {
        // Handle aborted turns: re-seed with uncovered files instead of stopping
        if (turnResult.aborted) {
          const freshCoverage = await checkCycleCoverage(cycle, ".", iterState.readFiles);
          if (freshCoverage.missingFiles.length > 0) {
            iterState.currentBatch = freshCoverage.missingFiles.slice(0, batchSize);
            fileViewerContents = await readFileContents(iterState.currentBatch);
            if (flags.verbose) {
              console.log(`\x1b[33m   ⚡ Re-seeding after abort with ${iterState.currentBatch.length} uncovered files (${freshCoverage.missingFiles.length} remaining)\x1b[0m`);
            }
            continue;
          }
        }

        // Early-termination prevention
        const minFilesExpected = manifestHints?.expectedFileCount ?? 0;
        const coverageRatio = minFilesExpected > 0
          ? iterState.readFiles.size / minFilesExpected
          : 1;

        if (coverageRatio < 0.3 && iterState.turnCount < 5 && minFilesExpected > 5) {
          if (flags.verbose) {
            console.log(`\x1b[33m   ⚠ Coverage too low (${Math.round(coverageRatio * 100)}%), auto-discovering more files...\x1b[0m`);
          }

          const moreFiles = await getFilesForCycle(cycle, state.metadata?.primaryLanguage, batchSize * 3);
          const unreadFiles = moreFiles.filter(f => !iterState.readFiles.has(f));

          if (unreadFiles.length > 0) {
            iterState.currentBatch = unreadFiles.slice(0, batchSize);
            fileViewerContents = await readFileContents(iterState.currentBatch);
          } else {
            llmDone = true;
          }
        } else {
          llmDone = true;
        }
      } else {
        // LLM selected files via FileViewerNextFileSet which already returned contents
        iterState.currentBatch = turnResult.nextFiles.slice(0, batchSize);
        fileViewerContents = "";
      }

      // Progress update
      if (flags.verbose && !llmDone) {
        const coverageStr = manifestHints?.expectedFileCount
          ? ` (~${Math.round((iterState.readFiles.size / manifestHints.expectedFileCount) * 100)}% coverage)`
          : "";
        console.log(`\x1b[2m   Progress: ${iterState.readFiles.size} files analyzed${coverageStr}\x1b[0m`);
      }
    }

    // Verify coverage heuristically
    const heuristicCoverage = await verifyCoverageHeuristically(
      cycle,
      iterState.readFiles,
      state.metadata?.primaryLanguage
    );

    cycleState.coverage = {
      targetFiles: heuristicCoverage.potentialFiles,
      readFiles: heuristicCoverage.readFiles,
      percentage: heuristicCoverage.potentialFiles > 0
        ? Math.round((heuristicCoverage.readFiles / heuristicCoverage.potentialFiles) * 100)
        : 100,
    };

    // Display cycle summary
    if (flags.verbose) {
      console.log();
      console.log(formatCycleSummary(
        cycle,
        totalTurns,
        cycleState.inputTokens + cycleState.outputTokens,
        cycleState.cachedTokens,
        cycleState.cost,
        cycleState.filesWritten,
        heuristicCoverage.estimated
      ));
    }

    return cycleState;
  }

  private async runCycleRetry(
    client: LLMist,
    state: IngestState,
    flags: {
      model: string;
      verbose: boolean;
      rpm: number;
      tpm: number;
      "max-iterations": number;
      "max-files-per-turn": number;
      "coverage-threshold": number;
    },
    out: Output,
    initialCoverage: { missingFiles: string[]; coveragePercent: number }
  ): Promise<CycleState> {
    const cycle = state.currentCycle;
    const batchSize = flags["max-files-per-turn"];
    const totalMissing = initialCoverage.missingFiles.length;

    const retryState: CycleState = {
      cycle,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      cost: 0,
      filesWritten: 0,
    };

    // Load persisted readFiles so retry phase has full history
    const persistedRetryReadFiles = await loadCycleReadFiles(cycle);
    const iterState = {
      readFiles: persistedRetryReadFiles,
      currentBatch: initialCoverage.missingFiles.slice(0, batchSize),
      turnCount: 0,
      maxTurns: flags["max-iterations"],
    };

    if (flags.verbose) {
      console.log();
      console.log(`\x1b[33m━━━ Cycle ${cycle} Retry Phase ━━━\x1b[0m`);
      console.log(`\x1b[2m   Missing files: ${totalMissing}\x1b[0m`);
    }

    const existingModel = await readExistingModel(cycle, true);
    const systemPrompt = render("sysml/system", {});

    const options: CycleTurnOptions = {
      model: flags.model,
      verbose: flags.verbose,
      rpm: flags.rpm,
      tpm: flags.tpm,
      maxIterations: flags["max-iterations"],
      batchSize,
    };

    let done = false;
    while (!done && iterState.turnCount < iterState.maxTurns) {
      iterState.turnCount++;

      if (flags.verbose) {
        console.log(`\x1b[2m   Retry turn ${iterState.turnCount}/${iterState.maxTurns}: ${iterState.currentBatch.length} files in batch\x1b[0m`);
      }

      // Run validation
      let validationExitCode = 0;
      let validationOutput = "";
      try {
        const validation = await validateModelFull(".sysml");
        validationExitCode = validation.exitCode;
        validationOutput = validation.output;
      } catch {
        // sysml2 not available
      }

      const cycleOutputDir = CYCLE_OUTPUT_DIRS[cycle] || "context";

      const retryPrompt = render("sysml/retry", {
        cycle,
        cycleOutputDir,
        missingFiles: iterState.currentBatch.slice(0, 30),
        totalMissing,
        existingModel,
      });

      const fileContents = await readFileContents(iterState.currentBatch);
      const userMessage = `${retryPrompt}\n\n## Files to Document\n\n${fileContents}`;

      const turnResult = await runRetryTurn(
        client,
        systemPrompt,
        userMessage,
        iterState,
        retryState,
        options,
        out,
        validationExitCode,
        validationOutput,
        totalMissing,
        cycleOutputDir
      );

      // Display validation errors to CLI user
      if (validationExitCode !== 0) {
        const errorType = validationExitCode === 1 ? "Syntax" : "Semantic";
        out.warn(`${errorType} validation errors (exit code ${validationExitCode})`);
      }

      // Track read files and persist for resume
      for (const file of iterState.currentBatch) {
        iterState.readFiles.add(file);
      }
      await saveCycleReadFiles(cycle, iterState.readFiles);

      if (turnResult.nextFiles.length === 0) {
        const coverage = await checkCycleCoverage(cycle, ".", iterState.readFiles);

        if (flags.verbose) {
          console.log(`\x1b[2m   After turn ${iterState.turnCount}: ${coverage.coveragePercent}% coverage, ${coverage.missingFiles.length} files remaining\x1b[0m`);
        }

        if (coverage.coveragePercent >= flags["coverage-threshold"]) {
          done = true;
        } else if (coverage.missingFiles.length === 0) {
          done = true;
        } else {
          iterState.currentBatch = coverage.missingFiles.slice(0, batchSize);
        }
      } else {
        iterState.currentBatch = turnResult.nextFiles.slice(0, batchSize);
      }
    }

    // Final status
    if (flags.verbose) {
      const finalCoverage = await checkCycleCoverage(cycle, ".", iterState.readFiles);
      if (finalCoverage.missingFiles.length > 0) {
        out.warn(`Retry phase complete: ${finalCoverage.coveragePercent}% coverage (${finalCoverage.missingFiles.length} files still missing)`);
      } else {
        out.success(`Retry phase complete: ${finalCoverage.coveragePercent}% coverage achieved`);
      }
    }

    return retryState;
  }

  private async runCycle0(
    client: LLMist,
    state: IngestState,
    flags: {
      model: string;
      verbose: boolean;
      rpm: number;
      tpm: number;
      "max-iterations": number;
    },
    out: Output
  ): Promise<CycleState> {
    const cycleName = "Repository Discovery";
    const cycleGoal = "Explore repository and create manifest for subsequent cycles";

    if (flags.verbose) {
      console.log();
      console.log(`\x1b[34m━━━ Cycle 0: ${cycleName} ━━━\x1b[0m`);
      console.log(`\x1b[2m   Goal: ${cycleGoal}\x1b[0m`);
    } else {
      console.log(`[Cycle 0] ${cycleName}`);
    }

    const repoMap = await readDirs.execute({
      paths: ".",
      depth: 4,
      includeGitIgnored: false,
    }) as string;

    const cyclePrompt = render("sysml/cycle0", { metadata: state.metadata });
    const systemPrompt = render("sysml/system", {});

    const userMessage = `# Cycle 0: Repository Discovery

${cyclePrompt}

## Repository Structure

\`\`\`
${repoMap}
\`\`\`

## Instructions

1. Explore the repository structure
2. Find and count schema files (Prisma, GraphQL, Protobuf)
3. Find and count modules/services
4. Create a complete manifest using ManifestWrite

The manifest will guide subsequent cycles with exact file lists and counts.
`;

    if (flags.verbose) {
      const contextTokens = {
        system: estimateTokens(systemPrompt),
        repoMap: estimateTokens(repoMap),
        task: estimateTokens(cyclePrompt),
      };
      const totalContext = contextTokens.system + contextTokens.repoMap + contextTokens.task;

      console.log(`\x1b[2m   Context: ${formatTokens(totalContext)} tokens\x1b[0m`);
      console.log(`\x1b[2m   ├─ System:   ${formatTokens(contextTokens.system)}\x1b[0m`);
      console.log(`\x1b[2m   ├─ Repo Map: ${formatTokens(contextTokens.repoMap)}\x1b[0m`);
      console.log(`\x1b[2m   └─ Task:     ${formatTokens(contextTokens.task)}\x1b[0m`);
    }

    const options: CycleTurnOptions = {
      model: flags.model,
      verbose: flags.verbose,
      rpm: flags.rpm,
      tpm: flags.tpm,
      maxIterations: flags["max-iterations"],
      batchSize: 8, // Not used for cycle0 but required
    };

    const result = await runCycle0Turn(client, systemPrompt, userMessage, options, out);

    const cycleState: CycleState = {
      cycle: 0,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cachedTokens: result.cachedTokens,
      cost: result.cost,
      filesWritten: result.filesWritten,
    };

    if (flags.verbose) {
      console.log();
      console.log(formatCycleSummary(
        0,
        result.turns,
        result.inputTokens + result.outputTokens,
        result.cachedTokens,
        result.cost,
        result.filesWritten
      ));

      // Show manifest summary if available
      const manifest = await loadManifest();
      if (manifest) {
        console.log(`\x1b[2m   Manifest summary:\x1b[0m`);
        const getCycleNum = (key: string) => key.startsWith("cycle") ? parseInt(key.slice(5), 10) : parseInt(key, 10);
        const sortedEntries = Object.entries(manifest.cycles).sort(([a], [b]) => getCycleNum(a) - getCycleNum(b));
        for (const [key, cycleData] of sortedEntries) {
          const cycleNum = getCycleNum(key);
          const sourceFilesStr = cycleData.sourceFiles
            ? `${cycleData.sourceFiles.length} patterns`
            : "";
          console.log(`\x1b[2m   ${cycleNum}. ${cycleData.name}: ${cycleData.files?.length ?? 0} files${sourceFilesStr ? ` (${sourceFilesStr})` : ""}\x1b[0m`);
        }
      }
    }

    return cycleState;
  }

  private printSummary(state: IngestState, verbose: boolean): void {
    console.log();

    if (verbose) {
      console.log("\x1b[34m━━━ Summary ━━━\x1b[0m");
      console.log(`Project: ${state.metadata?.name ?? "unknown"}`);
      console.log(`Language: ${state.metadata?.primaryLanguage ?? "unknown"}`);
      console.log(`Cycles completed: ${state.cycleHistory.length}`);
      console.log(`Files written: ${state.totalFilesWritten}`);

      const totalTokens = state.totalInputTokens + state.totalOutputTokens;
      const tokensStr = formatTokens(totalTokens);
      const cachedStr = state.totalCachedTokens > 0
        ? ` (${formatTokens(state.totalCachedTokens)} cached)`
        : "";
      console.log(`Tokens: ${tokensStr}${cachedStr}`);

      if (state.totalCost > 0) {
        console.log(`Cost: ${formatCost(state.totalCost)}`);
      }

      console.log();
      console.log("Cycle breakdown:");
      for (const cycleState of state.cycleHistory) {
        const cycleName = cycleState.cycle === 0
          ? "Repository Discovery"
          : (cycleNames[cycleState.cycle] ?? `Cycle ${cycleState.cycle}`);
        console.log(`  ${cycleState.cycle}. ${cycleName}: ${cycleState.filesWritten} files, ${formatCost(cycleState.cost)}`);
      }
    } else {
      console.log(`Done. Generated SysML model in .sysml/ (${state.totalFilesWritten} files). Cost: ${formatCost(state.totalCost)}`);
    }

    console.log();
    console.log("SysML model location: .sysml/");
    console.log("Entry point: .sysml/_model.sysml");
  }
}
