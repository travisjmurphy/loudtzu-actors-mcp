// Regenerates src/actors.generated.json from the Actors' own .actor/input_schema.json files.
// Usage: node scripts/gen-actors.mjs [actorsDir]   (or set ACTORS_DIR; default ./actors)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const actorsDir = process.argv[2] ?? process.env.ACTORS_DIR ?? "./actors";
const catalog = JSON.parse(fs.readFileSync(path.join(here, "catalog.json"), "utf8"));
const out = catalog.map((c) => {
  const schema = JSON.parse(fs.readFileSync(path.join(actorsDir, c.actor, ".actor", "input_schema.json"), "utf8"));
  return { ...c, apifyInputSchema: schema };
});
fs.writeFileSync(path.join(here, "..", "src", "actors.generated.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${out.length} actors`);
