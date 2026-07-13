/**
 * Load + normalize `.sandcastle/afk.config.json` into a single resolved object the engine reads.
 * Centralizes every default so `run` and `watch` can't drift apart, and so the legacy
 * `issueTimeoutMin` → `absoluteTimeoutMin` mapping lives in exactly one place.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Config, VerifyConfig } from "./types.js";
import { loadDotenv, slug, gh } from "./sh.js";

export type Resolved = {
  raw: Config;
  baseBranch: string;
  maxParallel: number;
  maxIssues: number;
  idleTimeoutSec: number;
  absoluteTimeoutMs: number;
  absoluteTimeoutMin: number;
  maxFixAttempts: number;
  models: { implement: string; verify: string; fix: string; classify: string; review: string; research: string };
  labelReady: string;
  labelHuman: string;
  verify: Required<Pick<VerifyConfig, "enabled" | "backendOnly">> & VerifyConfig;
  pollSeconds: number;
  dashboardPort: number;
  cache: boolean;
  setup: string;
  nwo: string;
  oauth: string;
  cacheRoot: string;
  npmCacheDir: string;
  nmCacheDir: string;
};

/**
 * Env injected into every in-sandbox Claude Code agent. Beyond auth, raise the Bash tool's
 * foreground timeout: monorepo test gates (cold-cache jest) routinely outlive Claude's 2m default,
 * which auto-backgrounds the command and sends the agent into a sleep/poll loop that wastes several
 * minutes per gate. 10m default / 20m ceiling keeps those runs in the foreground.
 */
export const agentEnv = (cfg: Resolved): Record<string, string> => ({
  CLAUDE_CODE_OAUTH_TOKEN: cfg.oauth,
  BASH_DEFAULT_TIMEOUT_MS: "600000",
  BASH_MAX_TIMEOUT_MS: "1200000",
});

/** Read config + env from the conventional locations and resolve all defaults. */
export function loadConfig(cwd = process.cwd()): Resolved {
  const raw: Config = JSON.parse(fs.readFileSync(path.join(cwd, ".sandcastle", "afk.config.json"), "utf8"));
  loadDotenv(path.join(cwd, ".sandcastle", ".env"));
  loadDotenv(path.join(os.homedir(), ".afk", ".env"));

  const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!oauth) {
    console.error("Missing required env var: CLAUDE_CODE_OAUTH_TOKEN (set it in ~/.afk/.env via `afk init`)");
    process.exit(1);
  }
  const nwo = gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]).trim();

  const model = raw.model ?? "opus";
  const implement = raw.models?.implement ?? model;
  const models = {
    implement,
    verify: raw.models?.verify ?? "sonnet",
    fix: raw.models?.fix ?? model,
    classify: raw.models?.classify ?? "haiku",
    review: raw.models?.review ?? "claude-sonnet-4-6",
    research: raw.models?.research ?? implement,
  };
  const absoluteTimeoutMs = (raw.absoluteTimeoutMin ?? raw.issueTimeoutMin ?? 90) * 60_000;
  const cacheRoot = path.join(os.homedir(), ".afk", "cache");

  return {
    raw,
    baseBranch: raw.baseBranch ?? "main",
    maxParallel: raw.maxParallel ?? 2,
    maxIssues: raw.maxIssuesPerRun ?? 5,
    idleTimeoutSec: (raw.idleTimeoutMin ?? 10) * 60,
    absoluteTimeoutMs,
    absoluteTimeoutMin: absoluteTimeoutMs / 60_000,
    maxFixAttempts: raw.maxFixAttempts ?? 1,
    models,
    labelReady: raw.labels?.ready ?? "ready-for-agent",
    labelHuman: raw.labels?.human ?? "ready-for-human",
    verify: {
      enabled: raw.verify?.enabled ?? true,
      backendOnly: raw.verify?.backendOnly ?? false,
      timeoutSec: raw.verify?.timeoutSec ?? 1200,
      ...raw.verify,
    },
    pollSeconds: raw.pollSeconds ?? 60,
    dashboardPort: raw.dashboardPort ?? 7777,
    cache: raw.cache ?? true,
    setup: raw.setup ?? "npm ci",
    nwo,
    oauth,
    cacheRoot,
    npmCacheDir: path.join(cacheRoot, "npm"),
    nmCacheDir: path.join(cacheRoot, "node-modules", slug(nwo)),
  };
}
