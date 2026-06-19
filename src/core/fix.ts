/**
 * Phase 1 — the Fixer and Resolver agents (Opus). Both run in a sandbox checked out on the FEATURE
 * branch and commit there directly (a git worktree on `feat/…` advances that branch), so the host
 * just re-verifies afterward.
 *
 *   Fixer    — given the Verifier's failing verdict, diagnose + fix the feature branch. Bounded loop.
 *   Resolver — re-create + resolve a merge conflict between an issue branch and the feature branch.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import { docker as dockerSandbox } from "@ai-hero/sandcastle/sandboxes/docker";
import { Resolved } from "./config.js";
import { Verdict } from "./types.js";
import { readJson, streamLogging } from "./sh.js";
import { cacheMounts } from "./cache.js";

const WORKER_IMAGE = "afk-worker";

export type AgentOutcome = { commits: number; blocked: any | null; worktreePath: string | undefined };

export type AgentOpts = { signal?: AbortSignal; onActivity?: (line: string) => void };

async function runOnFeature(
  cfg: Resolved,
  feature: string,
  model: string,
  promptFile: string,
  name: string,
  promptArgs: Record<string, string>,
  opts: AgentOpts = {},
): Promise<AgentOutcome> {
  let sandbox: sandcastle.Sandbox | undefined;
  try {
    opts.onActivity?.(`🛠 starting sandbox + running setup (\`${cfg.setup}\`)…`);
    sandbox = await sandcastle.createSandbox({
      sandbox: dockerSandbox({
        imageName: WORKER_IMAGE,
        mounts: cacheMounts(cfg),
      }),
      branch: feature,
      baseBranch: feature, // already exists
      hooks: { sandbox: { onSandboxReady: [{ command: cfg.setup, timeoutMs: cfg.absoluteTimeoutMs }] } },
    });
    opts.onActivity?.("✅ setup done — launching the agent");
    const afk = path.join(sandbox.worktreePath, ".afk");
    try { fs.rmSync(path.join(afk, "blocked.json"), { force: true }); } catch { /* none */ }
    const r = await sandbox.run({
      name,
      agent: sandcastle.claudeCode(model, { env: { CLAUDE_CODE_OAUTH_TOKEN: cfg.oauth } }),
      promptFile,
      completionSignal: "<promise>COMPLETE</promise>",
      idleTimeoutSeconds: cfg.idleTimeoutSec,
      signal: opts.signal,
      logging: streamLogging(path.join(".afk", "logs", `${name}.log`), (line) => opts.onActivity?.(line)),
      promptArgs,
    });
    return { commits: r.commits.length, blocked: readJson(path.join(afk, "blocked.json")), worktreePath: sandbox.worktreePath };
  } finally {
    if (sandbox) await sandbox.close().catch(() => {});
  }
}

/** Diagnose + fix a failing feature branch. The host re-verifies after. */
export function runFixer(
  cfg: Resolved,
  feature: { branch: string; title: string },
  verdict: Verdict,
  attempt: number,
  maxAttempts: number,
  opts: AgentOpts = {},
): Promise<AgentOutcome> {
  return runOnFeature(cfg, feature.branch, cfg.models.fix, ".sandcastle/fix-prompt.md", `fix-${feature.branch}-${attempt}`, {
    FEATURE_TITLE: feature.title,
    BRANCH: feature.branch,
    VERDICT_JSON: JSON.stringify(verdict, null, 2),
    ATTEMPT: String(attempt),
    MAX_ATTEMPTS: String(maxAttempts),
  }, opts);
}

/** Resolve a merge conflict between an issue branch and the feature branch, in a feature worktree. */
export function runResolver(
  cfg: Resolved,
  feature: string,
  issueBranch: string,
  issueJson: string,
  opts: AgentOpts = {},
): Promise<AgentOutcome> {
  return runOnFeature(cfg, feature, cfg.models.fix, ".sandcastle/resolve-prompt.md", `resolve-${issueBranch}`, {
    FEATURE_BRANCH: feature,
    ISSUE_BRANCH: issueBranch,
    ISSUE_JSON: issueJson,
  }, opts);
}
