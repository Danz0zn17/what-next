import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TEST_HOME = mkdtempSync(join(tmpdir(), 'wn-install-test-'));
process.env.HOME = TEST_HOME;

const { spliceCodexToml, parseTomlKey, backupFile, xmlEscape, buildPlist, buildSystemdUnit, systemdQuote } = await import('../bin/install.js');
const INSTALL = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'install.js');

const BLOCK = [
  '[mcp_servers.what-next]',
  'command = "/usr/bin/node"',
  'args = ["/x/bin/bootstrap-entry.js", "src/server.js", "mcp"]',
  '',
  '[mcp_servers.what-next.env]',
  'WHATNEXT_API_KEY = "bak_new"',
].join('\n');

test('importing the installer does not run it', () => {
  assert.equal(typeof spliceCodexToml, 'function');
  assert.deepEqual(readdirSync(TEST_HOME), []);
});

test('parseTomlKey handles bare, quoted and spaced dotted keys', () => {
  assert.deepEqual(parseTomlKey('mcp_servers.what-next.env'), ['mcp_servers', 'what-next', 'env']);
  assert.deepEqual(parseTomlKey(' mcp_servers . "what-next" '), ['mcp_servers', 'what-next']);
  assert.deepEqual(parseTomlKey("mcp_servers.'what-next'.env"), ['mcp_servers', 'what-next', 'env']);
  assert.equal(parseTomlKey('bad key'), null);
});

test('splice appends to a file without a what-next table', () => {
  assert.equal(spliceCodexToml('', BLOCK), BLOCK + '\n');
  const out = spliceCodexToml('model = "o3"\n\n[mcp_servers.other]\ncommand = "x"\n', BLOCK);
  assert.equal(out, 'model = "o3"\n\n[mcp_servers.other]\ncommand = "x"\n\n' + BLOCK + '\n');
});

test('splice replaces only the what-next table and subtables, keeping later sections in place', () => {
  const input = [
    'model = "o3"',
    '',
    '[mcp_servers.what-next]',
    'command = "/old/node"',
    'args = [',
    '"/old/entry.js",',
    '["nested"],',
    ']',
    '',
    '[mcp_servers.what-next.env]',
    'WHATNEXT_API_KEY = "bak_old"',
    'NOTE = """',
    '[not.a.header]',
    '"""',
    '',
    '# the other server',
    '[mcp_servers.other]',
    'command = "keep-me"',
    '',
    '[[profiles]]',
    'name = "a"',
    '',
    '[mcp_servers."what-next".env]',
    'STRAY = "1"',
    '',
    '[tui]',
    'theme = "dark"',
    '',
  ].join('\n');
  const out = spliceCodexToml(input, BLOCK);
  assert.equal(out, [
    'model = "o3"',
    '',
    BLOCK,
    '',
    '# the other server',
    '[mcp_servers.other]',
    'command = "keep-me"',
    '',
    '[[profiles]]',
    'name = "a"',
    '',
    '[tui]',
    'theme = "dark"',
    '',
  ].join('\n'));
  assert.ok(!out.includes('bak_old'));
  assert.ok(!out.includes('STRAY'));
  // Idempotent: a re-run gives the same file.
  assert.equal(spliceCodexToml(out, BLOCK), out);
});

test('splice ignores a similarly named server and keeps CRLF files CRLF', () => {
  const input = '[mcp_servers.what-next-dev]\r\ncommand = "dev"\r\n';
  const out = spliceCodexToml(input, BLOCK);
  assert.ok(out.startsWith('[mcp_servers.what-next-dev]\r\ncommand = "dev"\r\n\r\n[mcp_servers.what-next]'));
  assert.ok(out.endsWith('\r\n'));
});

test('backupFile writes a timestamped copy only when the file exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wn-bak-'));
  const file = join(dir, 'config.json');
  assert.equal(backupFile(file), null);
  writeFileSync(file, '{"a":1}');
  const now = new Date('2026-09-27T10:11:12.345Z');
  const first = backupFile(file, { now });
  assert.equal(first, join(dir, 'config.json.bak-20260927T101112Z'));
  assert.equal(readFileSync(first, 'utf8'), '{"a":1}');
  const second = backupFile(file, { now });
  assert.notEqual(second, first);
  const other = join(dir, 'elsewhere');
  assert.ok(backupFile(file, { now, backupDir: other }).startsWith(other));
});

test('plist escapes paths and key for XML', () => {
  assert.equal(xmlEscape(`a&b<c>"d'`), 'a&amp;b&lt;c&gt;&quot;d&apos;');
  const xml = buildPlist({ programArgs: ['/bin/zsh', '/Users/a&b/<x>/start-api.sh'], logsDir: '/L&', root: '/r&<', home: '/h', cloudUrl: 'https://c', key: 'bak_<&>' });
  assert.ok(xml.includes('<string>/Users/a&amp;b/&lt;x&gt;/start-api.sh</string>'));
  assert.ok(xml.includes('<string>/r&amp;&lt;</string>'));
  assert.ok(xml.includes('<string>bak_&lt;&amp;&gt;</string>'));
  assert.ok(xml.includes('<key>WHATNEXT_NODE</key>'), 'plist pins the installing node so native modules load');
  assert.ok(!/&(?!amp;|lt;|gt;|quot;|apos;)/.test(xml));
});

test('systemd unit runs local-api.js with the env and quotes paths', () => {
  const unit = buildSystemdUnit({ nodeExec: '/usr/bin/node', root: '/opt/what next', cloudUrl: 'https://c', key: 'bak_1%x' });
  assert.ok(unit.includes('ExecStart="/usr/bin/node" "/opt/what next/bin/local-api.js"'));
  assert.ok(unit.includes('Environment="WHATNEXT_API_KEY=bak_1%%x"'));
  assert.ok(unit.includes('Environment="WHATNEXT_PREFER_LOCAL=1"'));
  assert.ok(unit.includes('WantedBy=default.target'));
  assert.equal(systemdQuote('a"b\\c'), '"a\\"b\\\\c"');
  assert.throws(() => systemdQuote('a\nb'));
});

test('codex install end to end: backs up and splices the real file under a temp HOME', () => {
  const home = mkdtempSync(join(tmpdir(), 'wn-codex-home-'));
  const cfg = join(home, '.codex', 'config.toml');
  mkdirSync(dirname(cfg), { recursive: true });
  const original = '[mcp_servers.what-next]\ncommand = "old"\n\n[mcp_servers.what-next.env]\nWHATNEXT_API_KEY = "bak_old"\n\n[projects."/x"]\ntrust_level = "trusted"\n';
  writeFileSync(cfg, original);
  execFileSync(process.execPath, [INSTALL, '--client', 'codex', '--key', 'bak_new'], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    stdio: 'pipe',
  });
  const out = readFileSync(cfg, 'utf8');
  assert.ok(out.includes('WHATNEXT_API_KEY = "bak_new"'));
  assert.ok(!out.includes('bak_old'));
  assert.ok(out.trimEnd().endsWith('[projects."/x"]\ntrust_level = "trusted"'));
  const baks = readdirSync(dirname(cfg)).filter(f => f.startsWith('config.toml.bak-'));
  assert.equal(baks.length, 1);
  assert.equal(readFileSync(join(dirname(cfg), baks[0]), 'utf8'), original);
});
