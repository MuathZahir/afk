/**
 * Shared shells + tiny pure helpers used across the host engine (run + watch).
 *
 * `gh` / `git` / `docker` are thin `execFileSync` wrappers — the host is deterministic and never
 * needs an LLM to talk to GitHub or git. Everything here is environment-agnostic and unit-testable
 * (the pure helpers) or a one-line process shell (the rest).
 */
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";

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

export const readJson = <T = any>(f: string): T | null => {
  try { return JSON.parse(fs.readFileSync(f, "utf8")) as T; } catch { return null; }
};
export const readText = (f: string): string | null => {
  try { return fs.readFileSync(f, "utf8"); } catch { return null; }
};
