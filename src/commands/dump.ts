import { Command, Flags } from "@oclif/core";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { findAuFiles, getSourceFromAuPath } from "../lib/au-paths.js";

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
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Dump);

    const auFiles = await findAuFiles(flags.path, true);

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
        console.log(content);
      } catch {
        console.error(`Error reading ${auFile}`);
      }
    }
  }
}
