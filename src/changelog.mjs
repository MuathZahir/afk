#!/usr/bin/env node
/**
 * `afk changelog` — release notes from Conventional Commits since the last tag.
 *
 *   afk changelog                 print notes for <last tag>..HEAD
 *   afk changelog --from v1.2.0   override the starting ref
 *   afk changelog --write         prepend the notes to CHANGELOG.md
 *   afk changelog --release v1.3.0  create a GitHub Release with these notes (implies a tag)
 *
 * The AFK workers write `feat(...)` / `fix(...)` commit subjects, and each feature lands via a
 * `feat: <milestone>` merge — so the history is already Conventional-Commit shaped.
 */
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";

const git = (args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const gh = (args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const arg = (flag) => { const i = process.argv.indexOf(flag); return i > -1 ? process.argv[i + 1] : undefined; };
const has = (flag) => process.argv.includes(flag);

const from = arg("--from") ?? (() => { try { return git(["describe", "--tags", "--abbrev=0"]); } catch { return ""; } })();
const range = from ? `${from}..HEAD` : "HEAD";

// Conventional-Commit groups, in display order.
const GROUPS = [
  ["feat", "🚀 Features"], ["fix", "🐛 Fixes"], ["perf", "⚡ Performance"],
  ["refactor", "♻️ Refactors"], ["docs", "📝 Docs"], ["test", "✅ Tests"],
  ["build", "📦 Build"], ["ci", "🔧 CI"], ["chore", "🧹 Chores"],
];
const bucket = Object.fromEntries(GROUPS.map(([k]) => [k, []]));

const subjects = git(["log", range, "--format=%s|%h"]).split("\n").filter(Boolean);
const CC = /^(\w+)(?:\(([^)]+)\))?(!)?:\s+(.+)$/;
for (const line of subjects) {
  const [subject, sha] = line.split("|");
  const m = subject.match(CC);
  if (!m) continue;
  const [, type, scope, bang, desc] = m;
  if (!bucket[type]) continue;             // skip non-standard types
  const scopeTag = scope ? `**${scope}:** ` : "";
  const breaking = bang ? "💥 " : "";
  bucket[type].push(`- ${breaking}${scopeTag}${desc} (${sha})`);
}

const version = arg("--release") ?? "Unreleased";
const sections = GROUPS
  .filter(([k]) => bucket[k].length)
  .map(([k, title]) => `### ${title}\n\n${bucket[k].join("\n")}`);
const notes = sections.length ? sections.join("\n\n") : "_No conventional-commit changes in range._";
const header = `## ${version}${from ? `  (since ${from})` : ""}`;
const out = `${header}\n\n${notes}\n`;

console.log(out);

if (has("--write")) {
  const prev = fs.existsSync("CHANGELOG.md") ? fs.readFileSync("CHANGELOG.md", "utf8") : "# Changelog\n";
  const head = prev.startsWith("# ") ? prev.slice(0, prev.indexOf("\n") + 1) : "# Changelog\n";
  const rest = prev.slice(head.length);
  fs.writeFileSync("CHANGELOG.md", `${head}\n${out}${rest}`);
  console.error("✓ prepended to CHANGELOG.md");
}

const releaseTag = arg("--release");
if (releaseTag) {
  try {
    gh(["release", "create", releaseTag, "--title", releaseTag, "--notes", notes]);
    console.error(`✓ created GitHub Release ${releaseTag}`);
  } catch (e) {
    console.error(`! gh release create failed: ${String(e?.message ?? e).split("\n")[0]}`);
  }
}
