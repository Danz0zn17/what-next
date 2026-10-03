import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseSecretArgs, upsertEnv, envHas, formatEnvValue, guardCheck, addGuardHook, redact, WRITERS } from '../src/secret.js';

const WN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wn.js');
const bash = (command) => guardCheck({ tool_name: 'Bash', tool_input: { command } });

test('parseSecretArgs reads name, targets and options', () => {
  const o = parseSecretArgs(['STRIPE_KEY', '--to', 'env,Netlify', '--url', 'https://x.test', '--env-file', '.env.local']);
  assert.equal(o.name, 'STRIPE_KEY');
  assert.deepEqual(o.to, ['env', 'netlify']);
  assert.equal(o.url, 'https://x.test');
  assert.equal(o.envFile, '.env.local');
  assert.deepEqual(parseSecretArgs(['A']).to, ['env']);
});

test('parseSecretArgs rejects bad names and targets', () => {
  assert.throws(() => parseSecretArgs([]), /variable name/);
  assert.throws(() => parseSecretArgs(['1BAD']), /variable name/);
  assert.throws(() => parseSecretArgs(['A', '--to', 'dropbox']), /Unknown target/);
  assert.throws(() => parseSecretArgs(['A', '--nope']), /Unknown option/);
});

test('upsertEnv replaces an existing line and keeps the rest', () => {
  const src = '# comment\nA=1\nexport B=old\nC=3';
  assert.equal(upsertEnv(src, 'B', 'new'), '# comment\nA=1\nB=new\nC=3');
  assert.equal(upsertEnv(src, 'D', 'x'), '# comment\nA=1\nexport B=old\nC=3\nD=x\n');
  assert.equal(upsertEnv('', 'A', 'x'), 'A=x\n');
  assert.equal(upsertEnv('AB=1\n', 'A', 'x'), 'AB=1\nA=x\n');
});

test('formatEnvValue quotes values dotenv would misread', () => {
  assert.equal(formatEnvValue('sk_live_abc-123/+='), 'sk_live_abc-123/+=');
  assert.equal(formatEnvValue('has space'), '"has space"');
  assert.equal(formatEnvValue('a#b"c'), '"a#b\\"c"');
});

test('envHas reports presence without the value', () => {
  assert.equal(envHas('A=1\nB=\nC=""\nexport D=x', 'A'), true);
  assert.equal(envHas('A=1\nB=\nC=""', 'B'), false);
  assert.equal(envHas('A=1\nB=\nC=""', 'C'), false);
  assert.equal(envHas('export D=x', 'D'), true);
  assert.equal(envHas('A=1', 'Z'), false);
});

test('redact hides the value in error text', () => {
  assert.equal(redact('failed to set sk_123 here', 'sk_123'), 'failed to set [hidden] here');
  assert.equal(redact('ok', ''), 'ok');
});

test('env writer creates a private file and updates in place', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wn-secret-test-'));
  assert.equal(WRITERS.env('KEY', 'v1', { cwd: dir, envFile: '.env' }).ok, true);
  assert.equal(statSync(join(dir, '.env')).mode & 0o777, 0o600);
  WRITERS.env('KEY', 'v2', { cwd: dir, envFile: '.env' });
  assert.equal(readFileSync(join(dir, '.env'), 'utf8'), 'KEY=v2\n');
});

test('guard blocks commands that print secrets', () => {
  for (const cmd of [
    'cat .env', 'cat .env.local', 'head -5 app/.env', 'grep STRIPE .env', 'less "./.env.production"',
    'env', 'env | grep KEY', 'printenv', 'printenv STRIPE_KEY', 'export -p', 'set',
    'railway variables', 'railway variables -s api', 'railway variable list --kv', 'railway variables --json',
    'netlify env:list', 'netlify env:get STRIPE_KEY',
    'echo $STRIPE_SECRET_KEY', 'echo "${OPENAI_API_KEY}"', 'printf %s $DB_PASSWORD',
    'security find-generic-password -s x -w',
    'plutil -p ~/Library/LaunchAgents/com.x.plist', 'cat ~/Library/LaunchAgents/com.x.plist', 'launchctl print gui/501/com.x',
  ]) assert.ok(bash(cmd), `should block: ${cmd}`);
});

test('guard allows normal work and safe secret handling', () => {
  for (const cmd of [
    'ls -la', 'cat .env.example', 'cp .env.example .env', 'git check-ignore .env', 'rm .env.test',
    'env FOO=1 node app.js', 'set -euo pipefail', 'npm run build', 'echo $HOME',
    '[ -n "$STRIPE_KEY" ] && echo SET || echo MISSING',
    'railway variables --set FOO=bar', 'railway variable set FOO --stdin', 'netlify env:set FOO bar',
    'wn secret STRIPE_KEY --to env,netlify', 'wn secret STRIPE_KEY --check --env-file .env.local',
    'grep -r environment src/', 'launchctl print gui/501/com.x | grep state', 'plutil -lint a.plist',
  ]) assert.equal(bash(cmd), null, `should allow: ${cmd}`);
});

test('guard blocks reading .env and key files with file tools', () => {
  assert.ok(guardCheck({ tool_name: 'Read', tool_input: { file_path: '/p/.env' } }));
  assert.ok(guardCheck({ tool_name: 'Read', tool_input: { file_path: '/p/.env.local' } }));
  assert.ok(guardCheck({ tool_name: 'Read', tool_input: { file_path: '/p/server.key' } }));
  assert.ok(guardCheck({ tool_name: 'Grep', tool_input: { pattern: 'KEY', path: '/p/.env' } }));
  assert.equal(guardCheck({ tool_name: 'Read', tool_input: { file_path: '/p/.env.example' } }), null);
  assert.equal(guardCheck({ tool_name: 'Read', tool_input: { file_path: '/p/src/env.ts' } }), null);
  assert.equal(guardCheck({ tool_name: 'Write', tool_input: { file_path: '/p/.env' } }), null);
});

test('wn guard exits 2 with a reason when blocking, 0 otherwise', () => {
  const block = spawnSync(process.execPath, [WN, 'guard'], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'cat .env' } }), encoding: 'utf8' });
  assert.equal(block.status, 2);
  assert.match(block.stderr, /wn secret NAME/);
  const allow = spawnSync(process.execPath, [WN, 'guard'], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }), encoding: 'utf8' });
  assert.equal(allow.status, 0);
  const junk = spawnSync(process.execPath, [WN, 'guard'], { input: 'not json', encoding: 'utf8' });
  assert.equal(junk.status, 0);
});

test('wn secret --check reports SET or MISSING only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wn-secret-test-'));
  writeFileSync(join(dir, '.env'), 'KEY=supersecretvalue\n');
  const set = spawnSync(process.execPath, [WN, 'secret', 'KEY', '--check', '--cwd', dir], { encoding: 'utf8' });
  assert.equal(set.status, 0);
  assert.match(set.stdout, /KEY: SET/);
  assert.doesNotMatch(set.stdout, /supersecretvalue/);
  const missing = spawnSync(process.execPath, [WN, 'secret', 'OTHER', '--check', '--cwd', dir], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /OTHER: MISSING/);
});

test('addGuardHook adds once and keeps other hooks', () => {
  const settings = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'other.sh' }] }] } };
  const cmd = '"/usr/bin/node" "/x/bin/wn.js" guard';
  addGuardHook(settings, cmd);
  addGuardHook(settings, cmd.replace('/x/', '/y/'));
  assert.equal(settings.hooks.PreToolUse.length, 2);
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, 'other.sh');
  assert.equal(settings.hooks.PreToolUse[1].hooks[0].command, '"/usr/bin/node" "/y/bin/wn.js" guard');
  assert.deepEqual(addGuardHook({}, cmd).hooks.PreToolUse[0].matcher, 'Bash|Read|Grep');
});
