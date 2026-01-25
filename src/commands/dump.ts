import { Command, Flags } from "@oclif/core";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import fg from "fast-glob";

export default class Dump extends Command {
  static description =
    "Dump all SysML model content to stdout (deterministic, non-agentic)";

  static examples = [
    "<%= config.bin %> dump",
    "<%= config.bin %> dump --path ./src",
    "<%= config.bin %> dump > model.txt",
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

    const sysmlDir = join(flags.path, ".sysml");
    const pattern = "**/*.sysml";

    // Find all .sysml files
    const sysmlFiles = await fg(pattern, {
      cwd: sysmlDir,
      onlyFiles: true,
      dot: false,
    });

    if (sysmlFiles.length === 0) {
      console.error("No .sysml files found.");
      return;
    }

    // Sort files for consistent output
    sysmlFiles.sort();

    for (const sysmlFile of sysmlFiles) {
      const fullPath = join(sysmlDir, sysmlFile);

      try {
        const content = await readFile(fullPath, "utf-8");
        console.log(`=== ${sysmlFile} ===`);
        console.log(content);
      } catch {
        console.error(`Error reading ${sysmlFile}`);
      }
    }
  }
}
