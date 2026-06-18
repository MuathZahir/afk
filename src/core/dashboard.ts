/**
 * The dashboard SPA, served inline by the daemon (no build step, no deps). Subscribes to the SSE
 * stream and re-pulls the server snapshot on every event, so the server's `reduce()` stays the
 * single source of truth — the client never re-implements the fold. Aesthetic: a calm dark
 * "control room", status carried by color, live work that visibly pulses.
 */
export const SPA = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>AFK · control room</title>
<style>
  :root {
    --bg:#0b0e14; --panel:#11151f; --panel2:#161b27; --line:#222a3a; --ink:#e6ebf5;
    --dim:#8a95ab; --faint:#5b6478; --accent:#7c8cff; --good:#3ecf8e; --warn:#f0b232;
    --bad:#f0556d; --info:#4aa8ff; --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  a { color:var(--accent); text-decoration:none; } a:hover { text-decoration:underline; }
  header { display:flex; align-items:center; gap:16px; padding:14px 22px; border-bottom:1px solid var(--line);
    background:linear-gradient(180deg,#11151f,#0d111a); position:sticky; top:0; z-index:5; }
  .brand { font-weight:700; letter-spacing:.08em; font-size:15px; }
  .brand span { color:var(--accent); }
  .pill { font:600 11px/1 var(--mono); padding:5px 10px; border-radius:999px; border:1px solid var(--line);
    text-transform:uppercase; letter-spacing:.06em; color:var(--dim); white-space:nowrap; }
  .pill.live { color:var(--good); border-color:#1f5e44; background:#0e2019; }
  .pill.paused { color:var(--warn); border-color:#5e4a1f; background:#201a0e; }
  .pill.backoff { color:var(--info); border-color:#1f455e; background:#0e1a20; }
  .pill.stopped { color:var(--bad); border-color:#5e1f2c; background:#200e12; }
  .spacer { flex:1; }
  .totals { display:flex; gap:18px; }
  .totals b { font:700 16px var(--mono); display:block; }
  .totals small { color:var(--faint); font-size:11px; text-transform:uppercase; letter-spacing:.05em; }
  button { font:600 12px system-ui; color:var(--ink); background:var(--panel2); border:1px solid var(--line);
    padding:6px 12px; border-radius:8px; cursor:pointer; } button:hover { border-color:var(--accent); }
  button.go { background:#16321f; border-color:#1f5e44; color:var(--good); }
  main { display:grid; grid-template-columns:1.4fr 1fr; gap:18px; padding:22px; max-width:1400px; margin:0 auto; }
  @media (max-width:980px){ main{ grid-template-columns:1fr; } }
  section { background:var(--panel); border:1px solid var(--line); border-radius:14px; overflow:hidden; }
  h2 { margin:0; padding:13px 16px; font-size:12px; letter-spacing:.09em; text-transform:uppercase; color:var(--dim);
    border-bottom:1px solid var(--line); background:var(--panel2); }
  .body { padding:8px; }
  .empty { color:var(--faint); padding:16px; font-style:italic; }
  .feature { border:1px solid var(--line); border-radius:11px; margin:8px; overflow:hidden; }
  .feature > .fhead { display:flex; align-items:center; gap:10px; padding:11px 13px; background:var(--panel2); }
  .feature .title { font-weight:600; } .feature .sub { color:var(--faint); font:11px var(--mono); }
  .badge { font:600 10px/1 var(--mono); padding:4px 8px; border-radius:6px; text-transform:uppercase; letter-spacing:.05em; border:1px solid; }
  .b-building{ color:var(--dim); border-color:var(--line); } .b-verifying{ color:var(--info); border-color:#1f455e; background:#0e1a20; }
  .b-fixing{ color:var(--warn); border-color:#5e4a1f; background:#201a0e; } .b-verified,.b-merged{ color:var(--good); border-color:#1f5e44; background:#0e2019; }
  .b-unverified{ color:var(--warn); border-color:#5e4a1f; } .b-needshuman{ color:var(--bad); border-color:#5e1f2c; background:#200e12; }
  .b-pr-open{ color:var(--accent); border-color:#2d356b; }
  .issue { display:flex; align-items:center; gap:9px; padding:7px 13px 7px 26px; border-top:1px solid var(--line); font-size:13px; }
  .dot { width:8px; height:8px; border-radius:50%; flex:none; }
  .s-merged{ background:var(--good); } .s-implementing{ background:var(--info); box-shadow:0 0 0 0 var(--info); animation:pulse 1.6s infinite; }
  .s-escalated,.s-blocked,.s-conflict,.s-error,.s-timeout{ background:var(--bad); } .s-queued,.s-rescued{ background:var(--faint); }
  @keyframes pulse { 0%{ box-shadow:0 0 0 0 rgba(74,168,255,.5);} 70%{ box-shadow:0 0 0 7px rgba(74,168,255,0);} 100%{ box-shadow:0 0 0 0 rgba(74,168,255,0);} }
  .agent { display:flex; align-items:center; gap:11px; padding:10px 14px; border-bottom:1px solid var(--line); }
  .agent:last-child{ border-bottom:none; }
  .role { font:600 10px/1 var(--mono); padding:4px 7px; border-radius:6px; text-transform:uppercase; border:1px solid var(--line); color:var(--dim); }
  .role.implement{ color:var(--accent); border-color:#2d356b; } .role.verify{ color:var(--info); border-color:#1f455e; }
  .role.fix,.role.resolve{ color:var(--warn); border-color:#5e4a1f; }
  .agent .what { flex:1; min-width:0; } .agent .what .t { font-weight:600; } .agent .what .x { color:var(--faint); font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .agent .tok { font:600 11px var(--mono); color:var(--dim); }
  .live-dot { width:7px; height:7px; border-radius:50%; background:var(--good); animation:pulse 1.6s infinite; }
  .esc { padding:11px 14px; border-bottom:1px solid var(--line); }
  .esc:last-child{ border-bottom:none; } .esc .r { color:var(--dim); font-size:13px; margin:3px 0 8px; }
  .row { display:flex; align-items:center; gap:8px; } .crit { font:11px var(--mono); color:var(--faint); padding:2px 13px; }
  .crit .ok{ color:var(--good);} .crit .no{ color:var(--bad);}
  .q input { flex:1; background:var(--bg); border:1px solid var(--line); color:var(--ink); border-radius:7px; padding:6px 9px; font:13px system-ui; }
  footer { text-align:center; color:var(--faint); font:11px var(--mono); padding:14px; }
</style>
</head>
<body>
<header>
  <div class="brand">AFK <span>·</span> control room</div>
  <div id="status" class="pill">connecting…</div>
  <div class="spacer"></div>
  <div class="totals">
    <div><b id="t-merged">0</b><small>merged</small></div>
    <div><b id="t-verified">0</b><small>verified</small></div>
    <div><b id="t-esc">0</b><small>needs human</small></div>
    <div><b id="t-tok">0</b><small>tokens</small></div>
  </div>
  <button id="toggle" onclick="toggle()">Pause</button>
</header>
<main>
  <div>
    <section><h2>Features</h2><div id="features" class="body"></div></section>
    <section style="margin-top:18px"><h2>Loose issues</h2><div id="loose" class="body"></div></section>
  </div>
  <div>
    <section><h2>Running agents</h2><div id="agents" class="body"></div></section>
    <section style="margin-top:18px"><h2>Needs a human</h2><div id="esc" class="body"></div></section>
    <section style="margin-top:18px"><h2>Questions</h2><div id="questions" class="body"></div></section>
  </div>
</main>
<footer>append-only event log · live via SSE · <span id="poll"></span></footer>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
let state = null, paused = false;

function badgeClass(s){ return "b-" + String(s).replace(/[^a-z]/g,""); }
function render(){
  if(!state) return;
  const d = state.daemon || {};
  const sp = $("status"); sp.textContent = d.status || "—";
  sp.className = "pill " + ({polling:"live",resumed:"live",paused:"paused",backoff:"backoff",stopped:"stopped"}[d.status]||"");
  paused = d.status === "paused";
  $("toggle").textContent = paused ? "Resume" : "Pause";
  const t = state.totals || {};
  $("t-merged").textContent = t.merged||0; $("t-verified").textContent = t.verified||0;
  $("t-esc").textContent = t.escalated||0; $("t-tok").textContent = (t.tokens||0).toLocaleString();
  $("poll").textContent = state.lastPoll ? ("last poll: "+state.lastPoll.ready+" ready, "+state.lastPoll.picked+" picked") : "";

  // features + their issues
  const feats = Object.values(state.features||{}).sort((a,b)=>a.title.localeCompare(b.title));
  const issuesByFeature = {};
  for(const i of Object.values(state.issues||{})){ (issuesByFeature[i.feature] = issuesByFeature[i.feature]||[]).push(i); }
  $("features").innerHTML = feats.length ? feats.map(f=>{
    const kids = (issuesByFeature[f.key]||[]).sort((a,b)=>a.number-b.number);
    const v = f.verdict ? \`<span class="sub">\${f.verdict.passed}/\${f.verdict.total} criteria</span>\` : "";
    const pr = f.pr ? (f.pr.state==="ready"
        ? \`<a href="\${esc(f.pr.url)}" target="_blank">PR ready ↗</a> <button class="go" onclick="merge('\${esc(f.key)}')">Merge</button>\`
        : \`<a href="\${esc(f.pr.url)}" target="_blank">PR \${esc(f.pr.state)} ↗</a>\`) : "";
    return \`<div class="feature"><div class="fhead">
        <span class="title">\${esc(f.title)}</span>
        <span class="badge \${badgeClass(f.state)}">\${esc(f.state)}</span> \${v}
        <span class="spacer" style="flex:1"></span> \${pr}
      </div>
      \${kids.map(i=>\`<div class="issue"><span class="dot s-\${esc(i.state)}"></span>
        <span>#\${i.number}</span> <span style="flex:1">\${esc(i.title)}</span>
        <span class="sub">\${esc(i.state)}</span></div>\`).join("")}
      \${f.verdict && !f.verdict.ok ? \`<div class="crit">\${esc(f.verdict.summary)}</div>\`:""}
    </div>\`;
  }).join("") : '<div class="empty">No features in flight.</div>';

  const loose = Object.values(state.issues||{}).filter(i=>!i.feature).sort((a,b)=>a.number-b.number);
  $("loose").innerHTML = loose.length ? loose.map(i=>\`<div class="issue"><span class="dot s-\${esc(i.state)}"></span>
      <span>#\${i.number}</span> <span style="flex:1">\${esc(i.title)}</span><span class="sub">\${esc(i.state)}</span></div>\`).join("")
    : '<div class="empty">None.</div>';

  const agents = Object.values(state.agents||{}).filter(a=>a.active).sort((a,b)=>a.started.localeCompare(b.started));
  $("agents").innerHTML = agents.length ? agents.map(a=>\`<div class="agent">
      <span class="live-dot"></span><span class="role \${esc(a.role)}">\${esc(a.role)}</span>
      <div class="what"><div class="t">\${esc(a.target)}</div><div class="x">\${esc(a.lastText||"working…")}</div></div>
      <span class="tok">\${a.tokens?a.tokens.toLocaleString()+" tok":""}</span></div>\`).join("")
    : '<div class="empty">Idle — no agents running.</div>';

  $("esc").innerHTML = (state.escalations||[]).length ? state.escalations.slice().reverse().map(e=>\`<div class="esc">
      <div class="row"><b>#\${e.issue}</b> <span>\${esc(e.title)}</span></div>
      <div class="r">\${esc(e.reason)}</div>
      <button onclick="retry(\${e.issue})">Re-queue</button></div>\`).join("")
    : '<div class="empty">Nothing waiting. 🎉</div>';

  const qs = Object.values(state.questions||{}).filter(q=>!q.answer);
  $("questions").innerHTML = qs.length ? qs.map(q=>\`<div class="esc q">
      <div class="row"><b>#\${q.issue}</b></div><div class="r">\${esc(q.prompt)}</div>
      <div class="row"><input id="q-\${esc(q.id)}" placeholder="Answer…"/>
      <button onclick="answer('\${esc(q.id)}')">Send</button></div></div>\`).join("")
    : '<div class="empty">No open questions.</div>';
}

async function refresh(){ try{ state = await (await fetch("/api/state")).json(); render(); }catch{} }
async function post(p,b){ await fetch(p,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(b||{})}); }
function toggle(){ post(paused?"/api/resume":"/api/pause").then(refresh); }
function retry(n){ post("/api/retry",{issue:n}).then(refresh); }
function answer(id){ post("/api/answer",{id,text:$("q-"+id).value}).then(refresh); }
async function merge(f){ const r=await (await fetch("/api/merge",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({feature:f})})).json(); if(!r.ok) alert("Merge failed: "+r.error); refresh(); }

let pending=null;
const ev = new EventSource("/api/stream");
ev.addEventListener("snapshot", (m)=>{ state=JSON.parse(m.data); render(); });
ev.addEventListener("event", ()=>{ clearTimeout(pending); pending=setTimeout(refresh,180); });
ev.onerror = ()=>{ $("status").textContent="reconnecting…"; $("status").className="pill"; };
refresh();
</script>
</body>
</html>`;
