#!/usr/bin/env node
/**
 * Copy the AFK harness into another project.
 *
 *   node scripts/install.mjs <path-to-target-project>
 *
 * Copies .sandcastle/ (the engine config), seeds afk.config.json + .env from the examples,
 * ensures the target .gitignore excludes run artifacts, and prints the remaining manual steps.
 * Re-running is safe: it never overwrites an existing afk.config.json or .env.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.resolve(process.argv[2] ?? "");
if (!process.argv[2] || !fs.existsSync(target)) {
  console.error("Usage: node scripts/install.mjs <path-to-target-project>");
  process.exit(1);
}

const srcSc = path.join(here, ".sandcastle");
const dstSc = path.join(target, ".sandcastle");

// 1. copy the .sandcastle harness (skip secrets/state and the example->real seeds)
fs.cpSync(srcSc, dstSc, {
  recursive: true,
  filter: (s) => !/[\\/](\.env|afk\.config\.json|test-results|video\.webm|gate\.json)$/.test(s),
});

// 2. seed real config files from examples only if absent
const seed = (ex, real) => {
  const r = path.join(dstSc, real);
  if (!fs.existsSync(r)) fs.copyFileSync(path.join(dstSc, ex), r);
};
seed("afk.config.example.json", "afk.config.json");
seed(".env.example", ".env");

// 3. ensure .gitignore excludes run artifacts + secrets
const gi = path.join(target, ".gitignore");
const want = [".afk/", "AFK-REPORT.md", ".sandcastle/.env", ".sandcastle/afk.config.json"];
const cur = fs.existsSync(gi) ? fs.readFileSync(gi, "utf8") : "";
const add = want.filter((w) => !cur.split("\n").some((l) => l.trim() === w));
if (add.length) fs.appendFileSync(gi, `\n# AFK\n${add.join("\n")}\n`);

console.log(`✓ AFK harness copied to ${path.relative(process.cwd(), dstSc) || dstSc}\n`);
console.log("Next steps in the target project:");
console.log("  1. npm i -D @ai-hero/sandcastle @playwright/test tsx");
console.log("  2. claude setup-token   → paste into .sandcastle/.env");
console.log("  3. edit .sandcastle/afk.config.json (typecheck / test / dev / baseUrl / baseBranch)");
console.log("  4. vendor skills into .sandcastle/skills/  (see its README.md)");
console.log("  5. ensure Docker is running + `gh auth status` is logged in");
console.log("  6. /grill-me → /to-issues → npx tsx .sandcastle/run.ts");
