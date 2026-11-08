/**
 * GRE-374: the cloud keeps no review state, so cloud reads must go through the
 * local row. A retired fact must not come back from the cloud, a dispute must
 * still show, and a marker must name the local id review_fact acts on, never
 * the cloud id. Runs the real MCP server against a fake cloud.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const OLD = '2026-01-01 00:00:00+00';

// Cloud facts as the server returns them. #61 is the echo of the fact the test
// adds; #59 exists only in the cloud and is stale.
function fakeCloud() {
  const facts = [];
  const srv = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const send = (body) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.method === 'POST' && url.pathname === '/fact') {
        const b = JSON.parse(raw || '{}');
        facts.push({ id: 61, category: b.category, content: b.content, tags: null, project_name: b.project ?? null, created_at: new Date().toISOString(), source: null, last_verified_at: new Date().toISOString(), volatility: null, ttl_days: null });
        return send({ id: 61 });
      }
      const all = () => [...facts, { id: 59, category: 'deploy', content: 'Gizmo dispute probe runs on gizmo.netlify.app', tags: null, project_name: 'gizmo', created_at: OLD, source: null, last_verified_at: OLD, volatility: 'volatile', ttl_days: 10 }];
      if (url.pathname === '/search') return send({ sessions: [], facts: all() });
      if (url.pathname === '/semantic-search') return send({ results: all().map(f => ({ rowtype: 'fact', row_id: f.id, score: 0.9, text: f.content, project_name: f.project_name })) });
      if (url.pathname === '/context') return send({ recent_sessions: [{ id: 1, project_name: 'gizmo', summary: 's', session_date: OLD }], facts: all().map(f => ({ ...f, project_name: null })), active_projects: [{ name: 'gizmo', session_count: 1, last_session: OLD }] });
      if (url.pathname.startsWith('/export')) return send({ sessions: [], facts: [], tombstones: [] });
      send({ ok: true });
    });
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({ srv, url: `http://127.0.0.1:${srv.address().port}` })));
}

function mcpSession(home, cloudUrl, extraEnv = {}) {
  const p = spawn(process.execPath, [join(ROOT, 'src', 'server.js')], {
    cwd: home,
    env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, WHATNEXT_DATA_DIR: join(home, 'data'), WHATNEXT_CLOUD_URL: cloudUrl, WHATNEXT_API_KEY: 'test-key', WHATNEXT_AUDIT_LOG_DIR: join(home, 'logs'), WHATNEXT_PROJECTS_DIR: join(home, 'p'), ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '', stderr = '', nextId = 1;
  p.stderr.on('data', (d) => { stderr += d; });
  const exited = new Promise((_, fail) => p.once('exit', (code) => fail(Object.assign(new Error(`MCP server exited (${code})`), { stderr }))));
  exited.catch(() => {});
  const waiting = new Map();
  p.stdout.on('data', (d) => {
    buf += d;
    const lines = buf.split('\n'); buf = lines.pop();
    for (const l of lines) { if (!l.trim()) continue; const m = JSON.parse(l); waiting.get(m.id)?.(m); }
  });
  const rpc = (method, params) => new Promise((ok, fail) => {
    const id = nextId++;
    const t = setTimeout(() => fail(new Error(`${method} timed out`)), 30000);
    waiting.set(id, (m) => { clearTimeout(t); ok(m); });
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const tool = async (name, args) => {
    const m = await rpc('tools/call', { name, arguments: args });
    if (m.error) return `ERROR ${m.error.message}`;
    return m.result.content.map(c => c.text).join('\n');
  };
  const ready = Promise.race([exited, (async () => {
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  })()]);
  const close = async () => {
    if (p.exitCode === null && p.signalCode === null) { const e = new Promise((r) => p.once('exit', r)); p.kill('SIGKILL'); await e; }
  };
  return { ready, tool, close };
}

async function start(home, cloudUrl, env) {
  // bootstrap-selfheal.test.js can briefly break node_modules; retry until healed.
  for (const deadline = Date.now() + 150_000; ;) {
    const mcp = mcpSession(home, cloudUrl, env);
    try { await mcp.ready; return mcp; } catch (e) {
      await mcp.close();
      if (!/ERR_MODULE_NOT_FOUND|Cannot find (module|package)/.test(e.stderr ?? '') || Date.now() > deadline) throw e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

test('cloud reads follow local review state and local ids', { timeout: 200_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'wn-cloud-review-'));
  const { srv, url } = await fakeCloud();
  let mcp;
  try {
    mcp = await start(home, url);
    let out = await mcp.tool('add_fact', { category: 'note', content: 'Gizmo dispute probe fact', project: 'gizmo' });
    const id = Number(out.match(/local id: (\d+)/)[1]);
    await new Promise((r) => setTimeout(r, 500)); // background push records cloud id 61

    out = await mcp.tool('search_memories', { query: 'gizmo dispute probe' });
    assert.match(out, /\[cloud\]/);
    assert.match(out, new RegExp(`\\[gizmo\\] — note\\*\\* \\(#${id}\\)`), 'cloud fact shown with its local id and project');
    assert.doesNotMatch(out, /\(#61\)/);
    // Cloud-only stale fact: no local id to act on, so the marker names none.
    assert.match(out, /\(cloud #59, not on this machine yet\)/);
    assert.match(out, /\[STALE - [^\]]*Re-check before use\]/);
    assert.doesNotMatch(out, /review_fact id 59/);

    await mcp.tool('send_feedback', { message: 'wrong', fact_id: id });
    out = await mcp.tool('search_memories', { query: 'gizmo dispute probe' });
    assert.match(out, new RegExp(`\\[DISPUTED - reported wrong: wrong\\. Check before use; review_fact id ${id}\\]`));
    assert.match(await mcp.tool('semantic_search', { query: 'gizmo probe' }), /DISPUTED/);

    await mcp.tool('review_fact', { id, action: 'retire' });
    out = await mcp.tool('search_memories', { query: 'gizmo dispute probe' });
    assert.doesNotMatch(out, /Gizmo dispute probe fact/, 'retired fact not served from cloud');
    assert.match(out, /cloud #59/);
    assert.doesNotMatch(await mcp.tool('semantic_search', { query: 'gizmo probe' }), /Gizmo dispute probe fact/);
    assert.doesNotMatch(await mcp.tool('get_context', {}), /Gizmo dispute probe fact/);
    await mcp.close();

    // Installer mode: local has nothing active, so the cloud is asked - and filtered.
    mcp = await start(home, url, { WHATNEXT_PREFER_LOCAL: '1' });
    out = await mcp.tool('search_memories', { query: 'gizmo dispute probe' });
    assert.doesNotMatch(out, /Gizmo dispute probe fact/);
    assert.match(await mcp.tool('review_fact', { id, action: 'restore' }), /restored/);
    out = await mcp.tool('search_memories', { query: 'gizmo dispute probe' });
    assert.match(out, new RegExp(`\\(#${id}\\)`));
  } finally {
    await mcp?.close();
    srv.close();
    rmSync(home, { recursive: true, force: true });
  }
});
