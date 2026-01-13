import { Command, Flags } from "@oclif/core";
import { Validator } from "../lib/validator.js";
import { Output } from "../lib/output.js";

export default class Validate extends Command {
  static description =
    "Validate AU documentation coverage and structural integrity (deterministic, non-agentic)";

  static examples = [
    "<%= config.bin %> validate",
    "<%= config.bin %> validate --path ./src",
    "<%= config.bin %> validate --verbose",
  ];

  static flags = {
    path: Flags.string({
      char: "p",
      description: "Root path to validate",
      default: ".",
    }),
    verbose: Flags.boolean({
      char: "v",
      description: "Show detailed output",
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Validate);
    const out = new Output({ verbose: flags.verbose });

    out.info("Validating AU coverage...");

    const validator = new Validator();
    const result = await validator.validate(flags.path);

    const totalIssues = Validator.getIssueCount(result);

    // Coverage Issues
    if (result.uncovered.length > 0) {
      out.header("Coverage Issues");
      for (const item of result.uncovered) {
        out.item(`${item} - no .au file`);
      }
      console.log();
    }

    // Contents Issues
    if (result.contentsIssues.length > 0) {
      out.header("Contents Issues");
      for (const issue of result.contentsIssues) {
        if (issue.missing.length > 0) {
          out.item(`${issue.path} - missing: ${issue.missing.join(", ")}`);
        }
        if (issue.extra.length > 0) {
          out.item(`${issue.path} - extra: ${issue.extra.join(", ")}`);
        }
      }
      console.log();
    }

    // Orphaned .au Files
    if (result.orphans.length > 0) {
      out.header("Orphaned .au Files");
      for (const orphan of result.orphans) {
        out.item(`${orphan} - source not found`);
      }
      console.log();
    }

    // Stale Understanding
    if (result.stale.length > 0) {
      out.header("Stale Understanding");
      for (const stale of result.stale) {
        out.item(`${stale} - source has changed`);
      }
      console.log();
    }

    // Summary
    if (totalIssues === 0) {
      out.success("All validations passed");
    } else {
      out.warn(`Summary: ${totalIssues} issue${totalIssues === 1 ? "" : "s"} found`);
      process.exit(1);
    }
  }
}
