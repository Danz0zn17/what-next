/**
 * REST API and MCP fixes: CSRF from other localhost ports, the ChatGPT dump
 * parser, /ingest size, /orientation per project, card refresh after session
 * edits, Unicode import slugs and re-import dedupe, project-name validation,
 * malformed paths and limits.
 *
 * Starts src/api-server.js (and src/server.js for the MCP checks) with a
 * throwaway HOME and data dir on a free port, so it never touches the real
 * instance on 3747 or ~/.whatnext.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

// The parser and slug helpers are imported in-process; point their DB at a
// temp dir of their own before anything loads db.js.
const UNIT_HOME = mkdtempSync(join(tmpdir(), 'wn-api-fixes-unit-'));
process.env.WHATNEXT_DATA_DIR = join(UNIT_HOME, 'data');
process.env.HOME = UNIT_HOME;
process.env.USERPROFILE = UNIT_HOME;
process.env.WHATNEXT_CLOUD_URL = '';
const { parseAgentDump, titleToProject } = await import('../src/api.js');
const { cardFileName } = await import('../src/sidecar.js');

let dir, port, child;

function freePort() {
  return new Promise((ok, fail) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port: p } = srv.address();
      srv.close(() => ok(p));
    });
    srv.on('error', fail);
  });
}

function call(method, path, { headers = {}, body } = {}) {
  return new Promise((ok, fail) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: { Host: `localhost:${port}`, ...headers } }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch {}
        ok({ status: res.statusCode, headers: res.headers, text: raw, json });
      });
    });
    req.on('error', fail);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const json = { 'Content-Type': 'application/json' };
const post = (path, data, headers = {}) => call('POST', path, { headers: { ...json, ...headers }, body: JSON.stringify(data) });
const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fn();
};
const cardPath = (home, project) => join(home, '.whatnext', 'agents', cardFileName(project));

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wn-api-fixes-'));
  port = await freePort();
  child = spawn(process.execPath, [join(ROOT, 'src', 'api-server.js')], {
    cwd: dir,
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      USERPROFILE: dir,
      WHATNEXT_DATA_DIR: join(dir, 'data'),
      WHATNEXT_PORT: String(port),
      WHATNEXT_PROJECTS_DIR: join(dir, 'p'),
      WHATNEXT_CLOUD_URL: 'http://127.0.0.1:9',
      WHATNEXT_CURATOR: '0',
      WHATNEXT_UPDATE_CHECK: '0',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  for (let i = 0; i < 100; i++) {
    try {
      const r = await call('GET', '/health');
      if (r.status === 200) return;
    } catch {}
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
  // This process still holds UNIT_HOME's SQLite file open, and Windows cannot
  // delete an open file: cleanup is best-effort there.
  for (const d of [dir, UNIT_HOME]) {
    try { if (d) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (e) { if (process.platform !== 'win32') throw e; }
  }
});

// ── 1. CSRF ──────────────────────────────────────────────────────────────────
test('writes from another localhost port are rejected', async () => {
  for (const origin of ['http://localhost:5173', 'http://127.0.0.1:3000', 'http://[::1]:8080', 'http://localhost', 'null']) {
    const r = await post('/fact', { category: 'general', content: 'csrf' }, { Origin: origin });
    assert.equal(r.status, 403, origin);
  }
  const pre = await call('OPTIONS', '/fact', { headers: { Origin: 'http://localhost:5173' } });
  assert.equal(pre.headers['access-control-allow-origin'], 'null');
});

test('writes from the API own origin and with no Origin still work', async () => {
  for (const origin of [`http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`, undefined]) {
    const r = await post('/fact', { category: 'general', content: `ok ${origin}` }, origin ? { Origin: origin } : {});
    assert.equal(r.status, 201, String(origin));
  }
});

// ── 3. Dump parser ───────────────────────────────────────────────────────────
test('parser takes the last dump block', () => {
  const raw = [
    '---WHAT NEXT DUMP---', 'PROJECT: old', 'SUMMARY: first', '---END DUMP---',
    'more chat',
    '---WHAT NEXT DUMP---', 'PROJECT: new-proj', 'SUMMARY: second', '---END DUMP---',
  ].join('\n');
  const d = parseAgentDump(raw);
  assert.equal(d.project, 'new-proj');
  assert.equal(d.summary, 'second');
});

test('parser keeps multi-line values and only splits on line-start keys', () => {
  const raw = [
    '---WHAT NEXT DUMP---',
    'PROJECT: shop',
    'SUMMARY: Fixed checkout.',
    'Stripe webhooks now verify signatures.',
    'The NEXT: bit mid-line is not a key.',
    'BUILT: webhook.ts',
    'DECISIONS: Keep retries',
    'NEXT: ship it',
    'TAGS: stripe,api',
    '---END DUMP---',
  ].join('\n');
  const d = parseAgentDump(raw);
  assert.equal(d.summary, 'Fixed checkout.\nStripe webhooks now verify signatures.\nThe NEXT: bit mid-line is not a key.');
  assert.equal(d.what_was_built, 'webhook.ts');
  assert.equal(d.decisions, 'Keep retries');
  assert.equal(d.next_steps, 'ship it');
  assert.equal(d.tags, 'stripe,api');
  assert.equal(d.stack, undefined);
  assert.equal(parseAgentDump('no block here'), null);
  assert.equal(parseAgentDump('---WHAT NEXT DUMP---\nSUMMARY: no project\n---END DUMP---'), null);
});

test('/ingest accepts a long chat over 64KB and stores the last block', async () => {
  const filler = 'USER: hi\n\nAI: ' + 'x'.repeat(100 * 1024) + '\n\n';
  const raw = filler + '---WHAT NEXT DUMP---\nPROJECT: stale\nSUMMARY: old\n---END DUMP---\n' + filler +
    '---WHAT NEXT DUMP---\nPROJECT: ingest-big\nSUMMARY: line one\nline two\n---END DUMP---';
  const r = await post('/ingest', { raw }, { Origin: 'https://chatgpt.com' });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.project, 'ingest-big');
  const p = await call('GET', '/project/ingest-big');
  assert.equal(p.json.sessions[0].summary, 'line one\nline two');
});

// ── 4. Orientation ───────────────────────────────────────────────────────────
test('/orientation finds sessions and next steps outside the last 20 global sessions', async () => {
  await post('/session', { project: 'orient-old', summary: 'old work', next_steps: 'finish the migration' });
  await post('/session', { project: 'orient-old', summary: 'newer work, no next steps' });
  for (let i = 0; i < 25; i++) await post('/session', { project: 'orient-busy', summary: `busy ${i}`, next_steps: `step ${i}` });
  const r = await call('GET', '/orientation/orient-old');
  assert.equal(r.status, 200);
  assert.equal(r.json.recent_sessions.length, 2);
  assert.ok(r.json.recent_sessions.every((s) => s.project_name === 'orient-old'));
  assert.equal(r.json.next_steps, 'finish the migration');
});

// ── 5. Edit refreshes the card ───────────────────────────────────────────────
test('PATCH /session refreshes the project card and global context', async () => {
  const created = await post('/session', { project: 'edit-card', summary: 'original summary text' });
  const card = cardPath(dir, 'edit-card');
  assert.ok(await until(() => existsSync(card) && readFileSync(card, 'utf8').includes('original summary text')), 'card written');
  const global = join(dir, '.whatnext', 'context.md');
  await until(() => existsSync(global));
  await new Promise((r) => setTimeout(r, 300)); // let the POST's own write land first
  const before = statSync(global).mtimeMs;
  const r = await call('PATCH', `/session/${created.json.id}`, { headers: json, body: JSON.stringify({ summary: 'edited summary text' }) });
  assert.equal(r.status, 200);
  assert.ok(await until(() => readFileSync(card, 'utf8').includes('edited summary text')), 'card refreshed after edit');
  assert.ok(await until(() => statSync(global).mtimeMs > before), 'global context rewritten after edit');
});

// ── 7. Import slugs + dedupe ─────────────────────────────────────────────────
test('titleToProject keeps non-Latin titles and falls back to chatgpt-import', () => {
  assert.equal(titleToProject('Привет мир'), 'привет-мир');
  assert.equal(titleToProject('データベース 設計'), 'データベース-設計');
  assert.equal(titleToProject('Hello, World!'), 'hello-world');
  assert.equal(titleToProject('!!! ???'), 'chatgpt-import');
  assert.equal(titleToProject(undefined), 'chatgpt-import');
  assert.ok([...titleToProject('ä'.repeat(80))].length <= 50);
});

function convo(id, title, words = 150) {
  const text = Array.from({ length: words }, (_, i) => `word${i}`).join(' ');
  return {
    id, title, create_time: 1700000000,
    mapping: {
      a: { message: { author: { role: 'user' }, content: { parts: ['How do I build this?'] }, create_time: 1 } },
      b: { message: { author: { role: 'assistant' }, content: { parts: [text] }, create_time: 2 } },
    },
  };
}

test('/import uses Unicode slugs and a re-import skips existing conversations', async () => {
  const body = JSON.stringify([convo('c-1', 'Привет мир'), convo('c-2', '!!!'), convo('c-3', 'short', 5)]);
  const first = await call('POST', '/import', { headers: json, body });
  assert.equal(first.status, 200, first.text);
  assert.equal(first.json.imported, 2);
  assert.equal(first.json.skipped, 1);
  const again = await call('POST', '/import', { headers: json, body });
  assert.equal(again.json.imported, 0);
  assert.equal(again.json.duplicates, 2);
  const projects = (await call('GET', '/projects')).json.map((p) => p.name);
  assert.ok(projects.includes('привет-мир'));
  assert.ok(projects.includes('chatgpt-import'));
  assert.ok(!projects.includes(''));
  const p = await call('GET', `/project/${encodeURIComponent('привет-мир')}`);
  assert.equal(p.json.sessions.length, 1);
});

// ── 9. Project validation ────────────────────────────────────────────────────
test('REST writes validate the project name like the MCP schema', async () => {
  const bad = ['../etc', 'a/b', 'a\\b', 'x'.repeat(101), 123, ['a']];
  for (const project of bad) {
    assert.equal((await post('/session', { project, summary: 's' })).status, 400, `session ${JSON.stringify(project)}`);
    assert.equal((await post('/fact', { project, category: 'c', content: 'x' })).status, 400, `fact ${JSON.stringify(project)}`);
    assert.equal((await post('/intelligence', { project, stack: 'x' })).status, 400, `intel ${JSON.stringify(project)}`);
  }
  assert.equal((await post('/session', { project: 'ok-name', summary: { not: 'text' } })).status, 400);
  assert.equal((await post('/fact', { category: 'c', content: 'global fact' })).status, 201, 'project stays optional on facts');
  assert.equal((await post('/intelligence', { project: 'ok-name', stack: 'node' })).status, 200);
});

// ── 10. Paths, limits, pages ─────────────────────────────────────────────────
test('malformed percent-encoding in project paths is a 400', async () => {
  for (const path of ['/project/%E0%A4%A', '/intelligence/%ZZ', '/orientation/%']) {
    const r = await call('GET', path);
    assert.equal(r.status, 400, path);
  }
});

test('/flagged clamps its limit', async () => {
  for (const q of ['-1', '0', 'abc', '100000']) {
    const r = await call('GET', `/flagged?limit=${q}`);
    assert.equal(r.status, 200, q);
  }
});

test('bookmarklet uses the configured port and sends only the dump block', async () => {
  const r = await call('GET', '/setup');
  assert.ok(r.text.includes(`http://localhost:${port}/ingest`));
  assert.ok(!r.text.includes('localhost:3747'));
  assert.match(r.text, /lastIndexOf\('---WHAT NEXT DUMP---'\)/);
  const imp = await call('GET', '/import');
  assert.ok(imp.text.includes('href="/#projects"'));
});

test('POST /curate refuses a second concurrent run', async () => {
  const [a, b] = await Promise.all([post('/curate', { dry_run: true }), post('/curate', { dry_run: true })]);
  const statuses = [a.status, b.status].sort();
  assert.ok(statuses[0] === 200, `got ${statuses}`);
  assert.ok(statuses[1] === 200 || statuses[1] === 409, `got ${statuses}`);
  assert.equal((await post('/curate', { dry_run: true })).status, 200, 'lock released after a run');
});

// ── MCP: edit_session refresh, limits, curate output ─────────────────────────
function mcpSession(home) {
  const p = spawn(process.execPath, [join(ROOT, 'src', 'server.js')], {
    cwd: home,
    env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, WHATNEXT_DATA_DIR: join(home, 'data'), WHATNEXT_CLOUD_URL: '', WHATNEXT_AUDIT_LOG_DIR: join(home, 'logs'), WHATNEXT_PROJECTS_DIR: join(home, 'p') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '';
  let stderr = '';
  p.stderr.on('data', (d) => { stderr += d; });
  const exited = new Promise((_, fail) => p.once('exit', (code) => fail(Object.assign(new Error(`MCP server exited (${code})`), { stderr }))));
  exited.catch(() => {});
  let nextId = 1;
  const waiting = new Map();
  p.stdout.on('data', (d) => {
    buf += d;
    const lines = buf.split('\n'); buf = lines.pop();
    for (const l of lines) {
      if (!l.trim()) continue;
      const m = JSON.parse(l);
      waiting.get(m.id)?.(m);
    }
  });
  const rpc = (method, params) => new Promise((ok, fail) => {
    const id = nextId++;
    const t = setTimeout(() => fail(new Error(`${method} timed out`)), 30000);
    waiting.set(id, (m) => { clearTimeout(t); ok(m); });
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const tool = async (name, args) => (await rpc('tools/call', { name, arguments: args }));
  const ready = Promise.race([exited, (async () => {
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  })()]);
  const close = async () => {
    if (p.exitCode === null && p.signalCode === null) {
      const exited = new Promise((r) => p.once('exit', r));
      p.kill('SIGKILL');
      await exited;
    }
  };
  return { ready, tool, close };
}

test('MCP edit_session refreshes the card; limits and curate output are guarded', { timeout: 200_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'wn-api-fixes-mcp-'));
  let mcp;
  try {
    // bootstrap-selfheal.test.js briefly breaks the shared node_modules; when
    // the suite runs in parallel, retry until its npm install has healed it.
    for (const deadline = Date.now() + 150_000; ;) {
      mcp = mcpSession(home);
      try {
        await mcp.ready;
        break;
      } catch (e) {
        await mcp.close();
        if (!/ERR_MODULE_NOT_FOUND|Cannot find (module|package)/.test(e.stderr ?? '') || Date.now() > deadline) throw e;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    const dumped = await mcp.tool('dump_session', { project: 'mcp-edit', summary: 'before the edit' });
    const id = Number(dumped.result.content[0].text.match(/local id: (\d+)/)[1]);
    const card = cardPath(home, 'mcp-edit');
    assert.ok(await until(() => existsSync(card) && readFileSync(card, 'utf8').includes('before the edit')), 'card written');
    await mcp.tool('edit_session', { id, summary: 'after the edit' });
    assert.ok(await until(() => readFileSync(card, 'utf8').includes('after the edit')), 'card refreshed after edit');

    for (const [name, args] of [['search_memories', { query: 'edit', limit: 0 }], ['whats_next', { limit: -1 }], ['semantic_search', { query: 'x', limit: 100000 }]]) {
      const r = await mcp.tool(name, args);
      const failed = r.error || r.result?.isError;
      assert.ok(failed, `${name} accepted ${JSON.stringify(args)}`);
    }

    const cur = await mcp.tool('curate_memory', { dry_run: true });
    assert.match(cur.result.content[0].text, /^_Recalled memory below/);
  } finally {
    await mcp?.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
