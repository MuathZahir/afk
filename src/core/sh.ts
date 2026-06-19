/**
 * Shared shells + tiny pure helpers used across the host engine (run + watch).
 *
 * `gh` / `git` / `docker` are thin `execFileSync` wrappers — the host is deterministic and never
 * needs an LLM to talk to GitHub or git. Everything here is environment-agnostic and unit-testable
 * (the pure helpers) or a one-line process shell (the rest).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import type { AgentStreamEvent, LoggingOption } from "@ai-hero/sandcastle";

export function gh(args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
export function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
export function docker(args: string[], opts: { timeoutMs?: number } = {}): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: opts.timeoutMs });
}

export function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name} (set it in ~/.afk/.env via \`afk init\`)`);
    process.exit(1);
  }
  return v;
}

export function loadDotenv(file: string): void {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

/** True for any error message that looks like a subscription rate / quota / overload limit. */
export const isRateLimit = (e: unknown): boolean =>
  /rate.?limit|usage limit|quota exceeded|429|overloaded/i.test(String((e as Error)?.message ?? e));

/** Slugify a title into a branch-safe, ≤50-char token. Deterministic — unit-tested. */
export const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "feature";

/** A user-facing message explaining why AFK won't run with a dirty host working tree. */
export const dirtyTreeMessage = (files: string[]): string =>
  `\n✖ AFK can't run: this repo has ${files.length} uncommitted change(s).\n` +
  `  AFK lands work by switching branches and merging in THIS working tree, which needs it clean.\n` +
  `  Commit or stash your changes (or 'git reset --hard' if they're leftovers from a crashed run),\n` +
  `  then run again. Changed files:\n` +
  files.slice(0, 25).map((f) => `    ${f}`).join("\n") +
  (files.length > 25 ? `\n    …and ${files.length - 25} more` : "");

export const readJson = <T = any>(f: string): T | null => {
  try { return JSON.parse(fs.readFileSync(f, "utf8")) as T; } catch { return null; }
};

/**
 * Build a sandcastle `logging` option that funnels the agent's live stream (assistant text + tool
 * calls) to `onLine`, while still draining the full log to `logPath`. Text chunks are coalesced into
 * readable lines (flushed on a tool call, a newline, or length) so the dashboard shows "what the
 * agent is saying / doing" without a flood of token-deltas.
 */
export function streamLogging(logPath: string, onLine: (line: string) => void): LoggingOption {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  let buf = "";
  const flush = () => { const t = buf.trim(); buf = ""; if (t) onLine(t.length > 240 ? t.slice(0, 240) + "…" : t); };
  const onAgentStreamEvent = (e: AgentStreamEvent) => {
    try {
      if (e.type === "text") { buf += e.message; if (buf.length > 240 || buf.includes("\n")) flush(); }
      else { flush(); const a = (e.formattedArgs || "").replace(/\s+/g, " ").slice(0, 120); onLine(`🔧 ${e.name}${a ? " " + a : ""}`); }
    } catch { /* a slow consumer must never break the run */ }
  };
  return { type: "file", path: logPath, onAgentStreamEvent };
}
export const readText = (f: string): string | null => {
  try { return fs.readFileSync(f, "utf8"); } catch { return null; }
};
