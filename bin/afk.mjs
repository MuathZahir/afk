#!/usr/bin/env node
/**
 * afk — autonomous GitHub issue worker. One CLI, three verbs:
 *
 *   afk init [project]     set up AFK in a project (token, worker image, skills, config)
 *   afk run                drain the ready-for-agent queue once, then exit (run from the project dir)
 *   afk watch              run the continuous daemon + local dashboard
 *   afk changelog          release notes from conventional commits since the last tag
 *
 * The orchestrator + sandcastle live HERE (in the afk package), not copied per-project — so the
 * target project only carries its config + prompt + Dockerfile, and `afk run` uses afk's own tsx.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const AFK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [cmd, ...rest] = process.argv.slice(2);

const node = (script, args = []) =>
  execFileSync(process.execPath, [script, ...args], { stdio: "inherit", cwd: process.cwd() });
const tsx = (script, args = []) =>
  execFileSync(process.execPath, [path.join(AFK, "node_modules", "tsx", "dist", "cli.mjs"), script, ...args],
    { stdio: "inherit", cwd: process.cwd() });

try {
  switch (cmd) {
    case "init": node(path.join(AFK, "src", "init.mjs"), rest); break;
    case "run": tsx(path.join(AFK, "src", "run.ts"), rest); break;
    case "watch": tsx(path.join(AFK, "src", "watch.ts"), rest); break;
    case "changelog": node(path.join(AFK, "src", "changelog.mjs"), rest); break;
    default:
      console.log(`afk — drain a GitHub ready-for-agent issue queue with isolated Claude Code workers.

Usage:
  afk init [project]   set up AFK in a project (token · worker image · skills · config)
  afk run              implement the queue once; each epic → one verified feature branch + PR
  afk watch            run the continuous daemon + local dashboard (monitor · merge · retry)
  afk changelog        release notes from conventional commits since the last tag

After \`afk init\`, the loop is:  /grill-with-docs → /to-issues → afk run (or afk watch)`);
      process.exit(cmd ? 1 : 0);
  }
} catch (e) {
  // child already streamed its own error to the terminal; just mirror the exit code
  process.exit(typeof e?.status === "number" ? e.status : 1);
}
