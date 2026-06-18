/**
 * Phase 1 — the Verifier. After every child issue of a feature has landed on its branch, bring the
 * app up *from that branch's own stack*, exercise every acceptance criterion, and emit a structured
 * verdict + evidence. Runs as a sandboxed Sonnet agent on the feature branch with the host Docker
 * socket mounted, so it owns `compose up → exercise → down -v` itself. The host stays deterministic:
 * it decides *when* to verify, injects the contract + criteria, and reads `.afk/verdict.json`.
 *
 * Graceful degradation (REDESIGN.md risk §): no compose stack / unsupported host / a stack that
 * won't boot never produces a false-green — it returns `unverified` with an honest reason.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import { docker as dockerSandbox } from "@ai-hero/sandcastle/sandboxes/docker";
import { Resolved } from "./config.js";
import { Verdict } from "./types.js";
import { readJson, slug } from "./sh.js";

const WORKER_IMAGE = "afk-worker";
const PROMPT = ".sandcastle/verify-prompt.md";
const DOCKER_SOCK = "/var/run/docker.sock";

export type VerifyResult =
  | { kind: "verdict"; verdict: Verdict; evidenceDir: string }
  | { kind: "unverified"; reason: string };

/** Does the repo look verifiable on this host? Compose stack present (or explicit verify.up), enabled, non-Windows. */
export function canVerify(cfg: Resolved, cwd = process.cwd()): { ok: true } | { ok: false; reason: string } {
  if (!cfg.verify.enabled) return { ok: false, reason: "verification disabled in afk.config" };
  if (process.platform === "win32" && !cfg.verify.up)
    return { ok: false, reason: "Docker-socket verification isn't supported on Windows hosts (named-pipe daemon) — set verify.up explicitly to override" };
  const hasCompose = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"].some((f) => fs.existsSync(path.join(cwd, f)));
  if (!hasCompose && !cfg.verify.up && !cfg.verify.appBoot)
    return { ok: false, reason: "no docker compose file and no verify.up/appBoot configured" };
  return { ok: true };
}

/**
 * Run the Verifier against a completed feature branch. `issuesJson` is the full JSON of the
 * feature's child issues (their bodies carry the acceptance criteria).
 */
export async function verifyFeature(
  cfg: Resolved,
  feature: { branch: string; title: string },
  issuesJson: string,
): Promise<VerifyResult> {
  const gate = canVerify(cfg);
  if (!gate.ok) return { kind: "unverified", reason: gate.reason };

  const featureSlug = slug(feature.title);
  // When the app is started directly (verify.appBoot) rather than by compose, it needs its deps —
  // run setup + reuse the package caches. A pure compose stack skips this (builds inside containers).
  const needsDeps = !!cfg.verify.appBoot;
  let sandbox: sandcastle.Sandbox | undefined;
  try {
    sandbox = await sandcastle.createSandbox({
      sandbox: dockerSandbox({
        imageName: WORKER_IMAGE,
        // Mount the host Docker socket so the in-sandbox agent drives `docker compose` on the host
        // daemon (verify-in-place, not docker-in-docker). canVerify already excluded Windows.
        mounts: [
          { hostPath: DOCKER_SOCK, sandboxPath: DOCKER_SOCK },
          ...(needsDeps ? [
            { hostPath: cfg.npmCacheDir, sandboxPath: "~/.npm" },
            { hostPath: cfg.nmCacheDir, sandboxPath: "node_modules" },
          ] : []),
        ],
      }),
      branch: feature.branch,
      baseBranch: feature.branch, // branch already exists; baseBranch is ignored
      ...(needsDeps ? { hooks: { sandbox: { onSandboxReady: [{ command: cfg.setup }] } } } : {}),
    });

    const afk = path.join(sandbox.worktreePath, ".afk");
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error(`verify hit the ${cfg.verify.timeoutSec}s cap`)), (cfg.verify.timeoutSec ?? 1200) * 1000);
    try {
      await sandbox.run({
        name: `verify-${feature.branch}`,
        agent: sandcastle.claudeCode(cfg.models.verify, { env: { CLAUDE_CODE_OAUTH_TOKEN: cfg.oauth } }),
        promptFile: PROMPT,
        completionSignal: "<promise>COMPLETE</promise>",
        idleTimeoutSeconds: cfg.idleTimeoutSec,
        signal: ac.signal,
        promptArgs: {
          FEATURE_TITLE: feature.title,
          FEATURE_SLUG: featureSlug,
          BRANCH: feature.branch,
          ISSUES_JSON: issuesJson,
          VERIFY_UP: cfg.verify.up ?? "",
          VERIFY_DOWN: cfg.verify.down ?? `docker compose -p verify_${featureSlug} down -v`,
          VERIFY_DB_RESET: cfg.verify.dbReset ?? "",
          VERIFY_APP_BOOT: cfg.verify.appBoot ?? "",
          BASE_URL: cfg.verify.baseUrl ?? "",
          VERIFY_SEED: cfg.verify.seed ?? "",
          BACKEND_ONLY: String(cfg.verify.backendOnly),
        },
      });
    } finally { clearTimeout(timer); }

    const verdict = readJson<Verdict>(path.join(afk, "verdict.json"));
    if (!verdict || typeof verdict.ok !== "boolean") {
      return { kind: "unverified", reason: "Verifier produced no readable verdict.json (it may have stalled or hit its timeout)." };
    }
    // Copy evidence out of the worktree before it's torn down.
    const out = fs.mkdtempSync(path.join(cfg.cacheRoot, "evidence-"));
    for (const sub of ["shots", "demo.gif"]) {
      const src = path.join(afk, sub);
      if (fs.existsSync(src)) fs.cpSync(src, path.join(out, sub), { recursive: true });
    }
    return { kind: "verdict", verdict, evidenceDir: out };
  } finally {
    if (sandbox) await sandbox.close().catch(() => {});
  }
}

/** Render a verdict as PR/issue-ready markdown — per-criterion table + summary. */
export function verdictMarkdown(v: Verdict): string {
  const rows = v.criteria.map((c) => `| ${c.pass ? "✅" : "❌"} | ${c.criterion} | ${c.evidence ?? ""} |`).join("\n");
  const head = `${v.ok ? "✅ **Verified**" : "❌ **Verification failed**"} — ${v.summary}`;
  const table = v.criteria.length ? `\n\n| | Criterion | Evidence |\n|---|---|---|\n${rows}` : "";
  return `${head}${table}`;
}
