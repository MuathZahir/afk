/**
 * Phase 3 — the `afk watch` daemon. A long-running lifecycle manager (not a one-shot queue drain)
 * that drives the same shared `Engine` continuously:
 *
 *   poll ready issues → fill the bounded worker pool → as each lands, check if its feature is
 *   complete → verify + Fixer-loop + PR. Rate-limit → back off and auto-resume. Survives restarts by
 *   replaying its event log and reconciling against GitHub (open draft PRs + feature branches).
 *
 * The daemon owns no GitHub/LLM logic of its own — that all lives in `Engine`. It adds: the poll
 * loop, the concurrency budget, backoff, restart recovery, and a small control surface
 * (pause/resume/retry/merge/answer) that the dashboard calls.
 */
import * as path from "node:path";
import { Resolved } from "./config.js";
import { Engine, LIVE_VERIFY_LABEL } from "./engine.js";
import { pick } from "./planner.js";
import { gh, isRateLimit, slug } from "./sh.js";
import { Feature, Picked } from "./types.js";
import { Store } from "./state.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Daemon {
  readonly store: Store;
  private engine: Engine;
  private stopped = false;
  private paused = false;
  private active = 0;                       // agents currently running (implement + verify/fix)
  private inFlight = new Set<number>();     // issue numbers being implemented right now
  private finalizing = new Set<string>();   // feature branches mid verify/PR
  private backoffUntil = 0;
  /** Default rate-limit backoff when the reset time is unknown. */
  private static BACKOFF_MS = 5 * 60_000;

  constructor(private cfg: Resolved) {
    this.store = new Store(path.join(".afk", "state", "events.jsonl"));
    this.engine = new Engine(cfg, {
      log: (m) => console.log(m),
      emit: (e) => this.store.append(e),
      activity: (id, line) => this.store.activity(id, line),
    });
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────
  async start(): Promise<void> {
    this.store.append({ type: "daemon", status: "starting" });
    this.engine.cleanStartup();
    await this.reconcile();
    this.store.append({ type: "daemon", status: "polling" });
    console.log(`AFK daemon watching ${this.cfg.nwo} — base=${this.cfg.baseBranch}, pool=${this.cfg.maxParallel}, poll=${this.cfg.pollSeconds}s`);

    while (!this.stopped) {
      const now = Date.now();
      if (!this.paused && now >= this.backoffUntil) {
        try { this.tick(); } catch (e) { this.onError(e); }
      }
      await sleep(this.cfg.pollSeconds * 1000);
    }
  }

  stop(): void { this.stopped = true; this.store.append({ type: "daemon", status: "stopped" }); }

  /**
   * Graceful shutdown: stop polling, abort in-flight agents, and wait (up to `timeoutMs`) for their
   * sandboxes to tear down so we don't orphan Docker containers/worktrees. Stopped issues are left
   * `ready-for-agent`, so the next `afk watch` resumes them. Returns when idle or the cap is hit.
   */
  async shutdown(timeoutMs = 30_000): Promise<void> {
    this.stopped = true;
    this.store.append({ type: "daemon", status: "stopped" });
    this.engine.beginShutdown();
    const deadline = Date.now() + timeoutMs;
    while (this.engine.activeAgents > 0 && Date.now() < deadline) await sleep(500);
    if (this.engine.activeAgents > 0) console.log(`  ${this.engine.activeAgents} agent(s) didn't wind down in ${timeoutMs / 1000}s — exiting anyway (their containers are reaped on next start).`);
  }

  private onError(e: unknown): void {
    if (isRateLimit(e)) this.enterBackoff();
    else console.error("daemon tick error:", e);
  }
  private enterBackoff(): void {
    this.backoffUntil = Date.now() + Daemon.BACKOFF_MS;
    this.store.append({ type: "daemon", status: "backoff", note: `rate limit — auto-resuming in ${Daemon.BACKOFF_MS / 60_000}m` });
    console.log(`⏸  Rate limit — backing off ${Daemon.BACKOFF_MS / 60_000}m, then auto-resuming.`);
    // Restore the polling status once the window passes (without blocking the loop).
    setTimeout(() => { if (!this.paused && !this.stopped) this.store.append({ type: "daemon", status: "polling" }); }, Daemon.BACKOFF_MS).unref?.();
  }

  // ── one poll cycle: top up the worker pool ───────────────────────────────────
  private tick(): void {
    const free = this.cfg.maxParallel - this.active;
    let ready = 0;
    let picked: Picked[] = [];
    if (free > 0) {
      picked = pick(free, {
        labelReady: this.cfg.labelReady,
        baseBranch: this.cfg.baseBranch,
        nwo: this.cfg.nwo,
        onAmbiguous: (n, reason) => this.engine.escalate(n, `#${n}`, reason),
        onDemote: (n, reason) => this.engine.demote(n, `#${n}`, reason),
      }).filter((p) => !this.inFlight.has(p.number));
    }
    try { ready = JSON.parse(gh(["issue", "list", "--label", this.cfg.labelReady, "--state", "open", "--json", "number"])).length; } catch { /* ignore */ }
    this.store.append({ type: "poll", ready, picked: picked.length });
    for (const p of picked) this.launchIssue(p);
  }

  private launchIssue(p: Picked): void {
    this.active++; this.inFlight.add(p.number);
    this.engine.processIssue(p)
      .then((r) => { if (r.status === "merged") this.maybeFinalize(p); })
      .catch((e) => this.onError(e))
      .finally(() => { this.active--; this.inFlight.delete(p.number); });
  }

  /** After an issue lands, finalize its feature iff every child has now landed. Guarded once. */
  private maybeFinalize(p: Picked): void {
    const feature = this.engine.features.get(p.feature);
    if (!feature || this.finalizing.has(feature.branch)) return;
    if (!this.engine.isFeatureComplete(feature)) return;
    this.launchFinalize(feature);
  }

  private launchFinalize(feature: Feature): void {
    this.finalizing.add(feature.branch);
    this.active++;
    this.engine.finalizeFeature(feature)
      .catch((e) => this.onError(e))
      .finally(() => { this.active--; });
  }

  // ── restart recovery ─────────────────────────────────────────────────────────
  /**
   * Rebuild in-flight features from GitHub after a restart: any open PR on a `feat/*` branch is a
   * feature mid-flight. Reconstruct its merged-children set from the PR's `Closes #N` lines so a
   * verify interrupted by a crash gets re-run, and so the daemon won't reopen already-landed work.
   */
  private async reconcile(): Promise<void> {
    let prs: { number: number; headRefName: string; body: string; isDraft: boolean; labels?: { name: string }[] }[] = [];
    try { prs = JSON.parse(gh(["pr", "list", "--state", "open", "--json", "number,headRefName,body,isDraft,labels", "--limit", "100"])); } catch { return; }
    let recovered = 0;
    for (const pr of prs) {
      const branch = pr.headRefName;
      if (!branch.startsWith("feat/")) continue;
      const merged = [...(pr.body ?? "").matchAll(/Closes #(\d+)/g)].map((m) => Number(m[1]));
      if (merged.length === 0) continue;
      const m = branch.match(/^feat\/(\d+)-/);
      const key = m ? `epic-${m[1]}` : `ms-${slug(branch.replace(/^feat\//, ""))}`;
      const title = this.deriveTitle(key, branch);
      // A `verify:live-pending` label on the PR survives restarts — recover the draft-holding flag
      // from it (we can't tell WHICH child asked, so attribute it to all recovered children).
      const livePending = (pr.labels ?? []).some((l) => l.name === LIVE_VERIFY_LABEL);
      const feature: Feature = { key, title, branch, merged, liveVerify: livePending ? [...merged] : [] };
      this.engine.features.set(branch, feature);
      recovered++;
      // A draft PR whose children have all closed = a verify we never finished. Re-finalize it.
      if (pr.isDraft && this.engine.isFeatureComplete(feature)) this.launchFinalize(feature);
    }
    if (recovered) console.log(`Reconciled ${recovered} in-flight feature(s) from open PRs.`);
  }
  private deriveTitle(key: string, branch: string): string {
    if (key.startsWith("epic-")) {
      try { return JSON.parse(gh(["issue", "view", key.replace("epic-", ""), "--json", "title"])).title; } catch { /* fall through */ }
    }
    return branch.replace(/^feat\/\d*-?/, "").replace(/-/g, " ");
  }

  // ── control surface (dashboard actions) ───────────────────────────────────────
  pause(): void { this.paused = true; this.store.append({ type: "daemon", status: "paused" }); }
  resume(): void { this.paused = false; this.backoffUntil = 0; this.store.append({ type: "daemon", status: "resumed" }); this.store.append({ type: "daemon", status: "polling" }); }

  /** Stop a single running agent (the dashboard's per-worker stop button). */
  stopAgent(id: string): boolean { return this.engine.stopAgent(id); }

  /** Re-queue an escalated issue: swap the human label back to ready so the next poll re-picks it. */
  retry(issue: number): void {
    try { gh(["issue", "edit", String(issue), "--remove-label", this.cfg.labelHuman, "--add-label", this.cfg.labelReady]); } catch { /* labels */ }
    this.store.append({ type: "issue-state", issue, title: `#${issue}`, feature: null, state: "queued", note: "re-queued from dashboard" });
  }

  /** Merge a feature's ready PR from the dashboard. */
  merge(featureKey: string): { ok: boolean; error?: string } {
    const feature = [...this.engine.features.values()].find((f) => f.key === featureKey);
    if (!feature) return { ok: false, error: "unknown feature" };
    try {
      gh(["pr", "merge", feature.branch, "--squash", "--delete-branch"]);
      this.store.append({ type: "feature-state", feature: feature.key, title: feature.title, state: "merged" });
      return { ok: true };
    } catch (e) { return { ok: false, error: String((e as Error)?.message ?? e) }; }
  }

  /**
   * Answer an agent's clarifying question: post it as an issue comment and re-queue the issue, so
   * the next run resumes with the answer in context (the prompt includes issue comments). Question
   * ids are `q-<issue>`, so the issue number is recoverable.
   */
  answer(id: string, text: string): void {
    this.store.append({ type: "answer", id, answer: text });
    const issue = Number(id.replace(/^q-/, ""));
    if (!Number.isFinite(issue)) return;
    try { gh(["issue", "comment", String(issue), "--body", `> *Answer via AFK dashboard.*\n\n${text}`]); } catch { /* ignore */ }
    this.retry(issue);
  }
}
