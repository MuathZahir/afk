/**
 * The dashboard SPA, served inline by the daemon (no build step, no deps). Subscribes to the SSE
 * stream and re-pulls the server snapshot on every event, so the server's `reduce()` stays the
 * single source of truth — the client never re-implements the fold. Aesthetic: a calm, deep
 * "control room" — a mission console for an autonomous agent factory. Status is carried by color,
 * live work visibly breathes, and the whole thing reveals itself in one orchestrated load.
 */
export const SPA = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>AFK · control room</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500..800&family=Spline+Sans+Mono:wght@400;500;600;700&family=Spline+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root {
    --bg:#06080d; --bg2:#080b12;
    --ink:#eaf0fb; --dim:#98a3ba; --faint:#5a6378;
    --line:rgba(255,255,255,.07); --line2:rgba(255,255,255,.13);
    --accent:#8b9bff; --accent2:#aeb8ff; --accent-glow:rgba(139,155,255,.45);
    --good:#3fe7a4; --good-glow:rgba(63,231,164,.5);
    --info:#5bb6ff; --warn:#f5b13f; --bad:#ff5d76;
    --sans:"Spline Sans",system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
    --mono:"Spline Sans Mono",ui-monospace,"SF Mono",Menlo,Consolas,monospace;
    --display:"Bricolage Grotesque","Spline Sans",system-ui,sans-serif;
    --r:14px;
  }
  * { box-sizing:border-box; }
  html { scroll-behavior:smooth; }
  body {
    margin:0; color:var(--ink); font:14px/1.55 var(--sans); letter-spacing:.005em;
    background:
      radial-gradient(1100px 620px at 14% -8%, rgba(139,155,255,.14), transparent 60%),
      radial-gradient(900px 560px at 96% 4%, rgba(63,231,164,.07), transparent 58%),
      radial-gradient(800px 800px at 60% 120%, rgba(91,182,255,.06), transparent 60%),
      var(--bg);
    min-height:100vh;
  }
  /* fine film-grain so the dark never reads as flat */
  body::after {
    content:""; position:fixed; inset:0; z-index:0; pointer-events:none; opacity:.05; mix-blend-mode:overlay;
    background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
  }
  a { color:var(--accent2); text-decoration:none; } a:hover { color:#fff; }
  ::-webkit-scrollbar { width:10px; height:10px; }
  ::-webkit-scrollbar-thumb { background:rgba(255,255,255,.08); border-radius:99px; border:2px solid transparent; background-clip:padding-box; }
  ::-webkit-scrollbar-thumb:hover { background:rgba(255,255,255,.16); background-clip:padding-box; }

  /* ── command bar ─────────────────────────────────────────────── */
  header {
    position:sticky; top:0; z-index:20; display:flex; align-items:center; gap:18px;
    padding:14px 26px; border-bottom:1px solid var(--line);
    background:linear-gradient(180deg,rgba(10,13,20,.86),rgba(7,9,14,.72));
    backdrop-filter:blur(18px) saturate(140%); -webkit-backdrop-filter:blur(18px) saturate(140%);
  }
  header::after { content:""; position:absolute; left:0; right:0; bottom:-1px; height:1px;
    background:linear-gradient(90deg,transparent,var(--accent-glow),transparent); opacity:.6; }
  .brand { display:flex; align-items:center; gap:12px; }
  .glyph { width:30px; height:30px; flex:none; }
  .glyph .orbit { transform-origin:16px 16px; animation:spin 9s linear infinite; }
  @keyframes spin { to { transform:rotate(360deg); } }
  .wordmark { line-height:1; }
  .wordmark b { font:800 17px/1 var(--display); letter-spacing:.02em; display:block; }
  .wordmark small { font:600 9.5px/1 var(--mono); letter-spacing:.34em; text-transform:uppercase; color:var(--faint); }

  .pill {
    display:inline-flex; align-items:center; gap:8px; font:600 11px/1 var(--mono); padding:7px 12px 7px 11px;
    border-radius:999px; border:1px solid var(--line2); text-transform:uppercase; letter-spacing:.1em;
    color:var(--dim); white-space:nowrap; background:rgba(255,255,255,.025);
  }
  .pill::before { content:""; width:7px; height:7px; border-radius:50%; background:currentColor; box-shadow:0 0 0 0 currentColor; }
  .pill.live { color:var(--good); border-color:rgba(63,231,164,.32); background:rgba(63,231,164,.07); }
  .pill.live::before { animation:beat 1.7s ease-out infinite; }
  .pill.paused { color:var(--warn); border-color:rgba(245,177,63,.32); background:rgba(245,177,63,.07); }
  .pill.backoff { color:var(--info); border-color:rgba(91,182,255,.32); background:rgba(91,182,255,.07); }
  .pill.stopped { color:var(--bad); border-color:rgba(255,93,118,.32); background:rgba(255,93,118,.07); }
  @keyframes beat { 0%{ box-shadow:0 0 0 0 var(--good-glow);} 70%{ box-shadow:0 0 0 6px transparent;} 100%{ box-shadow:0 0 0 0 transparent;} }

  .spacer { flex:1; }
  .stats { display:flex; gap:9px; }
  .stat { position:relative; padding:8px 14px; min-width:74px; border-radius:11px; border:1px solid var(--line);
    background:linear-gradient(180deg,rgba(255,255,255,.035),rgba(255,255,255,.008)); }
  .stat b { font:600 19px/1 var(--mono); letter-spacing:-.01em; display:block; font-variant-numeric:tabular-nums; }
  .stat small { display:block; margin-top:5px; color:var(--faint); font:600 9px/1 var(--mono); text-transform:uppercase; letter-spacing:.13em; }
  .stat.merged b { color:var(--good); } .stat.verified b { color:var(--info); }
  .stat.esc b { color:var(--bad); } .stat.esc.zero b { color:var(--dim); }
  .stat.tok b { color:var(--accent2); }

  button {
    font:600 12px var(--sans); color:var(--ink); background:rgba(255,255,255,.04);
    border:1px solid var(--line2); padding:8px 14px; border-radius:10px; cursor:pointer;
    transition:border-color .15s, background .15s, transform .06s; letter-spacing:.01em;
  }
  button:hover { border-color:var(--accent); background:rgba(139,155,255,.12); }
  button:active { transform:translateY(1px); }
  button.primary { background:linear-gradient(180deg,rgba(139,155,255,.22),rgba(139,155,255,.1)); border-color:rgba(139,155,255,.4); color:#fff; }
  button.primary.paused { background:linear-gradient(180deg,rgba(245,177,63,.2),rgba(245,177,63,.08)); border-color:rgba(245,177,63,.4); color:var(--warn); }
  button.go { background:linear-gradient(180deg,rgba(63,231,164,.2),rgba(63,231,164,.08)); border-color:rgba(63,231,164,.4); color:var(--good); }
  button.go:hover { border-color:var(--good); background:rgba(63,231,164,.26); }
  button.stop { background:rgba(255,93,118,.07); border-color:rgba(255,93,118,.28); color:var(--bad); font-size:11px; padding:5px 11px; }
  button.stop:hover { border-color:var(--bad); background:rgba(255,93,118,.16); }

  /* ── layout ──────────────────────────────────────────────────── */
  main { position:relative; z-index:1; display:grid; grid-template-columns:1.45fr 1fr; gap:20px; padding:26px; max-width:1480px; margin:0 auto; }
  @media (max-width:1000px){ main{ grid-template-columns:1fr; } header .stats{ display:none; } }
  .col { display:flex; flex-direction:column; gap:20px; }

  section { position:relative; border:1px solid var(--line); border-radius:var(--r); overflow:hidden;
    background:linear-gradient(180deg,rgba(19,24,36,.66),rgba(11,14,22,.66));
    box-shadow:0 1px 0 rgba(255,255,255,.04) inset, 0 18px 40px -28px rgba(0,0,0,.9);
    opacity:0; transform:translateY(10px); animation:rise .6s cubic-bezier(.2,.7,.3,1) forwards; }
  section:nth-child(1){ animation-delay:.04s; } section:nth-child(2){ animation-delay:.12s; } section:nth-child(3){ animation-delay:.2s; }
  @keyframes rise { to { opacity:1; transform:none; } }
  .shead { display:flex; align-items:center; gap:10px; padding:13px 16px; border-bottom:1px solid var(--line);
    background:linear-gradient(180deg,rgba(255,255,255,.03),transparent); }
  .shead h2 { margin:0; font:600 11px/1 var(--mono); letter-spacing:.2em; text-transform:uppercase; color:var(--dim); }
  .shead .tick { width:3px; height:13px; border-radius:2px; background:var(--accent); box-shadow:0 0 10px var(--accent-glow); }
  .shead .n { font:600 10px/1 var(--mono); color:var(--faint); padding:4px 8px; border:1px solid var(--line); border-radius:7px; background:rgba(255,255,255,.02); }
  .body { padding:10px; }
  .empty { color:var(--faint); padding:22px 16px; text-align:center; font-size:13px; }
  .empty .big { font:600 22px var(--display); color:var(--dim); display:block; margin-bottom:4px; }

  /* ── feature cards ───────────────────────────────────────────── */
  .feature { border:1px solid var(--line); border-radius:12px; margin:8px; overflow:hidden; background:rgba(255,255,255,.012);
    transition:border-color .2s; }
  .feature:hover { border-color:var(--line2); }
  .feature > .fhead { display:flex; align-items:center; gap:10px; padding:12px 14px; background:linear-gradient(180deg,rgba(255,255,255,.028),transparent); }
  .feature .title { font:600 14px var(--display); letter-spacing:.01em; }
  .feature .sub { color:var(--faint); font:11px var(--mono); }
  .badge { font:600 9.5px/1 var(--mono); padding:5px 8px; border-radius:6px; text-transform:uppercase; letter-spacing:.08em; border:1px solid var(--line2); color:var(--dim); white-space:nowrap; }
  .b-building{ color:var(--dim); }
  .b-verifying{ color:var(--info); border-color:rgba(91,182,255,.34); background:rgba(91,182,255,.08); }
  .b-fixing{ color:var(--warn); border-color:rgba(245,177,63,.34); background:rgba(245,177,63,.08); }
  .b-verified,.b-merged{ color:var(--good); border-color:rgba(63,231,164,.34); background:rgba(63,231,164,.08); }
  .b-unverified{ color:var(--warn); border-color:rgba(245,177,63,.3); }
  .b-needshuman{ color:var(--bad); border-color:rgba(255,93,118,.34); background:rgba(255,93,118,.08); }
  .b-pr-open{ color:var(--accent2); border-color:rgba(139,155,255,.4); background:rgba(139,155,255,.08); }

  .crit { padding:0 14px 12px; }
  .crit-bar { height:5px; border-radius:99px; background:rgba(255,255,255,.07); overflow:hidden; }
  .crit-bar span { display:block; height:100%; border-radius:99px; background:linear-gradient(90deg,var(--good),#7af2c4); box-shadow:0 0 12px var(--good-glow); transition:width .5s ease; }
  .crit-bar.no span { background:linear-gradient(90deg,var(--warn),#ffd07a); box-shadow:0 0 12px rgba(245,177,63,.4); }
  .crit-label { margin-top:7px; font:11px var(--mono); color:var(--faint); }
  .crit-label .ok{ color:var(--good); } .crit-label .no{ color:var(--warn); }

  .issue { display:flex; align-items:center; gap:10px; padding:9px 14px 9px 16px; border-top:1px solid var(--line); font-size:13px; }
  .issue .num { font:600 11px var(--mono); color:var(--faint); }
  .issue .it { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--dim); }
  .issue .st { font:600 10px var(--mono); color:var(--faint); text-transform:uppercase; letter-spacing:.05em; }
  .dot { width:8px; height:8px; border-radius:50%; flex:none; }
  .s-merged{ background:var(--good); box-shadow:0 0 8px var(--good-glow); }
  .s-implementing{ background:var(--info); animation:ring 1.7s infinite; }
  .s-escalated,.s-blocked,.s-conflict,.s-error,.s-timeout{ background:var(--bad); box-shadow:0 0 8px rgba(255,93,118,.5); }
  .s-queued,.s-rescued,.s-stopped{ background:var(--faint); }
  .s-question{ background:var(--warn); box-shadow:0 0 8px rgba(245,177,63,.5); }
  .s-researched{ background:#3fd8e7; box-shadow:0 0 8px rgba(63,216,231,.5); }
  @keyframes ring { 0%{ box-shadow:0 0 0 0 rgba(91,182,255,.55);} 70%{ box-shadow:0 0 0 7px rgba(91,182,255,0);} 100%{ box-shadow:0 0 0 0 rgba(91,182,255,0);} }

  /* ── agent cards ─────────────────────────────────────────────── */
  .agent { padding:13px 15px; border-bottom:1px solid var(--line); }
  .agent:last-child{ border-bottom:none; }
  .agent .hdr { display:flex; align-items:center; gap:10px; }
  .live-dot { width:8px; height:8px; border-radius:50%; background:var(--good); animation:ring-g 1.7s infinite; flex:none; }
  @keyframes ring-g { 0%{ box-shadow:0 0 0 0 var(--good-glow);} 70%{ box-shadow:0 0 0 7px transparent;} 100%{ box-shadow:0 0 0 0 transparent;} }
  .role { font:600 9.5px/1 var(--mono); padding:5px 8px; border-radius:6px; text-transform:uppercase; letter-spacing:.08em; border:1px solid var(--line2); color:var(--dim); }
  .role.implement{ color:var(--accent2); border-color:rgba(139,155,255,.4); background:rgba(139,155,255,.08); }
  .role.verify{ color:var(--info); border-color:rgba(91,182,255,.34); background:rgba(91,182,255,.08); }
  .role.fix,.role.resolve{ color:var(--warn); border-color:rgba(245,177,63,.34); background:rgba(245,177,63,.08); }
  .role.research{ color:#3fd8e7; border-color:rgba(63,216,231,.34); background:rgba(63,216,231,.08); }
  .agent .what { flex:1; min-width:0; }
  .agent .what .t { font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .agent .meta { display:flex; align-items:center; gap:8px; font:600 11px var(--mono); color:var(--faint); flex:none; }
  .agent .meta .tok { color:var(--dim); }
  .agent .log { margin-top:10px; max-height:176px; overflow-y:auto; border:1px solid var(--line); border-left:2px solid rgba(139,155,255,.4);
    border-radius:9px; padding:9px 12px; font:11px/1.6 var(--mono); color:var(--dim); white-space:pre-wrap; word-break:break-word;
    background:linear-gradient(180deg,rgba(0,0,0,.32),rgba(0,0,0,.18)); }
  .agent .log .muted { color:var(--faint); font-style:italic; }

  /* ── escalations + questions ─────────────────────────────────── */
  .card { padding:13px 15px; border-bottom:1px solid var(--line); }
  .card:last-child{ border-bottom:none; }
  .card .row { display:flex; align-items:center; gap:9px; }
  .card .iss { font:600 12px var(--mono); color:var(--bad); }
  .card.q .iss { color:var(--warn); }
  .card .ttl { font-weight:600; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .card .r { color:var(--dim); font-size:13px; margin:8px 0 11px; line-height:1.5; }
  .card .when { font:10px var(--mono); color:var(--faint); }
  .q input { flex:1; background:rgba(0,0,0,.28); border:1px solid var(--line2); color:var(--ink); border-radius:9px; padding:8px 11px; font:13px var(--sans); }
  .q input:focus { outline:none; border-color:var(--accent); box-shadow:0 0 0 3px rgba(139,155,255,.14); }

  footer { position:relative; z-index:1; text-align:center; color:var(--faint); font:11px var(--mono); padding:20px 14px 34px; letter-spacing:.04em; }
  footer .sep { color:var(--line2); margin:0 8px; }

  @media (prefers-reduced-motion:reduce){ *{ animation:none !important; } }
</style>
</head>
<body>
<header>
  <div class="brand">
    <svg class="glyph" viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <circle cx="16" cy="16" r="3.4" fill="#aeb8ff"/>
      <circle cx="16" cy="16" r="3.4" fill="#aeb8ff" opacity=".35"><animate attributeName="r" values="3.4;6;3.4" dur="2.4s" repeatCount="indefinite"/><animate attributeName="opacity" values=".35;0;.35" dur="2.4s" repeatCount="indefinite"/></circle>
      <g class="orbit">
        <ellipse cx="16" cy="16" rx="13" ry="6.2" stroke="#8b9bff" stroke-opacity=".5" stroke-width="1.2"/>
        <circle cx="29" cy="16" r="1.9" fill="#3fe7a4"/>
      </g>
    </svg>
    <div class="wordmark"><b>AFK</b><small>control room</small></div>
  </div>
  <div id="status" class="pill">connecting…</div>
  <div class="spacer"></div>
  <div class="stats">
    <div class="stat merged"><b id="t-merged">0</b><small>merged</small></div>
    <div class="stat verified"><b id="t-verified">0</b><small>verified</small></div>
    <div class="stat esc" id="s-esc"><b id="t-esc">0</b><small>needs human</small></div>
    <div class="stat tok"><b id="t-tok">0</b><small>tokens</small></div>
  </div>
  <button id="toggle" class="primary" onclick="toggle()">Pause</button>
</header>
<main>
  <div class="col">
    <section>
      <div class="shead"><span class="tick"></span><h2>Features in flight</h2><span class="spacer"></span><span class="n" id="features-n">0</span></div>
      <div id="features" class="body"></div>
    </section>
    <section>
      <div class="shead"><span class="tick"></span><h2>Loose issues</h2><span class="spacer"></span><span class="n" id="loose-n">0</span></div>
      <div id="loose" class="body"></div>
    </section>
  </div>
  <div class="col">
    <section>
      <div class="shead"><span class="tick" style="background:var(--good);box-shadow:0 0 10px var(--good-glow)"></span><h2>Running agents</h2><span class="spacer"></span><span class="n" id="agents-n">0</span></div>
      <div id="agents" class="body"></div>
    </section>
    <section>
      <div class="shead"><span class="tick" style="background:var(--bad);box-shadow:0 0 10px rgba(255,93,118,.5)"></span><h2>Needs a human</h2><span class="spacer"></span><span class="n" id="esc-n">0</span></div>
      <div id="esc" class="body"></div>
    </section>
    <section>
      <div class="shead"><span class="tick" style="background:var(--warn);box-shadow:0 0 10px rgba(245,177,63,.5)"></span><h2>Questions</h2><span class="spacer"></span><span class="n" id="questions-n">0</span></div>
      <div id="questions" class="body"></div>
    </section>
  </div>
</main>
<footer>append-only event log <span class="sep">·</span> live via SSE <span class="sep">·</span> <span id="poll"></span></footer>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
let state = null, paused = false;

function badgeClass(s){ return "b-" + String(s).replace(/[^a-z]/g,""); }
function featLabel(key){ const m=String(key).match(/^epic-(\\d+)$/); return m ? "Epic #"+m[1] : String(key).replace(/^ms-/,"").replace(/-/g," "); }
function rel(ts){ if(!ts) return ""; const s=Math.max(0,(Date.now()-new Date(ts).getTime())/1000);
  if(s<60) return Math.floor(s)+"s"; if(s<3600) return Math.floor(s/60)+"m"; if(s<86400) return Math.floor(s/3600)+"h"; return Math.floor(s/86400)+"d"; }
function fmtTok(n){ n=n||0; if(n<1000) return ""+n; if(n<1e6) return (n/1000).toFixed(n<1e4?1:0)+"k"; return (n/1e6).toFixed(1)+"M"; }

function render(){
  if(!state) return;
  const d = state.daemon || {};
  const sp = $("status"); sp.textContent = d.status || "—";
  sp.className = "pill " + ({polling:"live",resumed:"live",paused:"paused",backoff:"backoff",stopped:"stopped"}[d.status]||"");
  paused = d.status === "paused";
  $("toggle").textContent = paused ? "Resume" : "Pause";
  $("toggle").className = "primary" + (paused ? " paused" : "");
  const t = state.totals || {};
  $("t-merged").textContent = t.merged||0; $("t-verified").textContent = t.verified||0;
  $("t-esc").textContent = t.escalated||0; $("t-tok").textContent = fmtTok(t.tokens||0);
  $("s-esc").classList.toggle("zero", !(t.escalated>0));
  $("poll").textContent = state.lastPoll ? ("last poll · "+state.lastPoll.ready+" ready · "+state.lastPoll.picked+" picked · "+rel(state.lastPoll.ts)+" ago") : "awaiting first poll…";

  // features + their issues
  const featMap = Object.assign({}, state.features||{});
  const issuesByFeature = {};
  for(const i of Object.values(state.issues||{})){
    if(!i.feature) continue;
    (issuesByFeature[i.feature] = issuesByFeature[i.feature]||[]).push(i);
    // Defensive: an in-flight epic child whose feature node hasn't been emitted yet still gets a node,
    // so it never falls into the gap between "Features" and "Loose issues".
    if(!featMap[i.feature]) featMap[i.feature] = { key:i.feature, title:featLabel(i.feature), state:"building" };
  }
  const feats = Object.values(featMap).sort((a,b)=>String(a.title).localeCompare(String(b.title)));
  $("features-n").textContent = feats.length;
  $("features").innerHTML = feats.length ? feats.map(f=>{
    const kids = (issuesByFeature[f.key]||[]).sort((a,b)=>a.number-b.number);
    const v = f.verdict;
    const pct = v && v.total ? Math.round(100*v.passed/v.total) : 0;
    const crit = v ? \`<div class="crit">
        <div class="crit-bar \${v.ok?'':'no'}"><span style="width:\${pct}%"></span></div>
        <div class="crit-label"><span class="\${v.ok?'ok':'no'}">\${v.passed}/\${v.total} criteria</span>\${v.ok?'':' · '+esc(v.summary)}</div>
      </div>\` : "";
    const pr = f.pr ? (f.pr.state==="ready"
        ? \`<a href="\${esc(f.pr.url)}" target="_blank">PR ready ↗</a> <button class="go" onclick="merge('\${esc(f.key)}')">Merge</button>\`
        : \`<a href="\${esc(f.pr.url)}" target="_blank">PR \${esc(f.pr.state)} ↗</a>\`) : "";
    return \`<div class="feature"><div class="fhead">
        <span class="title">\${esc(f.title)}</span>
        <span class="badge \${badgeClass(f.state)}">\${esc(f.state)}</span>
        <span class="spacer"></span> \${pr}
      </div>
      \${crit}
      \${kids.map(i=>\`<div class="issue"><span class="dot s-\${esc(i.state)}"></span>
        <span class="num">#\${i.number}</span> <span class="it">\${esc(i.title)}</span>
        <span class="st">\${esc(i.state)}</span></div>\`).join("")}
    </div>\`;
  }).join("") : '<div class="empty"><span class="big">○</span>No features in flight.</div>';

  const loose = Object.values(state.issues||{}).filter(i=>!i.feature).sort((a,b)=>a.number-b.number);
  $("loose-n").textContent = loose.length;
  $("loose").innerHTML = loose.length ? loose.map(i=>\`<div class="issue"><span class="dot s-\${esc(i.state)}"></span>
      <span class="num">#\${i.number}</span> <span class="it">\${esc(i.title)}</span><span class="st">\${esc(i.state)}</span></div>\`).join("")
    : '<div class="empty">None.</div>';

  const agents = Object.values(state.agents||{}).filter(a=>a.active).sort((a,b)=>a.started.localeCompare(b.started));
  $("agents-n").textContent = agents.length;
  $("agents").innerHTML = agents.length ? agents.map(a=>{
    const lines = (a.log||[]).slice(-14);
    const log = lines.length ? lines.map(esc).join("\\n") : '<span class="muted">waiting for output… (the worker may still be installing deps)</span>';
    const tok = a.tokens ? \`<span class="tok">\${fmtTok(a.tokens)} tok</span>\` : "";
    return \`<div class="agent">
      <div class="hdr"><span class="live-dot"></span><span class="role \${esc(a.role)}">\${esc(a.role)}</span>
        <div class="what"><div class="t">\${esc(a.target)}</div></div>
        <div class="meta">\${tok}<span class="el" data-since="\${esc(a.started)}">\${rel(a.started)}</span>
        <button class="stop" onclick="stop('\${esc(a.id)}')">Stop</button></div></div>
      <div class="log" id="log-\${esc(a.id)}">\${log}</div></div>\`;
  }).join("") : '<div class="empty"><span class="big">⏻</span>Idle — no agents running.</div>';
  // keep each transcript pinned to the latest line
  for(const a of agents){ const el=$("log-"+a.id); if(el) el.scrollTop=el.scrollHeight; }

  const escs = (state.escalations||[]);
  $("esc-n").textContent = escs.length;
  $("esc").innerHTML = escs.length ? escs.slice().reverse().map(e=>\`<div class="card">
      <div class="row"><span class="iss">#\${e.issue}</span> <span class="ttl">\${esc(e.title)}</span> <span class="when">\${rel(e.ts)} ago</span></div>
      <div class="r">\${esc(e.reason)}</div>
      <button onclick="retry(\${e.issue})">Re-queue</button></div>\`).join("")
    : '<div class="empty"><span class="big">✓</span>Nothing waiting.</div>';

  const qs = Object.values(state.questions||{}).filter(q=>!q.answer);
  $("questions-n").textContent = qs.length;
  $("questions").innerHTML = qs.length ? qs.map(q=>\`<div class="card q">
      <div class="row"><span class="iss">#\${q.issue}</span> <span class="when">\${rel(q.ts)} ago</span></div>
      <div class="r">\${esc(q.prompt)}</div>
      <div class="row"><input id="q-\${esc(q.id)}" placeholder="Type an answer…"/>
      <button class="primary" onclick="answer('\${esc(q.id)}')">Send</button></div></div>\`).join("")
    : '<div class="empty">No open questions.</div>';
}

async function refresh(){ try{ state = await (await fetch("/api/state")).json(); render(); }catch{} }
async function post(p,b){ await fetch(p,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(b||{})}); }
function toggle(){ post(paused?"/api/resume":"/api/pause").then(refresh); }
function retry(n){ post("/api/retry",{issue:n}).then(refresh); }
function stop(id){ post("/api/stop",{id}); }
function answer(id){ post("/api/answer",{id,text:$("q-"+id).value}).then(refresh); }
async function merge(f){ const r=await (await fetch("/api/merge",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({feature:f})})).json(); if(!r.ok) alert("Merge failed: "+r.error); refresh(); }

let pending=null;
const ev = new EventSource("/api/stream");
ev.addEventListener("snapshot", (m)=>{ state=JSON.parse(m.data); render(); });
ev.addEventListener("event", (m)=>{
  let d; try{ d=JSON.parse(m.data); }catch{ return; }
  if(d.type==="activity"){ // live transcript line — apply directly, no refetch
    const a = state && state.agents && state.agents[d.id];
    if(a){ a.log=a.log||[]; a.log.push(d.line); if(a.log.length>40) a.log.shift(); render(); }
    return;
  }
  clearTimeout(pending); pending=setTimeout(refresh,180);
});
ev.onerror = ()=>{ $("status").textContent="reconnecting…"; $("status").className="pill"; };
// Tick the agent elapsed labels every second without a full re-render (so a half-typed answer survives).
setInterval(()=>{ for(const el of document.querySelectorAll(".el")) el.textContent = rel(el.dataset.since); }, 1000);
refresh();
</script>
</body>
</html>`;
