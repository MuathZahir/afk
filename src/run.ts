/**
 * `afk run` — drain the `ready-for-agent` queue in one batch pass, then exit.
 *
 * Thin driver over the shared host `Engine` (src/core/engine.ts): plan the runnable issues, run them
 * through implement → merge (conflict → Resolver) up to `maxParallel` at a time, then per completed
 * feature run verify → Fixer-loop → open the PR with evidence. The daemon (`afk watch`) drives the
 * exact same Engine continuously.
 */
import * as fs from "node:fs";
import { loadConfig } from "./core/config.js";
import { Engine } from "./core/engine.js";
import { pick } from "./core/planner.js";
import { isRateLimit } from "./core/sh.js";
import { Feature, Result } from "./core/types.js";

// ── bounded-concurrency pool ──────────────────────────────────────────────────
async function pool<T>(items: T[], limit: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const item = items[i++]; await fn(item); }
  });
  await Promise.all(workers);
}

(async () => {
  const cfg = loadConfig();
  console.log(`AFK starting on ${cfg.nwo} — base=${cfg.baseBranch}, parallel=${cfg.maxParallel}, cap=${cfg.maxIssues}\n`);
  const engine = new Engine(cfg);
  engine.cleanStartup();

  const results: Result[] = [];
  let stopped = false;
  let processed = 0;

  while (!stopped && processed < cfg.maxIssues) {
    const batch = pick(cfg.maxIssues - processed, {
      labelReady: cfg.labelReady,
      baseBranch: cfg.baseBranch,
      nwo: cfg.nwo,
      onAmbiguous: (n, reason) => engine.escalate(n, `#${n}`, reason),
      onDemote: (n, reason) => engine.demote(n, `#${n}`, reason),
    });
    if (batch.length === 0) break;
    console.log(`Round: ${batch.map((b) => `#${b.number}→${b.feature}`).join(", ")}`);
    engine.beginRound(); // fetch each DISTINCT base once this round
    await pool(batch, cfg.maxParallel, async (p) => {
      try { results.push(await engine.processIssue(p)); }
      catch (e) {
        if (isRateLimit(e)) { stopped = true; console.error(`\n⏸  Rate limit hit — stopping cleanly. Remaining issues stay ${cfg.labelReady}.`); }
        else { console.error(`✗ #${p.number}:`, e); engine.escalate(p.number, p.title, "Unexpected orchestrator error.", `\n\`\`\`\n${String(e).slice(0, 1500)}\n\`\`\``); results.push({ num: p.number, title: p.title, status: "error", feature: p.feature, base: p.base }); }
      }
    });
    processed += batch.length;
  }

  // ── per completed feature: verify → fix → PR (base-branch merges have no feature) ──
  const prFeatures: Feature[] = [];
  for (const feature of engine.features.values()) {
    try {
      if (engine.isFeatureComplete(feature)) await engine.finalizeFeature(feature);
      else await engine.openFeaturePR(feature, { verdict: null, unverifiedReason: null, evidenceMd: "" }); // refresh draft
      prFeatures.push(feature);
    } catch (e) {
      if (isRateLimit(e)) { console.error(`⏸  Rate limit during verify of ${feature.title} — leaving its PR draft.`); break; }
      console.error(`✗ finalize ${feature.title}:`, e);
    }
  }

  writeReport(results, prFeatures);
})();

function writeReport(results: Result[], features: Feature[]): void {
  const icon: Record<string, string> = { merged: "✅", rescued: "♻️", blocked: "🛟", timeout: "⏱️", conflict: "⚠️", "no-commits": "∅", error: "💥", question: "❓", stopped: "⏹️" };
  const lines = results.map((r) => `${icon[r.status] ?? "•"} #${r.num} ${r.title}  — ${r.status} → \`${r.feature}\``);
  const mergedN = results.filter((r) => r.status === "merged").length;
  // Per-effort bases: each result carries ITS base, so a loose issue on a non-config base counts right.
  const onFeature = results.filter((r) => r.status === "merged" && r.feature !== r.base).length;
  const onBase = results.filter((r) => r.status === "merged" && r.feature === r.base).length;
  const needHuman = results.length - mergedN;
  const summaryLine = onFeature > 0 && onBase > 0
    ? `**${onFeature}** issue(s) on feature branch(es), **${onBase}** with their own PR to their base branch (no feature), **${needHuman}** need a human.`
    : onFeature > 0
    ? `**${onFeature}** issue(s) landed on feature branch(es), **${needHuman}** need a human.`
    : onBase > 0
    ? `**${onBase}** issue(s) opened their own PR to their base branch (no epic/milestone), **${needHuman}** need a human.`
    : `**0** issues merged, **${results.length}** need a human.`;
  const report = [
    `# AFK run report`, ``, summaryLine, ``,
    `## Issues`, ``, ...lines, ``,
    `> Each feature is verified end-to-end before its PR goes ready. Check out a feature branch to`,
    `> test, then merge its PR. Sweep the rest with \`/triage\`.`,
  ].join("\n");
  fs.writeFileSync("AFK-REPORT.md", report);
  console.log(`\n${report}\n\nWritten to AFK-REPORT.md`);
}
