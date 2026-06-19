/**
 * Offline tests for the state store roundtrip + the dashboard HTTP surface. No Docker, no GitHub —
 * a stub stands in for the daemon's control methods, so we verify routing/SSE/actions wire up
 * correctly and that the served snapshot reflects the persisted event log.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { Store } from "./state.js";
import { serveDashboard } from "./server.js";
import type { Daemon } from "./daemon.js";

function tmpStore(): Store {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "afk-state-"));
  return new Store(path.join(dir, "events.jsonl"));
}

test("Store: append persists to disk and round-trips through reduce", () => {
  const s = tmpStore();
  s.append({ type: "daemon", status: "polling" });
  s.append({ type: "issue-state", issue: 1, title: "A", feature: "epic-1", state: "merged" });
  // a fresh Store over the same file replays the log (restart recovery)
  const reopened = new Store(s.file);
  const snap = reopened.snapshot();
  assert.equal(snap.daemon.status, "polling");
  assert.equal(snap.issues[1].state, "merged");
  assert.equal(snap.totals.merged, 1);
});

test("Store: subscribers receive appended events live", () => {
  const s = tmpStore();
  const seen: string[] = [];
  const off = s.subscribe((e) => seen.push(e.type));
  s.append({ type: "poll", ready: 3, picked: 1 });
  off();
  s.append({ type: "poll", ready: 0, picked: 0 });
  assert.deepEqual(seen, ["poll"]); // unsubscribed before the second
});

test("Store: activity is live + buffered into the snapshot but never persisted", () => {
  const s = tmpStore();
  s.append({ type: "agent", id: "impl-1", role: "implement", target: "#1", phase: "start" });
  const frames: string[] = [];
  const off = s.subscribe((e) => { if (e.type === "activity") frames.push(e.line); });
  s.activity("impl-1", "🔧 Bash npm test");
  s.activity("impl-1", "writing the failing test first");
  off();
  assert.deepEqual(frames, ["🔧 Bash npm test", "writing the failing test first"]);
  // surfaced in the snapshot…
  assert.deepEqual(s.snapshot().agents["impl-1"].log, ["🔧 Bash npm test", "writing the failing test first"]);
  // …but a fresh Store over the same file has none (transient — not in the durable log)
  assert.equal(new Store(s.file).snapshot().agents["impl-1"].log, undefined);
});

// minimal stand-in for the Daemon's surface the server touches
function stubDaemon(store: Store) {
  const calls: string[] = [];
  const d = {
    store,
    pause() { calls.push("pause"); },
    resume() { calls.push("resume"); },
    retry(n: number) { calls.push("retry:" + n); },
    answer(id: string, t: string) { calls.push("answer:" + id + ":" + t); },
    stopAgent(id: string) { calls.push("stop:" + id); return true; },
    merge(f: string) { calls.push("merge:" + f); return { ok: true }; },
  };
  return { d: d as unknown as Daemon, calls };
}

async function listen(store: Store) {
  const { d, calls } = stubDaemon(store);
  const server = serveDashboard(d, 0);
  await new Promise<void>((r) => server.on("listening", r));
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, server, calls };
}

test("server: serves the SPA and the state snapshot", async () => {
  const s = tmpStore();
  s.append({ type: "daemon", status: "paused" });
  const { base, server } = await listen(s);
  try {
    const html = await (await fetch(base + "/")).text();
    assert.match(html, /control room/);
    const state = await (await fetch(base + "/api/state")).json();
    assert.equal(state.daemon.status, "paused");
  } finally { server.close(); }
});

test("server: action endpoints invoke the daemon", async () => {
  const s = tmpStore();
  const { base, server, calls } = await listen(s);
  try {
    await fetch(base + "/api/pause", { method: "POST" });
    await fetch(base + "/api/retry", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ issue: 7 }) });
    await fetch(base + "/api/stop", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "impl-7" }) });
    const merge = await (await fetch(base + "/api/merge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ feature: "epic-1" }) })).json();
    assert.deepEqual(calls, ["pause", "retry:7", "stop:impl-7", "merge:epic-1"]);
    assert.equal(merge.ok, true);
  } finally { server.close(); }
});

test("server: SSE stream opens with a snapshot frame", async () => {
  const s = tmpStore();
  s.append({ type: "daemon", status: "polling" });
  const { base, server } = await listen(s);
  try {
    const res = await fetch(base + "/api/stream");
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    assert.match(text, /event: snapshot/);
    assert.match(text, /"status":"polling"/);
    await reader.cancel();
  } finally { server.close(); }
});
