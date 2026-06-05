#!/usr/bin/env node
/**
 * One-shot AFK installer. Does EVERYTHING:
 *
 *   node scripts/install.mjs [path-to-project]   (defaults to current dir)
 *
 *   • saves your subscription token globally to ~/.afk/.env   (once, reused by every project)
 *   • builds the shared `afk-worker` Docker image with your skills baked in   (once; skipped if present)
 *   • installs the project deps (@ai-hero/sandcastle, @playwright/test, tsx)
 *   • auto-generates .sandcastle/afk.config.json from the project's package.json
 *   • copies the tiny harness (run.ts, prompts, gate) into the project
 *
 * After this, the only thing you ever type per project is:  npx tsx .sandcastle/run.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const AFK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = path.resolve(process.argv[2] ?? process.cwd());
const HOME_AFK = path.join(os.homedir(), ".afk");
const SKILLS_SRC = path.join(os.homedir(), ".claude", "skills");
const IMAGE = "afk-worker";
const DEFAULT_SKILLS = ["tdd", "find-docs", "diagnose", "web-design-guidelines"];

// shell:true on Windows so .cmd shims (npm, npx) spawn without EINVAL (Node 20+).
const WIN = process.platform === "win32";
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", shell: WIN, ...opts });
const shq = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: WIN, ...opts }).trim();
const ok = (m) => console.log(`✓ ${m}`);
const step = (m) => console.log(`\n• ${m}`);

if (!fs.existsSync(path.join(TARGET, "package.json"))) {
  console.error(`No package.json in ${TARGET}. Pass the project path: node scripts/install.mjs <project>`);
  process.exit(1);
}

// ── 1. global token (set once, reused everywhere) ─────────────────────────────
step("Token");
fs.mkdirSync(HOME_AFK, { recursive: true });
const globalEnv = path.join(HOME_AFK, ".env");
let token =
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
    for (const s of baked) fs.cpSync(path.join(SKILLS_SRC, s), path.join(imgDir, "skills", s), { recursive: true });
    ok(`baking skills: ${baked.join(", ") || "(none found in ~/.claude/skills)"}`);
    const buildArgs = process.platform === "win32" ? [] : ["--build-arg", `AGENT_UID=${process.getuid()}`, "--build-arg", `AGENT_GID=${process.getgid()}`];
    console.log(`  building ${IMAGE} (one-time, a few minutes)...`);
    sh("docker", ["build", "-t", IMAGE, ...buildArgs, imgDir]);
    ok(`${IMAGE} built`);
  }
}

// ── 3. copy harness into the project (no skills folder needed — they're in the image) ──
step("Harness");
const dstSc = path.join(TARGET, ".sandcastle");
fs.mkdirSync(path.join(dstSc, "lib"), { recursive: true });
for (const f of ["run.ts", "implement-prompt.md"]) fs.copyFileSync(path.join(AFK, ".sandcastle", f), path.join(dstSc, f));
for (const f of ["afk-gate.sh", "playwright.afk.config.ts"]) fs.copyFileSync(path.join(AFK, ".sandcastle", "lib", f), path.join(dstSc, "lib", f));
ok("copied run.ts, prompt, gate");

// ── 4. project deps ───────────────────────────────────────────────────────────
step("Dependencies");
sh(npmCmd(), ["install", "-D", "@ai-hero/sandcastle", "@playwright/test", "tsx"], { cwd: TARGET });
ok("@ai-hero/sandcastle, @playwright/test, tsx");

// ── 5. auto-generate config from package.json ─────────────────────────────────
step("Config");
const cfgPath = path.join(dstSc, "afk.config.json");
if (fs.existsSync(cfgPath)) {
  ok("afk.config.json already exists — left as-is");
} else {
  const pkg = JSON.parse(fs.readFileSync(path.join(TARGET, "package.json"), "utf8"));
  const s = pkg.scripts ?? {};
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const has = (d) => Boolean(deps?.[d]);
  const script = (...names) => { const n = names.find((x) => s[x]); return n ? `npm run ${n}` : ""; };
  const port = has("next") ? 3000 : has("vite") ? 5173 : has("react-scripts") ? 3000 : 3000;
  const setup = fs.existsSync(path.join(TARGET, "pnpm-lock.yaml")) ? "pnpm i --frozen-lockfile"
    : fs.existsSync(path.join(TARGET, "yarn.lock")) ? "yarn --frozen-lockfile"
    : fs.existsSync(path.join(TARGET, "package-lock.json")) ? "npm ci" : "npm install";
  const base = (() => { try { return shq("git", ["-C", TARGET, "symbolic-ref", "--short", "HEAD"]); } catch { return "main"; } })();
  const cfg = {
    baseBranch: base, push: false, maxParallel: 2, maxIssuesPerRun: 5, issueTimeoutMin: 30, model: "opus",
    setup,
    typecheck: script("typecheck", "type-check", "tsc") || (has("typescript") ? "npx tsc --noEmit" : ""),
    test: script("test"),
    dev: script("dev", "start"),
    baseUrl: `http://localhost:${port}`,
    labels: { ready: "ready-for-agent", human: "ready-for-human" },
  };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
  ok(`generated afk.config.json  (typecheck=${q(cfg.typecheck)} test=${q(cfg.test)} dev=${q(cfg.dev)} ${cfg.baseUrl})`);
  console.log("  → glance at it; auto-detection guesses, it doesn't know your project.");
}

// ── 6. .gitignore ─────────────────────────────────────────────────────────────
const gi = path.join(TARGET, ".gitignore");
const want = [".afk/", "AFK-REPORT.md", ".sandcastle/.env"];
const cur = fs.existsSync(gi) ? fs.readFileSync(gi, "utf8") : "";
const add = want.filter((w) => !cur.split("\n").some((l) => l.trim() === w));
if (add.length) fs.appendFileSync(gi, `\n# AFK\n${add.join("\n")}\n`);

console.log(`\n✅ Done. Run the loop:\n    cd ${path.relative(process.cwd(), TARGET) || "."}\n    /grill-me → /to-issues → npx tsx .sandcastle/run.ts\n`);

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
function npmCmd() { return "npm"; } // shell:true resolves npm.cmd on Windows
function argVal(flag) { const i = process.argv.indexOf(flag); return i > -1 ? process.argv[i + 1] : undefined; }
function q(v) { return v ? `"${v}"` : "∅"; }
