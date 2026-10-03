import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseSecretArgs, upsertEnv, envHas, formatEnvValue, guardCheck, addGuardHook, redact, manualCommand, WRITERS } from '../src/secret.js';

const WN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wn.js');
const bash = (command) => guardCheck({ tool_name: 'Bash', tool_input: { command } });
const tmpDirs = [];
const tmp = (prefix = 'wn-secret-test-') => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
};
test.after(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

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
  assert.equal(upsertEnv(src, 'B', 'new'), '# comment\nA=1\nexport B=new\nC=3');
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
  const dir = tmp();
  assert.equal(WRITERS.env('KEY', 'v1', { cwd: dir, envFile: '.env' }).ok, true);
  if (process.platform !== 'win32') assert.equal(statSync(join(dir, '.env')).mode & 0o777, 0o600);
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

test('guard ignores secret commands that only appear as data', () => {
  for (const cmd of [
    `echo '{"tool_name":"Bash","tool_input":{"command":"cat .env"}}' | node wn.js guard`,
    `git commit -m "docs: never run cat .env or printenv"`,
    `python3 - <<'EOF'\ns = "cat .env and plutil -p x.plist"\nEOF\necho done`,
    `cat > notes.md <<EOF\nrun printenv to debug\nEOF`,
  ]) assert.equal(bash(cmd), null, `should allow: ${cmd}`);
  for (const cmd of [
    `bash -c 'cat .env'`, `sh <<EOF\ncat .env\nEOF`, `cat "my app/.env"`, `echo "key is $STRIPE_SECRET_KEY"`,
    `python3 -c "print(open('.env').read())"`,
  ]) assert.ok(bash(cmd), `should block: ${cmd}`);
});

test('guard blocks AI tool configs only when they hold keys', () => {
  const dir = tmp('wn-guard-test-');
  writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ servers: { x: { env: { WHATNEXT_API_KEY: 'bak_' + 'a'.repeat(40) } } } }));
  writeFileSync(join(dir, 'claude_desktop_config.json'), JSON.stringify({ mcpServers: { x: { command: 'node', args: ['a.js'] } } }));
  const read = (file_path) => guardCheck({ tool_name: 'Read', cwd: dir, tool_input: { file_path } });
  const run = (command) => guardCheck({ tool_name: 'Bash', cwd: dir, tool_input: { command } });
  assert.ok(read(join(dir, 'mcp.json')));
  assert.equal(read(join(dir, 'claude_desktop_config.json')), null);
  assert.ok(run('cat mcp.json'));
  assert.ok(run(`jq . ${join(dir, 'mcp.json')}`));
  assert.equal(run('cat claude_desktop_config.json'), null);
  assert.equal(run('ls mcp.json'), null);
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
  const dir = tmp();
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

test('upsertEnv keeps $ patterns in values literal and keeps an export prefix', () => {
  for (const v of ["a$'b", 'a$&b', 'a$1b', "x$`y"]) {
    const out = upsertEnv('A=1\nK=old\nB=2\n', 'K', v);
    assert.equal(out, `A=1\nK=${formatEnvValue(v)}\nB=2\n`, v);
  }
  assert.equal(upsertEnv('export K=old\n', 'K', 'new'), 'export K=new\n');
  assert.equal(upsertEnv('export\tK = old\n', 'K', 'p$&q'), "export\tK='p$&q'\n");
});

test('formatEnvValue single-quotes values with $ so dotenv-expand leaves them alone', () => {
  assert.equal(formatEnvValue('pa$$word'), "'pa$$word'");
  assert.equal(formatEnvValue('a $HOME b'), "'a $HOME b'");
  assert.equal(formatEnvValue("it's $5"), JSON.stringify("it's $5"));
  assert.equal(formatEnvValue('plain'), 'plain');
});

test('parseSecretArgs defaults to a timeout under the Bash tool limit', () => {
  assert.equal(parseSecretArgs(['A']).timeout, 110);
  assert.equal(parseSecretArgs(['A', '--timeout', '300']).timeout, 300);
  assert.throws(() => parseSecretArgs(['A', '--timeout', 'soon']), /--timeout/);
});

test('env writer and --check accept an absolute --env-file', () => {
  const dir = tmp();
  const other = tmp();
  const file = join(other, '.env.prod');
  assert.equal(WRITERS.env('KEY', 'v$1', { cwd: dir, envFile: file }).ok, true);
  assert.equal(readFileSync(file, 'utf8'), "KEY='v$1'\n");
  const r = spawnSync(process.execPath, [WN, 'secret', 'KEY', '--check', '--cwd', dir, '--env-file', file], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /KEY: SET/);
});

test('manual fallback command uses double quotes on Windows', () => {
  const args = ['KEY', '--to', 'env', '--cwd', "C:\\My App"];
  assert.equal(manualCommand(args, 'win32'), 'wn secret KEY --to env --cwd "C:\\My App"');
  assert.equal(manualCommand(['KEY', '--cwd', '/my app'], 'linux'), "wn secret KEY --cwd '/my app'");
});

test('entry window still saves targets when the result folder is gone', () => {
  if (process.platform === 'win32') return;
  const dir = tmp();
  const script = `
    import { enterSecret } from ${JSON.stringify(new URL('../src/secret.js', import.meta.url).href)};
    process.stdin.isTTY = true;
    process.stdin.setRawMode = () => process.stdin;
    setTimeout(() => process.stdin.emit('data', 'abc123\\r'), 50);
    const r = await enterSecret({ name: 'KEY', to: ['env'], cwd: ${JSON.stringify(dir)}, envFile: '.env', result: ${JSON.stringify(join(dir, 'gone', 'r.json'))} });
    process.stdout.write('RESULT ' + JSON.stringify(r));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /"env":\{"ok":true/);
  assert.equal(readFileSync(join(dir, '.env'), 'utf8'), 'KEY=abc123\n');
});

test('entry window refuses a multi-line paste instead of saving the first line', () => {
  const dir = tmp();
  const script = `
    import { enterSecret } from ${JSON.stringify(new URL('../src/secret.js', import.meta.url).href)};
    process.stdin.isTTY = true;
    process.stdin.setRawMode = () => process.stdin;
    setTimeout(() => process.stdin.emit('data', 'line1\\nline2\\n'), 50);
    const r = await enterSecret({ name: 'KEY', to: ['env'], cwd: ${JSON.stringify(dir)}, envFile: '.env', result: ${JSON.stringify(join(dir, 'r.json'))} });
    process.stdout.write('RESULT ' + JSON.stringify(r));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Multi-line values are not supported/);
  const result = JSON.parse(readFileSync(join(dir, 'r.json'), 'utf8'));
  assert.equal(result.cancelled, true);
  assert.match(result.reason, /Multi-line/);
  assert.throws(() => statSync(join(dir, '.env')));
});

test('guard blocks the newer leak paths', () => {
  for (const cmd of [
    'cat .env*', 'cat .env.*', 'head app/.env*',
    'ls\nenv', 'cd app\n  printenv\n', 'export', 'ls && export', 'declare -p',
    `python3 - <<'EOF'\nprint(open('.env').read())\nEOF`,
    `node <<EOF\nconsole.log(process.env)\nEOF`,
    `ruby <<EOF\nputs File.read(".env")\nEOF`,
    'echo $DATABASE_URL', 'echo "$REDIS_URL"', 'printf %s "$MONGO_URI"', 'echo ${PG_CONN}', 'echo $SENTRY_DSN',
    "node -e 'console.log(process.env)'", 'node -e "console.log(JSON.stringify(process.env))"',
    'python3 -c "import os; print(os.environ)"', "python3 -c 'import os; print(dict(os.environ))'",
    'docker compose config', 'docker-compose -f a.yml config', 'supabase projects api-keys --project-ref x',
    'cat .envrc', 'cat .dev.vars', 'cat ~/.aws/credentials', 'cat ~/.netrc', 'tail ~/.pgpass',
    'grep STRIPE .env', 'grep -e KEY .env.local', 'rg -n KEY .env', 'cat foo .env > out.txt',
    'echo $(cat .env)',
  ]) assert.ok(bash(cmd), `should block: ${JSON.stringify(cmd)}`);
});

test('guard allows commands that only name a .env file or check presence', () => {
  for (const cmd of [
    'node --env-file=.env x.js', 'docker run --env-file .env app | tail -20', 'docker compose --env-file .env up',
    'grep -qxF .env .gitignore || echo .env >> .gitignore', 'grep -nE ".env|node_modules" .gitignore',
    "grep -q '^.env$' .gitignore", 'rg -n ".env" .gitignore', 'cat .gitignore | grep .env',
    'echo "set: ${STRIPE_KEY:+yes}"', '[ -n "${STRIPE_KEY:-}" ] && echo SET || echo MISSING', 'echo "len ${#STRIPE_KEY}"',
    'printenv PATH', 'printenv HOME SHELL', 'printenv NODE_ENV',
    'echo $PATH', 'echo $HOME $PWD $SHELL $NODE_ENV $CI',
    'cp .env.example .env', 'touch .env', 'chmod 600 .env', 'ls -la .env', 'git check-ignore .env', 'rm .env.test',
    'touch .env && cat package.json', 'cat > .env <<EOF\nA=1\nEOF', 'echo "A=1" >> .env',
    'docker compose config --services', 'grep -r environment src/', 'cat ~/.npmrc.bak.txt',
    'node -e "console.log(process.env.NODE_ENV)"', 'python3 -c "import os; print(os.environ.get(\'HOME\'))"',
    'cat > run.sh <<EOF\ncat .env\nEOF',
  ]) assert.equal(bash(cmd), null, `should allow: ${JSON.stringify(cmd)}`);
});

test('guard blocks .npmrc only when it holds an auth token', () => {
  const withToken = tmp();
  const clean = tmp();
  writeFileSync(join(withToken, '.npmrc'), '//registry.npmjs.org/:_authToken=npm_' + 'a'.repeat(36) + '\n');
  writeFileSync(join(clean, '.npmrc'), 'save-exact=true\n');
  const run = (cwd, command) => guardCheck({ tool_name: 'Bash', cwd, tool_input: { command } });
  const read = (file_path) => guardCheck({ tool_name: 'Read', tool_input: { file_path } });
  assert.ok(run(withToken, 'cat .npmrc'));
  assert.ok(run(clean, `cat ${join(withToken, '.npmrc')}`));
  assert.equal(run(clean, 'cat .npmrc'), null);
  assert.ok(read(join(withToken, '.npmrc')));
  assert.equal(read(join(clean, '.npmrc')), null);
});

test('guard blocks credential and env files with the Read and Grep tools', () => {
  const tool = (tool_name, tool_input) => guardCheck({ tool_name, tool_input });
  for (const p of ['/u/.aws/credentials', '/u/.netrc', '/u/.pgpass', '/p/.envrc', '/p/.dev.vars']) assert.ok(tool('Read', { file_path: p }), p);
  assert.ok(tool('Grep', { pattern: 'KEY', glob: '**/.env*' }));
  assert.ok(tool('Grep', { pattern: 'KEY', glob: '.env.local' }));
  assert.ok(tool('Grep', { pattern: 'KEY', glob: '{.env,.envrc}' }));
  assert.equal(tool('Grep', { pattern: 'KEY', glob: '**/.env.example' }), null);
  assert.equal(tool('Grep', { pattern: 'KEY', glob: '**/*.ts' }), null);
  assert.equal(tool('Read', { file_path: '/p/.aws/config' }), null);
  assert.equal(tool('NotebookRead', { notebook_path: '/p/.env' }), null);
});

test('addGuardHook updates only its own hook and keeps the user hooks in that entry', () => {
  const user = { type: 'command', command: 'my-audit.sh' };
  const settings = { hooks: { PreToolUse: [
    { matcher: 'Bash|Read|Grep', hooks: [user, { type: 'command', command: '"/n" "/old/bin/wn.js" guard', timeout: 5 }] },
  ] } };
  addGuardHook(settings, '"/n" "/new/bin/wn.js" guard');
  assert.equal(settings.hooks.PreToolUse.length, 1);
  assert.deepEqual(settings.hooks.PreToolUse[0].hooks, [user, { type: 'command', command: '"/n" "/new/bin/wn.js" guard', timeout: 5 }]);

  // A shared entry with another matcher keeps its matcher and the user's hook; ours moves to its own entry
  const shared = { hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [user, { type: 'command', command: 'wn guard' }] }] } };
  addGuardHook(shared, 'wn guard');
  assert.deepEqual(shared.hooks.PreToolUse[0], { matcher: 'Edit', hooks: [user] });
  assert.deepEqual(shared.hooks.PreToolUse[1], { matcher: 'Bash|Read|Grep', hooks: [{ type: 'command', command: 'wn guard', timeout: 5 }] });
  addGuardHook(shared, 'wn guard');
  assert.equal(shared.hooks.PreToolUse.length, 2);

  // An entry that held only an old guard hook is updated in place, matcher included
  const solo = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'wn guard' }] }] } };
  addGuardHook(solo, 'wn guard');
  assert.deepEqual(solo.hooks.PreToolUse, [{ matcher: 'Bash|Read|Grep', hooks: [{ type: 'command', command: 'wn guard', timeout: 5 }] }]);
});
