/**
 * What Next — REST API + Web UI
 * Runs alongside the MCP server so ChatGPT and any other tool can write to the brain.
 * Default port: 3747
 *
 * Endpoints:
 *   GET  /              → Web form for manual session dumps
 *   POST /session       → Dump a session (JSON body)
 *   POST /fact          → Store a fact (JSON body)
 *   GET  /search?q=...          → FTS search memories
 *   POST /semantic-search       → Vector/semantic search memories
 *   GET  /context               → Session-start brief (recent sessions + facts + projects)
 *   GET  /projects              → List all projects
 *   GET  /project/:name         → Get full project history
 */

import { createServer } from 'http';
import { addSession, addFact, searchMemories, getProject, listProjects, getAllEmbeddings, getSessionById, getFactById, getRecentSessions, getAllFacts } from './db.js';
import { generateEmbedding, cosineSimilarity } from './embeddings.js';
import * as cloud from './cloud-client.js';

const PORT = process.env.WHATNEXT_PORT ?? 3747;

// ─── HTML web form ────────────────────────────────────────────────────────────
const HTML_FORM = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>What Next</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f0f; color: #e0e0e0; min-height: 100vh; }
    header { background: #1a1a1a; border-bottom: 2px solid #c0392b; padding: 1.5rem 2rem; display: flex; align-items: center; gap: 1rem; }
    header h1 { font-size: 1.5rem; color: #e74c3c; letter-spacing: 0.05em; }
    header span { color: #888; font-size: 0.9rem; }
    .tabs { display: flex; gap: 0; border-bottom: 1px solid #2a2a2a; background: #141414; padding: 0 2rem; }
    .tab { padding: 0.75rem 1.5rem; cursor: pointer; border-bottom: 2px solid transparent; color: #888; font-size: 0.9rem; transition: all 0.2s; }
    .tab.active { color: #e74c3c; border-bottom-color: #e74c3c; }
    .tab:hover { color: #e0e0e0; }
    .panel { display: none; padding: 2rem; max-width: 900px; }
    .panel.active { display: block; }
    label { display: block; font-size: 0.8rem; color: #888; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.4rem; margin-top: 1rem; }
    label:first-child { margin-top: 0; }
    input, textarea, select { width: 100%; background: #1a1a1a; border: 1px solid #2a2a2a; color: #e0e0e0; padding: 0.6rem 0.8rem; border-radius: 6px; font-size: 0.95rem; font-family: inherit; }
    input:focus, textarea:focus { outline: none; border-color: #c0392b; }
    textarea { resize: vertical; min-height: 80px; }
    .required { color: #e74c3c; }
    button { margin-top: 1.5rem; background: #c0392b; color: white; border: none; padding: 0.75rem 2rem; border-radius: 6px; font-size: 1rem; cursor: pointer; font-weight: 600; }
    button:hover { background: #e74c3c; }
    .toast { display: none; margin-top: 1rem; padding: 0.75rem 1rem; border-radius: 6px; background: #1e3a1e; color: #4caf50; border: 1px solid #2e5a2e; }
    .toast.error { background: #3a1e1e; color: #e74c3c; border-color: #5a2e2e; }
    .search-results { margin-top: 1.5rem; }
    .result-card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 8px; padding: 1rem; margin-bottom: 1rem; }
    .result-card h4 { color: #e74c3c; margin-bottom: 0.5rem; }
    .result-card .meta { font-size: 0.8rem; color: #666; margin-bottom: 0.5rem; }
    .result-card p { font-size: 0.9rem; line-height: 1.5; }
    .tag { display: inline-block; background: #2a2a2a; color: #888; font-size: 0.75rem; padding: 0.2rem 0.5rem; border-radius: 4px; margin: 0.2rem 0.2rem 0 0; }
    .project-list { display: grid; gap: 1rem; }
    .project-card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 8px; padding: 1rem; cursor: pointer; transition: border-color 0.2s; }
    .project-card:hover { border-color: #c0392b; }
    .project-card h3 { color: #e0e0e0; margin-bottom: 0.3rem; }
    .project-card .meta { font-size: 0.8rem; color: #666; }
    .hint { font-size: 0.8rem; color: #555; margin-top: 0.3rem; }
  </style>
</head>
<body>
  <header>
    <h1>&#x1F9E0; What Next</h1>
    <span>Your persistent second brain</span>
  </header>

  <div class="tabs">
    <div class="tab active" onclick="showTab('dump')">Dump Session</div>
    <div class="tab" onclick="showTab('fact')">Add Fact</div>
    <div class="tab" onclick="showTab('search')">Search</div>
    <div class="tab" onclick="showTab('projects')">Projects</div>
    <a href="/import" style="margin-left:auto;padding:0.75rem 1rem;color:#555;font-size:0.85rem;text-decoration:none;" title="Import ChatGPT history">Import History</a>
    <a href="/setup" style="padding:0.75rem 1rem;color:#555;font-size:0.85rem;text-decoration:none;" title="ChatGPT bookmarklet setup">ChatGPT Setup</a>
  </div>

  <!-- DUMP SESSION -->
  <div id="tab-dump" class="panel active">
    <label>Project Name <span class="required">*</span></label>
    <input id="d-project" placeholder="e.g. what-next, my-saas-app" />
    <p class="hint">Use the same name as your folder in ~/Documents/projects/</p>

    <label>Session Summary <span class="required">*</span></label>
    <textarea id="d-summary" placeholder="What happened this session? Keep it concise but complete."></textarea>

    <label>What was built</label>
    <textarea id="d-built" placeholder="Specific features, files, components created or changed" style="min-height:60px"></textarea>

    <label>Key decisions</label>
    <textarea id="d-decisions" placeholder="Architectural or design choices made and why" style="min-height:60px"></textarea>

    <label>Stack / Technologies</label>
    <input id="d-stack" placeholder="e.g. Next.js, Supabase, Tailwind, Stripe" />

    <label>Next steps</label>
    <textarea id="d-next" placeholder="What to pick up next session" style="min-height:60px"></textarea>

    <label>Tags</label>
    <input id="d-tags" placeholder="e.g. react,auth,api,bug-fix (comma-separated)" />

    <button onclick="dumpSession()">Dump to Brain</button>
    <div id="dump-toast" class="toast"></div>
  </div>

  <!-- ADD FACT -->
  <div id="tab-fact" class="panel">
    <label>Category <span class="required">*</span></label>
    <input id="f-category" placeholder="e.g. preference, pattern, lesson, stack-choice" />

    <label>Content <span class="required">*</span></label>
    <textarea id="f-content" placeholder="The fact, insight, or preference to remember"></textarea>

    <label>Project (optional)</label>
    <input id="f-project" placeholder="Leave blank for a global fact" />

    <label>Tags</label>
    <input id="f-tags" placeholder="comma-separated" />

    <button onclick="addFact()">Store Fact</button>
    <div id="fact-toast" class="toast"></div>
  </div>

  <!-- SEARCH -->
  <div id="tab-search" class="panel">
    <label>Search your memories</label>
    <input id="s-query" placeholder="e.g. Supabase auth, Docker setup, payment integration..." onkeydown="if(event.key==='Enter') doSearch()" />
    <button onclick="doSearch()">Search</button>
    <div id="search-results" class="search-results"></div>
  </div>

  <!-- PROJECTS -->
  <div id="tab-projects" class="panel">
    <button onclick="loadProjects()" style="margin-top:0">Refresh</button>
    <div id="project-list" class="project-list" style="margin-top:1rem"></div>
  </div>

  <script>
    function showTab(name) {
      document.querySelectorAll('.tab').forEach((t,i) => t.classList.toggle('active', ['dump','fact','search','projects'][i] === name));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      document.getElementById('tab-' + name).classList.add('active');
      if (name === 'projects') loadProjects();
    }

    function toast(id, msg, ok=true) {
      const el = document.getElementById(id);
      el.textContent = msg;
      el.className = 'toast' + (ok ? '' : ' error');
      el.style.display = 'block';
      if (ok) setTimeout(() => el.style.display = 'none', 4000);
    }

    async function dumpSession() {
      const project = document.getElementById('d-project').value.trim();
      const summary = document.getElementById('d-summary').value.trim();
      if (!project || !summary) return toast('dump-toast', 'Project and summary are required.', false);
      const res = await fetch('/session', { method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ project, summary,
          what_was_built: document.getElementById('d-built').value.trim() || undefined,
          decisions: document.getElementById('d-decisions').value.trim() || undefined,
          stack: document.getElementById('d-stack').value.trim() || undefined,
          next_steps: document.getElementById('d-next').value.trim() || undefined,
          tags: document.getElementById('d-tags').value.trim() || undefined,
        })
      });
      const data = await res.json();
      if (res.ok) { toast('dump-toast', '✅ Session saved to What Next (id: ' + data.id + ')'); ['d-summary','d-built','d-decisions','d-next','d-tags'].forEach(id => document.getElementById(id).value = ''); }
      else toast('dump-toast', data.error, false);
    }

    async function addFact() {
      const category = document.getElementById('f-category').value.trim();
      const content = document.getElementById('f-content').value.trim();
      if (!category || !content) return toast('fact-toast', 'Category and content are required.', false);
      const res = await fetch('/fact', { method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ category, content,
          project: document.getElementById('f-project').value.trim() || undefined,
          tags: document.getElementById('f-tags').value.trim() || undefined,
        })
      });
      const data = await res.json();
      if (res.ok) { toast('fact-toast', '✅ Fact stored (id: ' + data.id + ')'); document.getElementById('f-content').value = ''; }
      else toast('fact-toast', data.error, false);
    }

    async function doSearch() {
      const q = document.getElementById('s-query').value.trim();
      if (!q) return;
      const res = await fetch('/search?q=' + encodeURIComponent(q));
      const data = await res.json();
      const el = document.getElementById('search-results');
      if (!data.sessions.length && !data.facts.length) { el.innerHTML = '<p style="color:#666;margin-top:1rem">No results found.</p>'; return; }
      let html = '';
      for (const s of data.sessions) {
        html += '<div class="result-card"><h4>' + s.project_name + '</h4><div class="meta">' + s.session_date + '</div><p>' + s.summary + '</p>';
        if (s.stack) html += '<p style="margin-top:0.5rem;color:#888">Stack: ' + s.stack + '</p>';
        if (s.tags) html += '<div style="margin-top:0.5rem">' + s.tags.split(',').map(t => '<span class="tag">' + t.trim() + '</span>').join('') + '</div>';
        html += '</div>';
      }
      for (const f of data.facts) {
        html += '<div class="result-card"><h4>' + (f.project_name || 'Global') + ' — ' + f.category + '</h4><p>' + f.content + '</p></div>';
      }
      el.innerHTML = html;
    }

    async function loadProjects() {
      const res = await fetch('/projects');
      const data = await res.json();
      const el = document.getElementById('project-list');
      if (!data.length) { el.innerHTML = '<p style="color:#666">No projects yet.</p>'; return; }
      el.innerHTML = data.map(p =>
        '<div class="project-card"><h3>' + p.name + '</h3><div class="meta">' + p.session_count + ' session(s) · last: ' + (p.last_session || 'never') + '</div>' + (p.description ? '<p style="font-size:0.85rem;color:#888;margin-top:0.3rem">' + p.description + '</p>' : '') + '</div>'
      ).join('');
    }
  </script>
</body>
</html>`;

// ─── ChatGPT dump parser ──────────────────────────────────────────────────────
// Looks for a ---WHAT NEXT DUMP--- block that ChatGPT is instructed to produce
function parseAgentDump(raw) {
  const match = raw.match(/---WHAT NEXT DUMP---([\s\S]*?)(?:---END DUMP---|$)/i);
  if (!match) return null;
  const block = match[1];
  const get = (key) => {
    const m = block.match(new RegExp(`${key}:\\s*(.+?)(?=\\n[A-Z]|$)`, 'is'));
    return m ? m[1].trim() : undefined;
  };
  const project = get('PROJECT');
  const summary = get('SUMMARY');
  if (!project || !summary) return null;
  return {
    project,
    summary,
    what_was_built: get('BUILT'),
    decisions: get('DECISIONS'),
    stack: get('STACK'),
    next_steps: get('NEXT'),
    tags: get('TAGS'),
  };
}

// ─── Setup page ───────────────────────────────────────────────────────────────
const BOOKMARKLET = `javascript:(function(){
  var msgs=document.querySelectorAll('[data-message-author-role]');
  var text='';
  msgs.forEach(function(m){
    var role=m.getAttribute('data-message-author-role');
    var content=m.innerText;
    text+=(role==='user'?'USER: ':'AI: ')+content+'\\n\\n';
  });
  if(!text){alert('No ChatGPT messages found on this page.');return;}
  fetch('http://localhost:3747/ingest',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({raw:text})
  }).then(function(r){return r.json();}).then(function(d){
    if(d.id){alert('What Next updated! Project: '+d.project+' (session #'+d.id+')');}

    else{alert('Could not find a dump block. Make sure ChatGPT produced the summary.\\n\\nError: '+(d.error||'unknown'));}
  }).catch(function(){alert('What Next not reachable. Is it running?');});
})();`;

const SETUP_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>What Next — ChatGPT Setup</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f0f; color: #e0e0e0; padding: 2rem; max-width: 860px; margin: 0 auto; }
    h1 { color: #e74c3c; margin-bottom: 0.3rem; }
    h2 { color: #e74c3c; margin: 2rem 0 0.75rem; font-size: 1.1rem; }
    p { color: #aaa; line-height: 1.6; margin-bottom: 1rem; }
    .step { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 8px; padding: 1.25rem; margin-bottom: 1rem; }
    .step-num { color: #e74c3c; font-weight: 700; font-size: 0.8rem; text-transform: uppercase; margin-bottom: 0.5rem; }
    pre { background: #111; border: 1px solid #2a2a2a; border-radius: 6px; padding: 1rem; overflow-x: auto; font-size: 0.85rem; line-height: 1.5; color: #ccc; white-space: pre-wrap; word-break: break-all; }
    .bookmarklet { display: inline-block; background: #c0392b; color: white; padding: 0.6rem 1.2rem; border-radius: 6px; text-decoration: none; font-weight: 600; cursor: grab; border: 2px dashed #e74c3c; margin: 0.5rem 0; }
    .bookmarklet:active { cursor: grabbing; }
    .tip { font-size: 0.8rem; color: #666; margin-top: 0.5rem; }
    a { color: #e74c3c; }
  </style>
</head>
<body>
  <h1>ChatGPT → What Next Setup</h1>
  <p>Two steps. Do this once and you're set forever.</p>

  <h2>Step 1 — Give ChatGPT its standing instructions</h2>
  <div class="step">
    <div class="step-num">Do this once in ChatGPT</div>
    <p>Go to <a href="https://chatgpt.com" target="_blank">chatgpt.com</a> → Settings → Personalization → Custom Instructions → paste this into "How would you like ChatGPT to respond?"</p>
    <pre>At the end of every work session where we built, decided, or learned something significant, output a summary block in this exact format:

---WHAT NEXT DUMP---
PROJECT: [folder name of the project, e.g. my-saas-app]
SUMMARY: [2-3 sentence summary of what happened this session]
BUILT: [specific files, features, or components created or changed]
DECISIONS: [key architectural or design decisions made and why]
STACK: [technologies and libraries used, comma-separated]
NEXT: [what to pick up next session]
TAGS: [relevant tags, comma-separated, e.g. react,auth,api]
---END DUMP---

Only output this block when there is genuinely something worth remembering. Skip it for casual questions or quick lookups.</pre>
  </div>

  <h2>Step 2 — Add the bookmarklet to your browser</h2>
  <div class="step">
    <div class="step-num">Drag this to your bookmarks bar</div>
    <p>Show your bookmarks bar (Cmd+Shift+B), then drag the button below onto it:</p>
    <a class="bookmarklet" href="${BOOKMARKLET.replace(/"/g, '&quot;')}">&#x1F9E0; Dump to What Next</a>
    <p class="tip">If drag doesn't work: right-click your bookmarks bar → "Add page" → paste the code below as the URL.</p>
    <pre>${BOOKMARKLET.replace(/</g, '&lt;')}</pre>
  </div>

  <h2>How it works after setup</h2>
  <div class="step">
    <p>1. Finish a ChatGPT session<br>
    2. ChatGPT will output the <code>---WHAT NEXT DUMP---</code> block automatically at the end<br>
    3. Click the bookmarklet in your bookmarks bar<br>
    4. Done — the session is in your brain. You'll see a confirmation popup.</p>
  </div>

  <p style="margin-top:2rem"><a href="/">← Back to What Next</a></p>
</body>
</html>`;

// ─── Import page ─────────────────────────────────────────────────────────────
const IMPORT_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>What Next — Import ChatGPT History</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f0f; color: #e0e0e0; padding: 2rem; max-width: 760px; margin: 0 auto; }
    h1 { color: #e74c3c; margin-bottom: 0.3rem; }
    h2 { color: #e74c3c; margin: 2rem 0 0.75rem; font-size: 1.1rem; }
    p { color: #aaa; line-height: 1.6; margin-bottom: 1rem; }
    .step { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 8px; padding: 1.25rem; margin-bottom: 1rem; }
    .step-num { color: #e74c3c; font-weight: 700; font-size: 0.8rem; text-transform: uppercase; margin-bottom: 0.5rem; }
    .drop-zone { border: 2px dashed #333; border-radius: 10px; padding: 3rem 2rem; text-align: center; cursor: pointer; transition: border-color 0.2s; margin: 1rem 0; }
    .drop-zone:hover, .drop-zone.dragover { border-color: #e74c3c; }
    .drop-zone p { margin: 0; color: #666; }
    .drop-zone strong { color: #e0e0e0; display: block; font-size: 1.1rem; margin-bottom: 0.5rem; }
    input[type=file] { display: none; }
    button { background: #c0392b; color: white; border: none; padding: 0.75rem 2rem; border-radius: 6px; font-size: 1rem; cursor: pointer; font-weight: 600; margin-top: 1rem; }
    button:disabled { background: #444; cursor: default; }
    button:hover:not(:disabled) { background: #e74c3c; }
    .result { display: none; margin-top: 1.5rem; background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 8px; padding: 1.25rem; }
    .result h3 { color: #4caf50; margin-bottom: 1rem; }
    .stat { display: flex; justify-content: space-between; padding: 0.4rem 0; border-bottom: 1px solid #222; font-size: 0.95rem; }
    .stat:last-child { border-bottom: none; }
    .stat span:last-child { color: #e74c3c; font-weight: 600; }
    a { color: #e74c3c; }
    .error { color: #e74c3c; margin-top: 1rem; display: none; }
  </style>
</head>
<body>
  <h1>Import ChatGPT History</h1>
  <p>Bulk import your entire ChatGPT conversation history into What Next.</p>

  <h2>Step 1 — Export from ChatGPT</h2>
  <div class="step">
    <div class="step-num">Do this in ChatGPT</div>
    <p>chatgpt.com → top-right menu → Settings → Data Controls → Export data</p>
    <p>ChatGPT will email you a download link (usually within minutes). Download the ZIP, unzip it, and find <strong>conversations.json</strong> inside.</p>
  </div>

  <h2>Step 2 — Upload conversations.json</h2>
  <div class="drop-zone" id="dropZone" onclick="document.getElementById('fileInput').click()">
    <strong>Click to select or drag & drop</strong>
    <p>conversations.json from your ChatGPT export</p>
  </div>
  <input type="file" id="fileInput" accept=".json" />
  <div id="fileName" style="color:#666;font-size:0.85rem;margin-top:0.5rem"></div>
  <button id="importBtn" disabled onclick="doImport()">Import to What Next</button>
  <div class="error" id="error"></div>

  <div class="result" id="result">
    <h3>Import complete!</h3>
    <div class="stat"><span>Total conversations</span><span id="r-total"></span></div>
    <div class="stat"><span>Imported</span><span id="r-imported"></span></div>
    <div class="stat"><span>From WHAT NEXT DUMP blocks</span><span id="r-dump"></span></div>
    <div class="stat"><span>Auto-summarised</span><span id="r-auto"></span></div>
    <div class="stat"><span>Skipped (too short / trivial)</span><span id="r-skipped"></span></div>
    <p style="margin-top:1rem"><a href="/projects">Browse your projects →</a></p>
  </div>

  <p style="margin-top:2rem"><a href="/">← Back to What Next</a></p>

  <script>
    let selectedFile = null;
    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('fileInput');
    const importBtn = document.getElementById('importBtn');

    fileInput.addEventListener('change', () => setFile(fileInput.files[0]));

    dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    dropZone.addEventListener('drop', e => { e.preventDefault(); dropZone.classList.remove('dragover'); setFile(e.dataTransfer.files[0]); });

    function setFile(file) {
      if (!file) return;
      selectedFile = file;
      document.getElementById('fileName').textContent = 'Selected: ' + file.name + ' (' + (file.size / 1024 / 1024).toFixed(1) + ' MB)';
      importBtn.disabled = false;
    }

    async function doImport() {
      if (!selectedFile) return;
      importBtn.disabled = true;
      importBtn.textContent = 'Importing...';
      document.getElementById('error').style.display = 'none';
      document.getElementById('result').style.display = 'none';
      try {
        const text = await selectedFile.text();
        const res = await fetch('/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: text });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        document.getElementById('r-total').textContent = data.total;
        document.getElementById('r-imported').textContent = data.imported;
        document.getElementById('r-dump').textContent = data.fromDump;
        document.getElementById('r-auto').textContent = data.imported - data.fromDump;
        document.getElementById('r-skipped').textContent = data.skipped;
        document.getElementById('result').style.display = 'block';
      } catch(e) {
        const err = document.getElementById('error');
        err.textContent = 'Import failed: ' + e.message;
        err.style.display = 'block';
      }
      importBtn.disabled = false;
      importBtn.textContent = 'Import to What Next';
    }
  </script>
</body>
</html>`;

// ─── JSON helpers ─────────────────────────────────────────────────────────────
function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    // Restrict to localhost only — api is local-only, no cross-origin needed
    'Access-Control-Allow-Origin': 'http://localhost:3747',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(payload);
}

function sendHtml(res, html) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

const MAX_BODY_BYTES = 64 * 1024; // 64KB
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;
    req.on('data', chunk => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        return;
      }
      raw += chunk;
    });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch { reject(Object.assign(new Error('Invalid JSON'), { statusCode: 400 })); }
    });
  });
}

function parseRawBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });
}

// ─── ChatGPT import logic (shared with import-chatgpt.js) ────────────────────
function extractMessages(mapping) {
  if (!mapping) return [];
  return Object.values(mapping)
    .filter(n => n.message?.content && n.message?.author)
    .map(n => ({
      role: n.message.author.role,
      text: (n.message.content.parts ?? []).filter(p => typeof p === 'string').join(''),
      time: n.message.create_time ?? 0,
    }))
    .filter(m => m.text.trim() && m.role !== 'system')
    .sort((a, b) => a.time - b.time);
}

function findDumpBlock(messages) {
  for (const m of [...messages].reverse()) {
    const match = m.text.match(/---WHAT NEXT DUMP---([\s\S]*?)(?:---END DUMP---|$)/i);
    if (!match) continue;
    const block = match[1];
    const get = (key) => {
      const r = block.match(new RegExp(`${key}:\\s*(.+?)(?=\\n[A-Z]|$)`, 'is'));
      return r ? r[1].trim() : undefined;
    };
    const project = get('PROJECT'), summary = get('SUMMARY');
    if (project && summary) return { project, summary, what_was_built: get('BUILT'), decisions: get('DECISIONS'), stack: get('STACK'), next_steps: get('NEXT'), tags: get('TAGS') };
  }
  return null;
}

function titleToProject(title) {
  return (title ?? 'unknown').toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 50);
}

function buildStack(messages) {
  const text = messages.map(m => m.text).join(' ').toLowerCase();
  const known = ['react','next.js','nextjs','vue','angular','svelte','node','express','fastapi','django','flask','typescript','javascript','python','rust','go','supabase','firebase','mongodb','postgresql','mysql','sqlite','redis','prisma','tailwind','docker','aws','vercel','stripe','openai','anthropic','langchain','graphql'];
  return known.filter(t => text.includes(t)).join(', ') || undefined;
}

function isWorthImporting(messages) {
  return messages.filter(m => m.role === 'assistant').map(m => m.text).join(' ').split(/\s+/).length > 100;
}

function importConversations(conversations) {
  let imported = 0, skipped = 0, fromDump = 0;
  for (const convo of conversations) {
    const title = convo.title ?? 'Untitled';
    const messages = extractMessages(convo.mapping);
    const date = convo.create_time ? new Date(convo.create_time * 1000).toISOString().slice(0, 10) : 'unknown';
    if (!isWorthImporting(messages)) { skipped++; continue; }
    const dump = findDumpBlock(messages);
    if (dump) { addSession(dump); fromDump++; imported++; continue; }
    const project = titleToProject(title);
    const firstUser = messages.find(m => m.role === 'user')?.text ?? '';
    const summary = `[Imported from ChatGPT] "${title}". Started with: ${firstUser.slice(0, 300).replace(/\n+/g, ' ').trim()}`;
    addSession({ project, summary, stack: buildStack(messages), tags: `chatgpt-import,${date.slice(0, 7)}` });
    imported++;
  }
  return { total: conversations.length, imported, skipped, fromDump };
}

// ─── Server ───────────────────────────────────────────────────────────────────
export function startApiServer() {
  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const method = req.method;

    // CORS preflight — local-only (localhost origins only)
    if (method === 'OPTIONS') {
      const origin = req.headers.origin ?? '';
      const allowed = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ? origin : 'null';
      res.writeHead(204, { 'Access-Control-Allow-Origin': allowed, 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' });
      res.end();
      return;
    }

    try {
      // GET / — web UI
      if (method === 'GET' && url.pathname === '/') {
        return sendHtml(res, HTML_FORM);
      }

      // POST /session — dump a session
      if (method === 'POST' && url.pathname === '/session') {
        const body = await parseBody(req);
        if (!body.project || !body.summary) return send(res, 400, { error: 'project and summary are required' });
        const id = addSession(body);
        // Write-through to cloud (fire and forget — local write already succeeded)
        if (cloud.isEnabled()) cloud.postSession(body).catch(() => {});
        return send(res, 201, { id, message: 'Session stored' });
      }

      // POST /fact — store a fact
      if (method === 'POST' && url.pathname === '/fact') {
        const body = await parseBody(req);
        if (!body.category || !body.content) return send(res, 400, { error: 'category and content are required' });
        const id = addFact(body);
        // Write-through to cloud (fire and forget)
        if (cloud.isEnabled()) cloud.postFact(body).catch(() => {});
        return send(res, 201, { id, message: 'Fact stored' });
      }

      // GET /search?q=...
      if (method === 'GET' && url.pathname === '/search') {
        const q = url.searchParams.get('q');
        if (!q) return send(res, 400, { error: 'q parameter required' });
        const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '10', 10), 50);
        return send(res, 200, searchMemories(q, limit));
      }

      // POST /semantic-search — vector similarity search
      if (method === 'POST' && url.pathname === '/semantic-search') {
        const body = await parseBody(req);
        if (!body.query) return send(res, 400, { error: 'query field required' });
        const limit = body.limit ?? 10;
        const queryEmbedding = await generateEmbedding(body.query);
        const allEmbeddings = getAllEmbeddings();
        const scored = allEmbeddings.map(({ rowtype, row_id, embedding }) => ({
          rowtype,
          row_id,
          score: cosineSimilarity(queryEmbedding, embedding),
        }));
        scored.sort((a, b) => b.score - a.score);
        const top = scored.slice(0, limit);
        const results = top.map(({ rowtype, row_id, score }) => {
          const record = rowtype === 'session' ? getSessionById(row_id) : getFactById(row_id);
          return record ? { ...record, rowtype, score } : null;
        }).filter(Boolean);
        return send(res, 200, { results });
      }

      // POST /ingest — accepts a raw WHAT NEXT DUMP block from ChatGPT bookmarklet
      if (method === 'POST' && url.pathname === '/ingest') {
        const body = await parseBody(req);
        if (!body.raw) return send(res, 400, { error: 'raw field required' });
        const parsed = parseAgentDump(body.raw);
        if (!parsed) return send(res, 400, { error: 'Could not find a WHAT NEXT DUMP block in the text' });
        const id = addSession(parsed);
        return send(res, 201, { id, message: 'Session ingested', project: parsed.project });
      }

      // GET /setup — ChatGPT setup instructions + bookmarklet
      if (method === 'GET' && url.pathname === '/setup') {
        return sendHtml(res, SETUP_PAGE);
      }

      // GET /import — upload page
      if (method === 'GET' && url.pathname === '/import') {
        return sendHtml(res, IMPORT_PAGE);
      }

      // POST /import — process uploaded conversations.json
      if (method === 'POST' && url.pathname === '/import') {
        const raw = await parseRawBody(req);
        let conversations;
        try { conversations = JSON.parse(raw); } catch { return send(res, 400, { error: 'Invalid JSON — make sure you upload conversations.json exactly as exported' }); }
        if (!Array.isArray(conversations)) return send(res, 400, { error: 'Expected an array of conversations' });
        const result = importConversations(conversations);
        return send(res, 200, result);
      }

      // GET /context — session-start brief (recent sessions + all facts + projects)
      if (method === 'GET' && url.pathname === '/context') {
        const [recent, facts, projects] = await Promise.all([
          Promise.resolve(getRecentSessions(5)),
          Promise.resolve(getAllFacts()),
          Promise.resolve(listProjects()),
        ]);
        return send(res, 200, { recent_sessions: recent, facts, active_projects: projects });
      }

      // GET /projects
      if (method === 'GET' && url.pathname === '/projects') {
        return send(res, 200, listProjects());
      }

      // GET /project/:name
      const projectMatch = url.pathname.match(/^\/project\/(.+)$/);
      if (method === 'GET' && projectMatch) {
        const name = decodeURIComponent(projectMatch[1]);
        const project = getProject(name);
        if (!project) return send(res, 404, { error: 'Project not found' });
        return send(res, 200, project);
      }

      send(res, 404, { error: 'Not found' });
    } catch (err) {
      send(res, 500, { error: err.message });
    }
  });

  httpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      process.stderr.write(`[what-next] Port ${PORT} in use, retrying in 5s...\n`);
      setTimeout(() => httpServer.listen(PORT, '127.0.0.1'), 5000);
    } else {
      process.stderr.write(`[what-next] Server error: ${err.message}\n`);
      process.exit(1);
    }
  });

  httpServer.listen(PORT, '127.0.0.1', () => {
    process.stderr.write(`[what-next] Web UI + REST API running at http://localhost:${PORT}\n`);
  });

  return httpServer;
}
