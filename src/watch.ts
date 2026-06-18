/**
 * `afk watch` — start the long-running daemon + local dashboard. Polls the `ready-for-agent` queue
 * continuously, drives each issue → feature through the shared Engine, and serves the monitor +
 * actions at http://localhost:<dashboardPort>. Ctrl-C stops it cleanly.
 */
import { loadConfig } from "./core/config.js";
import { Daemon } from "./core/daemon.js";
import { serveDashboard } from "./core/server.js";

(async () => {
  const cfg = loadConfig();
  const daemon = new Daemon(cfg);
  const server = serveDashboard(daemon, cfg.dashboardPort);

  const shutdown = () => { daemon.stop(); server.close(); setTimeout(() => process.exit(0), 200); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await daemon.start();
})();
