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
import { readJson } from "./sh.js";

const WORKER_IMAGE = "afk-worker";

export type AgentOutcome = { commits: number; blocked: any | null; worktreePath: string | undefined };

async function runOnFeature(
  cfg: Resolved,
  feature: string,
  model: string,
  promptFile: string,
  name: string,
  promptArgs: Record<string, string>,
): Promise<AgentOutcome> {
  let sandbox: sandcastle.Sandbox | undefined;
  try {
    sandbox = await sandcastle.createSandbox({
      sandbox: dockerSandbox({
        imageName: WORKER_IMAGE,
        mounts: process.platform === "win32" ? [] : [
          { hostPath: cfg.npmCacheDir, sandboxPath: "~/.npm" },
          { hostPath: cfg.nmCacheDir, sandboxPath: "node_modules" },
        ],
      }),
      branch: feature,
      baseBranch: feature, // already exists
      hooks: { sandbox: { onSandboxReady: [{ command: cfg.setup }] } },
    });
    const afk = path.join(sandbox.worktreePath, ".afk");
    try { fs.rmSync(path.join(afk, "blocked.json"), { force: true }); } catch { /* none */ }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error(`${name} hit the ${cfg.absoluteTimeoutMin}m cap`)), cfg.absoluteTimeoutMs);
    let commits = 0;
    try {
      const r = await sandbox.run({
        name,
        agent: sandcastle.claudeCode(model, { env: { CLAUDE_CODE_OAUTH_TOKEN: cfg.oauth } }),
        promptFile,
        completionSignal: "<promise>COMPLETE</promise>",
        idleTimeoutSeconds: cfg.idleTimeoutSec,
        signal: ac.signal,
        promptArgs,
      });
      commits = r.commits.length;
    } finally { clearTimeout(timer); }
    return { commits, blocked: readJson(path.join(afk, "blocked.json")), worktreePath: sandbox.worktreePath };
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
): Promise<AgentOutcome> {
  return runOnFeature(cfg, feature.branch, cfg.models.fix, ".sandcastle/fix-prompt.md", `fix-${feature.branch}-${attempt}`, {
    FEATURE_TITLE: feature.title,
    BRANCH: feature.branch,
    VERDICT_JSON: JSON.stringify(verdict, null, 2),
    ATTEMPT: String(attempt),
    MAX_ATTEMPTS: String(maxAttempts),
  });
}

/** Resolve a merge conflict between an issue branch and the feature branch, in a feature worktree. */
export function runResolver(
  cfg: Resolved,
  feature: string,
  issueBranch: string,
  issueJson: string,
): Promise<AgentOutcome> {
  return runOnFeature(cfg, feature, cfg.models.fix, ".sandcastle/resolve-prompt.md", `resolve-${issueBranch}`, {
    FEATURE_BRANCH: feature,
    ISSUE_BRANCH: issueBranch,
    ISSUE_JSON: issueJson,
  });
}
