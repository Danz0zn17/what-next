import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Boot the real MCP server over stdio and read tools/list, as a client would.
function listTools() {
  return new Promise((resolve, reject) => {
    const dir = mkdtempSync(join(tmpdir(), 'wn-tools-test-'));
    const p = spawn(process.execPath, ['src/server.js'], {
      env: { ...process.env, WHATNEXT_DATA_DIR: dir, HOME: dir, WHATNEXT_CLOUD_URL: '' },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let buf = '';
    const timer = setTimeout(() => { p.kill(); reject(new Error('timeout')); }, 60000);
    p.stdout.on('data', d => {
      buf += d;
      const lines = buf.split('\n'); buf = lines.pop();
      for (const l of lines) {
        if (!l.trim()) continue;
        const m = JSON.parse(l);
        if (m.id === 1) p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
        if (m.id === 2) { clearTimeout(timer); p.kill(); resolve(m.result.tools); }
      }
    });
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } }) + '\n');
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  });
}

test('every tool has a one-line description and the schema stays small', async () => {
  const tools = await listTools();
  assert.equal(tools.length, 14);
  for (const t of tools) {
    assert.ok(t.description && t.description.length > 20, `${t.name} has no description`);
    assert.ok(t.description.length < 400, `${t.name} description too long`);
  }
  const bytes = JSON.stringify(tools).length;
  assert.ok(bytes < 12_000, `tools/list is ${bytes} bytes; keep the schema tax small`);
});
