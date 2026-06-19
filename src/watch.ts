/**
 * `afk watch` — start the long-running daemon + local dashboard. Polls the `ready-for-agent` queue
 * continuously, drives each issue → feature through the shared Engine, and serves the monitor +
 * actions at http://localhost:<dashboardPort>. Ctrl-C winds down in-flight agents, then exits.
 */
import { loadConfig } from "./core/config.js";
import { Daemon } from "./core/daemon.js";
import { serveDashboard } from "./core/server.js";

(async () => {
  const cfg = loadConfig();
  const daemon = new Daemon(cfg);
  const server = serveDashboard(daemon, cfg.dashboardPort);

  let stopping = false;
  const onSignal = () => {
    if (stopping) { console.log("\nForce-quitting (in-flight containers will be reaped on next start)."); process.exit(1); }
    stopping = true;
    console.log("\n⏹  Stopping — winding down in-flight agents (Ctrl-C again to force-quit)…");
    daemon.shutdown().finally(() => { server.close(); process.exit(0); });
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  await daemon.start();
})();
