import { Command, Flags } from "@oclif/core";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { findAuFiles, getSourceFromAuPath } from "../lib/au-paths.js";
import { parseAuFile, stringifyForInference } from "../lib/au-yaml.js";

export default class Dump extends Command {
  static description =
    "Dump all agent understanding to stdout (deterministic, non-agentic)";

  static examples = [
    "<%= config.bin %> dump",
    "<%= config.bin %> dump --path ./src",
    "<%= config.bin %> dump > understanding.txt",
  ];

  static flags = {
    path: Flags.string({
      char: "p",
      description: "Root path to dump",
      default: ".",
    }),
    "with-meta": Flags.boolean({
      description: "Include meta block (timestamps, hashes) in output",
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Dump);

    const { files: auFiles } = await findAuFiles(flags.path, true);

    if (auFiles.length === 0) {
      console.error("No .au files found.");
      return;
    }

    for (const auFile of auFiles) {
      const sourcePath = getSourceFromAuPath(auFile);
      const fullAuPath = join(flags.path, auFile);

      try {
        const content = await readFile(fullAuPath, "utf-8");
        console.log(`=== ${sourcePath} ===`);
        if (flags["with-meta"]) {
          console.log(content);
        } else {
          const doc = parseAuFile(content);
          console.log(stringifyForInference(doc));
        }
      } catch {
        console.error(`Error reading ${auFile}`);
      }
    }
  }
}
