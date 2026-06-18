/**
 * Append-only event-log state store. The daemon's memory and the dashboard's data source.
 *
 * Why an event log (not a mutable DB): it is crash-safe (we only ever append a line), gives the
 * daemon free **restart recovery** (replay the log to rebuild the live picture, then reconcile
 * against GitHub), and gives the dashboard a natural live stream (tail = SSE). The fold from events
 * → `Snapshot` is a pure function, so it is fully unit-testable without a daemon or Docker.
 */
import * as fs from "node:fs";
import * as path from "node:path";

// ── events ─────────────────────────────────────────────────────────────────────
/** The event payload (everything but the timestamp) — a discriminated union on `type`. */
export type EventBody =
  | { type: "daemon"; status: "starting" | "polling" | "paused" | "resumed" | "backoff" | "stopped"; note?: string }
  | { type: "poll"; ready: number; picked: number }
  | { type: "issue-state"; issue: number; title: string; feature: string | null; state: IssueState; note?: string }
  | { type: "feature-state"; feature: string; title: string; state: FeatureState; note?: string }
  | { type: "agent"; id: string; role: AgentRole; target: string; phase: "start" | "activity" | "end"; text?: string; tokens?: number }
  | { type: "pr"; feature: string; url: string; state: "draft" | "ready" | "merged" }
  | { type: "escalation"; issue: number; title: string; reason: string; branch?: string }
  | { type: "question"; id: string; issue: number; prompt: string }
  | { type: "answer"; id: string; answer: string }
  | { type: "verdict"; feature: string; ok: boolean; summary: string; passed: number; total: number };
/** A persisted event: a body plus the timestamp the store stamps on. */
export type Event = { ts: string } & EventBody;
export type AgentRole = "implement" | "verify" | "fix" | "resolve" | "classify";
export type IssueState = "queued" | "implementing" | "merged" | "blocked" | "escalated" | "conflict" | "timeout" | "error" | "rescued";
export type FeatureState = "building" | "verifying" | "fixing" | "verified" | "unverified" | "pr-open" | "merged" | "needs-human";

// ── snapshot (what the dashboard renders) ───────────────────────────────────────
export type Snapshot = {
  daemon: { status: string; since: string; note?: string };
  lastPoll?: { ts: string; ready: number; picked: number };
  issues: Record<number, { number: number; title: string; feature: string | null; state: IssueState; note?: string; updated: string }>;
  features: Record<string, { key: string; title: string; state: FeatureState; pr?: { url: string; state: string }; verdict?: { ok: boolean; summary: string; passed: number; total: number }; note?: string; updated: string }>;
  agents: Record<string, { id: string; role: AgentRole; target: string; active: boolean; lastText?: string; tokens: number; started: string; updated: string }>;
  escalations: { issue: number; title: string; reason: string; branch?: string; ts: string }[];
  questions: Record<string, { id: string; issue: number; prompt: string; answer?: string; ts: string }>;
  totals: { merged: number; escalated: number; verified: number; tokens: number };
};

const emptySnapshot = (): Snapshot => ({
  daemon: { status: "unknown", since: "" },
  issues: {}, features: {}, agents: {}, escalations: [], questions: {},
  totals: { merged: 0, escalated: 0, verified: 0, tokens: 0 },
});

/** Pure fold: events → live snapshot. The whole point of the event-log design. */
export function reduce(events: Event[]): Snapshot {
  const s = emptySnapshot();
  for (const e of events) {
    switch (e.type) {
      case "daemon": s.daemon = { status: e.status, since: e.ts, note: e.note }; break;
      case "poll": s.lastPoll = { ts: e.ts, ready: e.ready, picked: e.picked }; break;
      case "issue-state": {
        const prev = s.issues[e.issue];
        s.issues[e.issue] = { number: e.issue, title: e.title, feature: e.feature, state: e.state, note: e.note, updated: e.ts };
        if (e.state === "merged" && prev?.state !== "merged") s.totals.merged++;
        break;
      }
      case "feature-state": {
        const f = s.features[e.feature] ?? { key: e.feature, title: e.title, state: e.state, updated: e.ts };
        s.features[e.feature] = { ...f, title: e.title, state: e.state, note: e.note, updated: e.ts };
        break;
      }
      case "verdict": {
        const f = s.features[e.feature] ?? { key: e.feature, title: e.feature, state: "verifying" as FeatureState, updated: e.ts };
        s.features[e.feature] = { ...f, verdict: { ok: e.ok, summary: e.summary, passed: e.passed, total: e.total }, updated: e.ts };
        if (e.ok) s.totals.verified++;
        break;
      }
      case "agent": {
        const a = s.agents[e.id] ?? { id: e.id, role: e.role, target: e.target, active: true, tokens: 0, started: e.ts, updated: e.ts };
        s.agents[e.id] = {
          ...a, role: e.role, target: e.target,
          active: e.phase !== "end",
          lastText: e.text ?? a.lastText,
          tokens: e.tokens ?? a.tokens,
          updated: e.ts,
        };
        if (e.phase === "end" && e.tokens) s.totals.tokens += e.tokens;
        break;
      }
      case "pr": {
        const f = s.features[e.feature] ?? { key: e.feature, title: e.feature, state: "pr-open" as FeatureState, updated: e.ts };
        s.features[e.feature] = { ...f, pr: { url: e.url, state: e.state }, updated: e.ts };
        break;
      }
      case "escalation":
        s.escalations.push({ issue: e.issue, title: e.title, reason: e.reason, branch: e.branch, ts: e.ts });
        s.totals.escalated++;
        break;
      case "question": s.questions[e.id] = { id: e.id, issue: e.issue, prompt: e.prompt, ts: e.ts }; break;
      case "answer": if (s.questions[e.id]) s.questions[e.id].answer = e.answer; break;
    }
  }
  return s;
}

/** Live store backed by a JSONL file. Append-only; notifies subscribers (the SSE stream). */
export class Store {
  private subs = new Set<(e: Event) => void>();
  constructor(public readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  /** Stamp + persist an event, then fan out to live subscribers. */
  append(e: EventBody & { ts?: string }): Event {
    const full = { ...e, ts: e.ts ?? new Date().toISOString() } as Event;
    fs.appendFileSync(this.file, JSON.stringify(full) + "\n");
    for (const fn of this.subs) { try { fn(full); } catch { /* a slow subscriber must not break append */ } }
    return full;
  }
  /** Replay the log from disk (restart recovery). */
  all(): Event[] {
    try {
      return fs.readFileSync(this.file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Event);
    } catch { return []; }
  }
  snapshot(): Snapshot { return reduce(this.all()); }
  subscribe(fn: (e: Event) => void): () => void { this.subs.add(fn); return () => this.subs.delete(fn); }
}
