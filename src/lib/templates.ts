import { Eta } from "eta";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const eta = new Eta({
  views: join(__dirname, "../templates"),
  autoEscape: false, // Prompts don't need HTML escaping
});

export function render(template: string, data?: object): string {
  return eta.render(template, data ?? {});
}
