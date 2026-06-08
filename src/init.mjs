#!/usr/bin/env node
/**
 * `afk init [project]` — one-shot setup. Does everything:
 *   • saves your Claude subscription token to ~/.afk/.env  (once, reused by every project)
 *   • builds the shared `afk-worker` Docker image with your skills baked in  (once; skip if present)
 *   • copies the per-project harness (prompt, Dockerfile, make-gif) into .sandcastle/
 *   • auto-generates .sandcastle/afk.config.json from the project's package.json
 *   • updates .gitignore
 *
 * The orchestrator itself is NOT copied — it lives in the afk package and runs via `afk run`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const AFK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = path.resolve(process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : process.cwd());
const HOME_AFK = path.join(os.homedir(), ".afk");
const SKILLS_SRC = path.join(os.homedir(), ".claude", "skills");
const IMAGE = "afk-worker";
// frontend-design (not web-design-guidelines) is the UI reviewer; find-docs = context7 docs.
const DEFAULT_SKILLS = ["tdd", "find-docs", "diagnose", "frontend-design"];

const WIN = process.platform === "win32";
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", shell: WIN, ...opts });
const shq = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: WIN, ...opts }).trim();
const ok = (m) => console.log(`✓ ${m}`);
const step = (m) => console.log(`\n• ${m}`);

if (!fs.existsSync(path.join(TARGET, "package.json"))) {
  console.error(`No package.json in ${TARGET}. Pass the project path: afk init <project>`);
  process.exit(1);
}

// ── 1. global token (set once, reused everywhere) ─────────────────────────────
step("Token");
fs.mkdirSync(HOME_AFK, { recursive: true });
const globalEnv = path.join(HOME_AFK, ".env");
const token =
  process.env.CLAUDE_CODE_OAUTH_TOKEN ||
  readEnv(globalEnv).CLAUDE_CODE_OAUTH_TOKEN ||
  readEnv(path.join(TARGET, ".sandcastle", ".env")).CLAUDE_CODE_OAUTH_TOKEN;
if (token) {
  fs.writeFileSync(globalEnv, `CLAUDE_CODE_OAUTH_TOKEN=${token}\n`);
  ok(`token saved to ${globalEnv} (reused by all projects)`);
} else {
  console.log(`  ! No token found. Run \`claude setup-token\`, then:`);
  console.log(`      setx CLAUDE_CODE_OAUTH_TOKEN <token>   (or add it to ${globalEnv})`);
}

// ── 2. shared worker image (built once, skills baked in) ──────────────────────
step("Worker image");
let dockerUp = true;
try { shq("docker", ["info"]); } catch { dockerUp = false; }
if (!dockerUp) {
  console.log("  ! Docker isn't running — skipping image build. Start Docker and re-run.");
} else {
  const exists = (() => { try { shq("docker", ["image", "inspect", IMAGE]); return true; } catch { return false; } })();
  if (exists && !process.argv.includes("--rebuild")) {
    ok(`${IMAGE} already built (use --rebuild to refresh skills)`);
  } else {
    const imgDir = path.join(HOME_AFK, "image");
    fs.rmSync(imgDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(imgDir, "skills"), { recursive: true });
    fs.copyFileSync(path.join(AFK, ".sandcastle", "Dockerfile"), path.join(imgDir, "Dockerfile"));
    const wanted = argVal("--skills")?.split(",") ?? DEFAULT_SKILLS;
    const baked = wanted.filter((s) => fs.existsSync(path.join(SKILLS_SRC, s)));
    const missing = wanted.filter((s) => !fs.existsSync(path.join(SKILLS_SRC, s)));
    for (const s of baked) fs.cpSync(path.join(SKILLS_SRC, s), path.join(imgDir, "skills", s), { recursive: true, dereference: true });
    ok(`baking skills: ${baked.join(", ") || "(none found in ~/.claude/skills)"}`);
    if (missing.length) console.log(`  ! not found in ${SKILLS_SRC}, skipped: ${missing.join(", ")} — install them and re-run with --rebuild`);
    const buildArgs = WIN ? [] : ["--build-arg", `AGENT_UID=${process.getuid()}`, "--build-arg", `AGENT_GID=${process.getgid()}`];
    console.log(`  building ${IMAGE} (one-time, a few minutes)...`);
    sh("docker", ["build", "-t", IMAGE, ...buildArgs, imgDir]);
    ok(`${IMAGE} built`);
  }
}

// ── 3. copy the per-project harness (prompt + Dockerfile + make-gif; NOT the orchestrator) ──
step("Harness");
const dstSc = path.join(TARGET, ".sandcastle");
fs.mkdirSync(path.join(dstSc, "lib"), { recursive: true });
fs.copyFileSync(path.join(AFK, ".sandcastle", "implement-prompt.md"), path.join(dstSc, "implement-prompt.md"));
fs.copyFileSync(path.join(AFK, ".sandcastle", "Dockerfile"), path.join(dstSc, "Dockerfile"));
fs.copyFileSync(path.join(AFK, ".sandcastle", "lib", "make-gif.sh"), path.join(dstSc, "lib", "make-gif.sh"));
ok("copied implement-prompt.md, Dockerfile, lib/make-gif.sh");

// ── 4. auto-generate config from package.json ─────────────────────────────────
step("Config");
const cfgPath = path.join(dstSc, "afk.config.json");
if (fs.existsSync(cfgPath)) {
  ok("afk.config.json already exists — left as-is");
} else {
  // The worker installs INSIDE a Linux container. `npm ci` from a host (Windows/macOS) lockfile
  // skips the container's platform-specific native binaries (npm bug #4828). So for npm, regenerate
  // a Linux install then restore the tracked lockfile so the worktree stays git-clean.
  const setup = fs.existsSync(path.join(TARGET, "pnpm-lock.yaml")) ? "pnpm i"
    : fs.existsSync(path.join(TARGET, "yarn.lock")) ? "yarn"
      : "rm -f package-lock.json && npm install --no-audit --no-fund && git checkout -- package-lock.json 2>/dev/null; true";
  const base = (() => { try { return shq("git", ["-C", TARGET, "symbolic-ref", "--short", "HEAD"]); } catch { return "main"; } })();
  const cfg = {
    baseBranch: base, maxParallel: 2, maxIssuesPerRun: 5, issueTimeoutMin: 30, model: "opus",
    setup,
    labels: { ready: "ready-for-agent", human: "ready-for-human" },
  };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
  ok(`generated afk.config.json  (base=${base})`);
  console.log("  → glance at it; `setup` is auto-detected and may need a tweak for monorepos.");
}

// ── 5. .gitignore ─────────────────────────────────────────────────────────────
const gi = path.join(TARGET, ".gitignore");
const want = [".afk/", "AFK-REPORT.md", ".sandcastle/.env", ".sandcastle/logs/", ".sandcastle/worktrees/"];
const cur = fs.existsSync(gi) ? fs.readFileSync(gi, "utf8") : "";
const add = want.filter((w) => !cur.split("\n").some((l) => l.trim() === w));
if (add.length) fs.appendFileSync(gi, `\n# AFK\n${add.join("\n")}\n`);

console.log(`\n✅ Done. The loop:\n    cd ${path.relative(process.cwd(), TARGET) || "."}\n    /grill-with-docs → /to-issues (assign a milestone per feature) → afk run\n`);

// ── helpers ───────────────────────────────────────────────────────────────────
function readEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const l of fs.readFileSync(file, "utf8").split("\n")) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}
function argVal(flag) { const i = process.argv.indexOf(flag); return i > -1 ? process.argv[i + 1] : undefined; }
