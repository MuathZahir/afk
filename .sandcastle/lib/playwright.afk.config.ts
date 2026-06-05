/**
 * Playwright harness for the AFK e2e/video step. The worker writes .afk/afk.spec.ts;
 * afk-gate.sh runs it through this config. Playwright's `webServer` boots and tears
 * down the app, and `video: "on"` records the proof-of-work clip.
 */
import { defineConfig } from "@playwright/test";
import * as fs from "node:fs";

const cfg = JSON.parse(fs.readFileSync(new URL("../afk.config.json", import.meta.url), "utf8"));

export default defineConfig({
  testDir: new URL("../../.afk", import.meta.url).pathname,
  testMatch: "afk.spec.ts",
  outputDir: new URL("../../.afk/test-results", import.meta.url).pathname,
  timeout: 90_000,
  reporter: [["line"]],
  use: {
    baseURL: cfg.baseUrl,
    video: "on",
    trace: "off",
    headless: true,
  },
  webServer: cfg.dev
    ? {
        command: cfg.dev,
        url: cfg.baseUrl,
        reuseExistingServer: false,
        timeout: 120_000,
        stdout: "pipe",
        stderr: "pipe",
      }
    : undefined,
});
