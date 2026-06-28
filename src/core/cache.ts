/**
 * Dependency-cache bind mounts (the thing that turns "npm install every run" into "seconds after the
 * first"). Two mounts: the npm tarball cache (`~/.npm`, concurrency-safe) and the extracted
 * `node_modules`. Sandcastle normalizes Windows host paths (`C:\…` → `C:/…`) and Docker Desktop
 * accepts that, so these work cross-platform — earlier AFK builds disabled them on Windows out of
 * caution.
 *
 * Because we can't assume every host has Docker file-sharing wired up, we *probe* once: spin a
 * throwaway container with the mount and see if it starts. If it doesn't (or `cache:false` in
 * config), we fall back to no caching — slower, but correct — instead of failing every worker.
 */
import { execFileSync } from "node:child_process";
import type { MountConfig } from "@ai-hero/sandcastle";
import { Resolved } from "./config.js";

const WORKER_IMAGE = "afk-worker";
let decided: MountConfig[] | null = null; // memoized per process (one daemon = one repo)

/** The cache mounts for this host, deciding once whether bind-mounts work here. */
export function cacheMounts(cfg: Resolved): MountConfig[] {
  if (decided !== null) return decided;
  if (cfg.cache === false) { console.log("📦 dependency cache: off (cache:false in afk.config)"); return (decided = []); }

  const mounts: MountConfig[] = [
    { hostPath: cfg.npmCacheDir, sandboxPath: "~/.npm" },
    // Use the absolute container path, not the relative "node_modules". Sandcastle resolves a
    // relative sandboxPath with Node's platform-aware path.resolve(), which on Windows turns the
    // POSIX repo dir into a drive-prefixed Windows path (C:\home\agent\workspace\node_modules) and
    // Docker rejects the resulting `-v` arg with "too many colons". An already-absolute POSIX path
    // is left untouched (path.win32.isAbsolute("/…") === true), so it survives correctly.
    { hostPath: cfg.nmCacheDir, sandboxPath: "/home/agent/workspace/node_modules" },
  ];
  // Probe: can a container actually start with this bind mount on this host? (Docker translates
  // forward-slashed Windows paths fine; `--entrypoint true` just exits 0 if the mount is valid.)
  const probeArg = `${cfg.npmCacheDir.replace(/\\/g, "/")}:/probe`;
  try {
    execFileSync("docker", ["run", "--rm", "--entrypoint", "true", "-v", probeArg, WORKER_IMAGE],
      { stdio: "ignore", timeout: 60_000 });
    console.log("📦 dependency cache: on (bind mounts working — installs reused across runs)");
    return (decided = mounts);
  } catch (e) {
    console.log(`📦 dependency cache: OFF — bind-mount probe failed, so installs won't be cached (slower).`);
    console.log(`   ${String((e as Error)?.message ?? e).split("\n")[0]}`);
    console.log(`   On Windows: enable Docker Desktop file sharing for your home drive, or run AFK under WSL2.`);
    return (decided = []);
  }
}

/** True when caching is active for this host — for honest "first install is slow" messaging. */
export const cacheActive = (cfg: Resolved): boolean => cacheMounts(cfg).length > 0;
