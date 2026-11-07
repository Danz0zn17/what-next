/**
 * v2.5.0 memory upgrade over the real entry points: the REST API
 * (src/api-server.js) and the MCP server (src/server.js), each with a
 * throwaway HOME and data dir, no cloud.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
let dir, port, child;

function freePort() {
  return new Promise((ok, fail) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => { const { port: p } = srv.address(); srv.close(() => ok(p)); });
    srv.on('error', fail);
  });
}

function call(method, path, data) {
  return new Promise((ok, fail) => {
    const headers = { Host: `localhost:${port}` };
    if (data !== undefined) headers['Content-Type'] = 'application/json';
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(raw); } catch {} ok({ status: res.statusCode, json, text: raw }); });
    });
    req.on('error', fail);
    if (data !== undefined) req.write(JSON.stringify(data));
    req.end();
  });
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wn-upgrade-api-'));
  port = await freePort();
  child = spawn(process.execPath, [join(ROOT, 'src', 'api-server.js')], {
    cwd: dir,
    env: {
      PATH: process.env.PATH, HOME: dir, USERPROFILE: dir, WHATNEXT_DATA_DIR: join(dir, 'data'),
      WHATNEXT_PORT: String(port), WHATNEXT_PROJECTS_DIR: join(dir, 'p'), WHATNEXT_CLOUD_URL: '',
      WHATNEXT_CURATOR: '0', WHATNEXT_UPDATE_CHECK: '0',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  for (let i = 0; i < 100; i++) {
    try { if ((await call('GET', '/health')).status === 200) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`api-server did not start:\n${stderr}`);
});

after(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise((r) => child.once('exit', r));
    child.kill('SIGKILL');
    await exited;
  }
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (e) { if (process.platform !== 'win32') throw e; }
});

test('POST /fact takes source, volatility and ttl_days; /fact/:id shows freshness', async () => {
  const r = await call('POST', '/fact', { category: 'note', content: 'Ulwazi lives on ulwazi.netlify.app', volatility: 'volatile', ttl_days: 14, source: 'netlify api' });
  assert.equal(r.status, 201);
  const f = await call('GET', `/fact/${r.json.id}`);
  assert.equal(f.json.source, 'netlify api');
  assert.equal(f.json.freshness.state, 'fresh');
  assert.equal(f.json.freshness.ttl_days, 14);
  assert.equal((await call('POST', '/fact', { category: 'x', content: 'y', volatility: 'sometimes' })).status, 400);
  const plain = await call('POST', '/fact', { category: 'preference', content: 'No long dashes' });
  assert.equal((await call('GET', `/fact/${plain.json.id}`)).json.source, 'api');
});

test('dispute, verify, retire and restore over REST', async () => {
  const { json: { id } } = await call('POST', '/fact', { category: 'pricing', content: 'Standard site is R5,000' });
  let r = await call('POST', `/fact/${id}/dispute`, { note: 'old price', correction: 'Standard site is R8,500 to R15,000' });
  assert.equal(r.json.fact.freshness.state, 'disputed');
  const search = await call('GET', '/search?q=standard%20site');
  assert.equal(search.json.facts[0].freshness.state, 'disputed');
  r = await call('POST', `/fact/${id}/verify`, { note: 'checked with Danny' });
  assert.notEqual(r.json.fact.freshness.state, 'disputed');
  r = await call('POST', `/fact/${id}/retire`, {});
  assert.equal(r.json.fact.status, 'retired');
  assert.equal((await call('POST', `/fact/${id}/retire`, {})).status, 409);
  assert.equal((await call('POST', `/fact/${id}/verify`, {})).status, 409);
  r = await call('POST', `/fact/${id}/restore`, {});
  assert.equal(r.json.fact.status, 'active');
  assert.equal((await call('POST', '/fact/999999/verify', {})).status, 404);
  const hist = await call('GET', `/fact/${id}`);
  assert.deepEqual(hist.json.changes.map(c => c.action), ['dispute', 'verify', 'retired', 'restore']);
});

test('/context and /orientation: role adds role_block, no role is the old shape', async () => {
  await call('POST', '/fact', { category: 'deploy', content: 'Ulwazi deploys from main via Netlify', tags: 'role:engineer' });
  const plain = await call('GET', '/context');
  assert.deepEqual(Object.keys(plain.json).sort(), ['active_projects', 'facts', 'recent_sessions']);
  const eng = await call('GET', '/context?role=engineer');
  assert.match(eng.json.role_block, /Engineer start-up block/);
  assert.match(eng.json.role_block, /Ulwazi deploys from main/);
  assert.ok(eng.json.role_block.split('\n').length <= 30);
  assert.equal((await call('GET', '/context?role=intern')).status, 400);
  await call('POST', '/session', { project: 'ulwazi', summary: 'hero', decisions: 'Lesson: purge the CDN after a domain change', next_steps: 'SEO' });
  const o = await call('GET', '/orientation/ulwazi?role=qa');
  assert.equal(o.json.project, 'ulwazi');
  assert.match(o.json.role_block, /QA start-up block - ulwazi/);
  assert.equal((await call('GET', '/orientation/ulwazi')).json.role_block, undefined);
});

test('POST /curate/run dry run, apply, status and undo', async () => {
  const dry = await call('POST', '/curate/run', { dry_run: true });
  assert.equal(dry.status, 200);
  assert.equal(dry.json.dry_run, true);
  assert.equal(dry.json.lessons_promoted.length, 1);
  assert.equal(dry.json.lessons_promoted[0].fact_id, undefined);
  const run = await call('POST', '/curate/run', {});
  assert.equal(run.json.dry_run, false);
  const lessonId = run.json.lessons_promoted[0].fact_id;
  assert.ok(lessonId);
  assert.ok(run.json.pages.created.includes('ulwazi'));
  const status = await call('GET', '/curate/run/status');
  assert.equal(status.json.id, run.json.run_id);
  assert.equal((await call('GET', `/curate/run/status?run_id=${run.json.run_id}`)).json.kind, 'dream');
  assert.equal((await call('GET', '/curate/run/status?run_id=99999')).status, 404);
  assert.equal((await call('POST', '/curate/undo', {})).status, 400);
  assert.equal((await call('POST', '/curate/undo', { run_id: 99999 })).status, 404);
  const undo = await call('POST', '/curate/undo', { run_id: run.json.run_id });
  assert.ok(undo.json.reverted >= 1);
  assert.equal((await call('GET', `/fact/${lessonId}`)).json.status, 'retired');
  // /curate and /curate/status are unchanged.
  assert.equal((await call('POST', '/curate', { dry_run: true })).status, 200);
  assert.ok('facts_scanned' in (await call('GET', '/curate/status')).json);
});

test('pages over REST', async () => {
  let r = await call('POST', '/page', { slug: 'Acme Surf', kind: 'client', fields: { contact: 'Jo, 082 555 1234' }, links: ['ulwazi'] });
  assert.equal(r.status, 200);
  assert.equal(r.json.page.slug, 'acme-surf');
  assert.equal((await call('POST', '/page', { slug: 'new-one' })).status, 400, 'kind needed');
  assert.equal((await call('POST', '/page', { slug: 'x', kind: 'client', links: 'ulwazi' })).status, 400);
  r = await call('GET', '/page/ulwazi');
  assert.deepEqual(r.json.backlinks.map(b => b.slug), ['acme-surf']);
  r = await call('GET', '/pages?kind=client');
  assert.deepEqual(r.json.pages.map(p => p.slug), ['acme-surf']);
  assert.equal((await call('GET', '/pages?kind=person')).status, 400);
  assert.equal((await call('GET', '/page/missing')).status, 404);
});

// ─── MCP ─────────────────────────────────────────────────────────────────────
function mcpSession(home) {
  const p = spawn(process.execPath, [join(ROOT, 'src', 'server.js')], {
    cwd: home,
    env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, WHATNEXT_DATA_DIR: join(home, 'data'), WHATNEXT_CLOUD_URL: '', WHATNEXT_AUDIT_LOG_DIR: join(home, 'logs'), WHATNEXT_PROJECTS_DIR: join(home, 'p') },
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
    return m.result.content.map(c => c.text).join('\n') + (m.result.isError ? '\nIS_ERROR' : '');
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

test('MCP: feedback disputes a fact, search flags it, review_fact clears it, pages and roles work', { timeout: 200_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'wn-upgrade-mcp-'));
  let mcp;
  try {
    // bootstrap-selfheal.test.js briefly breaks node_modules when tests run in
    // parallel; retry until its npm install has healed it.
    for (const deadline = Date.now() + 150_000; ;) {
      mcp = mcpSession(home);
      try { await mcp.ready; break; } catch (e) {
        await mcp.close();
        if (!/ERR_MODULE_NOT_FOUND|Cannot find (module|package)/.test(e.stderr ?? '') || Date.now() > deadline) throw e;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    const { tool } = mcp;
    let out = await tool('add_fact', { category: 'deploy', content: 'Surf Rides runs on surf-rides.netlify.app', project: 'surf-rides', volatility: 'volatile', ttl_days: 10, source: 'netlify' });
    const id = Number(out.match(/local id: (\d+)/)[1]);
    out = await tool('search_memories', { query: 'surf rides netlify' });
    assert.match(out, new RegExp(`\\(#${id}\\)`));
    assert.doesNotMatch(out, /STALE|DISPUTED/);

    out = await tool('send_feedback', { message: 'Moved to Railway', fact_id: id, correction: 'Surf Rides runs on Railway service surf-rides-web' });
    assert.match(out, new RegExp(`Fact #${id} marked disputed with a correction`));
    assert.match(out, /Cloud not configured/);
    out = await tool('search_memories', { query: 'surf rides netlify' });
    assert.match(out, /\[DISPUTED - reported wrong: Moved to Railway/);
    assert.match(await tool('send_feedback', { message: 'x', fact_id: 99999 }), /Fact 99999 not found/);
    // Plain feedback with no fact keeps its old reply.
    assert.equal(await tool('send_feedback', { message: 'hello' }), 'Cloud not configured — feedback could not be sent.');

    out = await tool('curate_memory', { mode: 'full', dry_run: true });
    assert.match(out, /Dreaming pass \(dry run - nothing changed\)/);
    assert.match(out, new RegExp(`#${id} would be replaced by its correction`));
    out = await tool('curate_memory', { mode: 'full' });
    assert.match(out, /Undo this run: POST \/curate\/undo/);
    out = await tool('search_memories', { query: 'Railway service' });
    assert.match(out, /surf-rides-web/);
    assert.doesNotMatch(out, /DISPUTED/);
    // Default mode is unchanged.
    assert.match(await tool('curate_memory', { dry_run: true }), /## Memory Curation \(dry run/);

    assert.match(await tool('review_fact', { id, action: 'restore' }), /restored to active/);
    assert.match(await tool('review_fact', { id, action: 'verify', note: 'checked' }), /verified/);
    assert.match(await tool('review_fact', { id, action: 'retire' }), /retired/);
    assert.match(await tool('review_fact', { id, action: 'retire' }), /already retired/);
    assert.match(await tool('review_fact', { id: 99999, action: 'verify' }), /not found/);

    out = await tool('update_page', { slug: 'surf-rides', fields: { live: 'yes', repo: 'github.com/Danz0zn17/surf-rides' }, links: ['surf-rides-co'] });
    assert.match(out, /Page saved/);
    assert.match(out, /\*\*Live:\*\* yes/);
    assert.match(await tool('update_page', { slug: 'brand-new', fields: { live: 'no' } }), /Page not saved: new page needs kind/);
    assert.match(await tool('get_page', {}), /\*\*surf-rides\*\* \(product\)/);
    assert.match(await tool('get_page', { slug: 'surf-rides' }), /-> surf-rides-co \(no page yet\)/);
    assert.match(await tool('get_page', { slug: 'nope' }), /No page "nope"/);

    await tool('add_fact', { category: 'lead', content: 'Comics Food Bar wants a menu site', tags: 'role:growth' });
    out = await tool('get_context', { role: 'growth' });
    assert.match(out, /Growth start-up block/);
    assert.match(out, /Comics Food Bar wants a menu site/);
    assert.ok(out.split('\n').length <= 33, 'block plus the data notice');
    out = await tool('get_context', {});
    assert.match(out, /Session Context/);
    out = await tool('get_orientation', { project: 'surf-rides', role: 'engineer' });
    assert.match(out, /Engineer start-up block - surf-rides/);
    assert.match(await tool('get_orientation', { project: 'surf-rides' }), /Orientation Brief/);
    assert.match(await tool('get_context', { role: 'intern' }), /ERROR|Invalid|invalid/);
  } finally {
    if (mcp) await mcp.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
