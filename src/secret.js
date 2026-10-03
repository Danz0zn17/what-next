/**
 * Secret entry and secret guard.
 *
 * `wn secret NAME --to env,netlify` opens a separate terminal window where the
 * user types the value with hidden input. The value goes straight to its
 * destinations and never passes through the AI agent that ran the command:
 * the agent only sees "NAME: SET (env, netlify)".
 *
 * `wn guard` is a Claude Code PreToolUse hook that blocks commands and file
 * reads that would print secret values into the agent's context.
 */

import { spawnSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync, chmodSync } from 'fs';
import { tmpdir, userInfo } from 'os';
import { join, basename } from 'path';

export const TARGETS = ['env', 'netlify', 'railway', 'vercel', 'supabase', 'github', 'keychain'];
export const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ─── Arguments ────────────────────────────────────────────────────────────────

export function parseSecretArgs(argv) {
  const opts = { name: null, to: ['env'], url: null, envFile: '.env', cwd: process.cwd(), here: false, check: false, result: null, timeout: 600 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--to') opts.to = String(next() ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    else if (a === '--url') opts.url = next();
    else if (a === '--env-file') opts.envFile = next();
    else if (a === '--cwd') opts.cwd = next();
    else if (a === '--result') opts.result = next();
    else if (a === '--timeout') opts.timeout = Number(next());
    else if (a === '--here') opts.here = true;
    else if (a === '--check') opts.check = true;
    else if (!a.startsWith('-') && !opts.name) opts.name = a;
    else throw new Error(`Unknown option: ${a}`);
  }
  if (!opts.name || !NAME_RE.test(opts.name)) throw new Error('Give a variable name, e.g. wn secret STRIPE_SECRET_KEY');
  const bad = opts.to.filter(t => !TARGETS.includes(t));
  if (bad.length) throw new Error(`Unknown target: ${bad.join(', ')} (choose from ${TARGETS.join(', ')})`);
  if (!opts.to.length) throw new Error('--to needs at least one target');
  return opts;
}

// ─── .env handling ────────────────────────────────────────────────────────────

export function formatEnvValue(value) {
  return /^[A-Za-z0-9_\-./+=:@,]*$/.test(value) ? value : JSON.stringify(value);
}

/** Set or replace NAME in dotenv content, keeping every other line as is. */
export function upsertEnv(content, name, value) {
  const line = `${name}=${formatEnvValue(value)}`;
  const re = new RegExp(`^(export[ \\t]+)?${name}[ \\t]*=.*$`, 'm');
  if (re.test(content)) return content.replace(re, line);
  if (content && !content.endsWith('\n')) content += '\n';
  return content + line + '\n';
}

/** True when NAME has a non-empty value in dotenv content. Never returns the value. */
export function envHas(content, name) {
  const m = content.match(new RegExp(`^(?:export[ \\t]+)?${name}[ \\t]*=[ \\t]*(.*)$`, 'm'));
  if (!m) return false;
  const v = m[1].trim().replace(/^(['"])(.*)\1$/, '$2');
  return v.length > 0;
}

// ─── Writers (one per target) ─────────────────────────────────────────────────

function run(cmd, args, { cwd, input } = {}) {
  const r = spawnSync(cmd, args, { cwd, input, encoding: 'utf8', stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  if (r.error) return { ok: false, error: r.error.code === 'ENOENT' ? `${cmd} CLI not installed` : r.error.message };
  if (r.status !== 0) return { ok: false, error: (r.stderr || r.stdout || `exit ${r.status}`).trim().split('\n').slice(-3).join(' ') };
  return { ok: true };
}

function writeEnv(name, value, { cwd, envFile }) {
  const path = join(cwd, envFile);
  const isNew = !existsSync(path);
  writeFileSync(path, upsertEnv(isNew ? '' : readFileSync(path, 'utf8'), name, value));
  if (isNew) chmodSync(path, 0o600);
  const ignored = spawnSync('git', ['check-ignore', '-q', envFile], { cwd }).status === 0;
  const inRepo = spawnSync('git', ['rev-parse', '--git-dir'], { cwd, stdio: 'ignore' }).status === 0;
  return { ok: true, warning: inRepo && !ignored ? `${envFile} is not gitignored` : null };
}

function writeSupabase(name, value, { cwd }) {
  const dir = mkdtempSync(join(tmpdir(), 'wn-secret-'));
  const file = join(dir, '.env');
  try {
    writeFileSync(file, `${name}=${formatEnvValue(value)}\n`, { mode: 0o600 });
    return run('supabase', ['secrets', 'set', '--env-file', file], { cwd });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const WRITERS = {
  env: writeEnv,
  netlify: (name, value, { cwd }) => run('netlify', ['env:set', name, value, '--secret'], { cwd }),
  railway: (name, value, { cwd }) => run('railway', ['variable', 'set', name, '--stdin'], { cwd, input: value }),
  vercel: (name, value, { cwd }) => run('vercel', ['env', 'add', name, 'production'], { cwd, input: value }),
  supabase: writeSupabase,
  github: (name, value, { cwd }) => run('gh', ['secret', 'set', name], { cwd, input: value }),
  keychain: (name, value) => process.platform === 'darwin'
    ? run('security', ['add-generic-password', '-U', '-a', userInfo().username, '-s', name, '-w', value])
    : { ok: false, error: 'keychain target is macOS only' },
};

/** Remove any copy of the value from error text before it leaves this process. */
export function redact(text, value) {
  return value && text ? text.split(value).join('[hidden]') : text;
}

// ─── Hidden input ─────────────────────────────────────────────────────────────

export function readHidden(question) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) return reject(new Error('Needs an interactive terminal'));
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const done = (err) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stdout.write('\n');
      err ? reject(err) : resolve(value);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u0003') return done(new Error('Cancelled'));
        if (ch === '\u007f' || ch === '\b') {
          if (value.length) { value = value.slice(0, -1); process.stdout.write('\b \b'); }
        } else if (ch >= ' ') {
          value += ch;
          process.stdout.write('*');
        }
      }
    };
    stdin.on('data', onData);
  });
}

// ─── Entry window (runs in the user's terminal) ───────────────────────────────

export async function enterSecret(opts) {
  const result = { name: opts.name, targets: {}, cancelled: false };
  const save = () => opts.result && writeFileSync(opts.result, JSON.stringify(result));
  console.log(`\n  What Next - secret entry\n`);
  console.log(`  Variable:  ${opts.name}`);
  console.log(`  Saving to: ${opts.to.join(', ')}  (in ${opts.cwd})`);
  if (opts.url) console.log(`  Get it at: ${opts.url}`);
  console.log(`\n  Paste the value and press Enter. Nothing is shown and nothing reaches the AI chat.\n`);
  let value;
  try {
    value = (await readHidden('  Value: ')).trim();
  } catch {
    result.cancelled = true;
    save();
    return result;
  }
  if (!value) {
    result.cancelled = true;
    save();
    console.log('  Empty value, nothing saved.');
    return result;
  }
  for (const t of opts.to) {
    let r;
    try {
      r = WRITERS[t](opts.name, value, { cwd: opts.cwd, envFile: opts.envFile });
    } catch (e) {
      r = { ok: false, error: e.message };
    }
    if (r.error) r.error = redact(r.error, value);
    result.targets[t] = r;
    console.log(`  ${r.ok ? 'OK  ' : 'FAIL'} ${t}${r.error ? `: ${r.error}` : ''}${r.warning ? `  (warning: ${r.warning})` : ''}`);
  }
  value = null;
  save();
  return result;
}

// ─── Launcher (runs where the agent called it) ────────────────────────────────

export function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function openUrl(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  spawnSync(cmd, [url], { stdio: 'ignore' });
}

/** Open a new terminal window running `command`. Returns false when no window could be opened. */
function openTerminal(command) {
  if (process.platform === 'darwin') {
    const script = `tell application "Terminal"\nactivate\ndo script "${command.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\nend tell`;
    return spawnSync('osascript', ['-e', script], { stdio: 'ignore' }).status === 0;
  }
  if (process.platform === 'linux') {
    for (const [bin, args] of [['x-terminal-emulator', ['-e']], ['gnome-terminal', ['--']], ['konsole', ['-e']], ['xterm', ['-e']]]) {
      const r = spawnSync(bin, [...args, 'sh', '-c', command], { stdio: 'ignore', detached: true });
      if (!r.error) return true;
    }
  }
  return false;
}

export async function launchSecret(opts, wnPath) {
  const dir = mkdtempSync(join(tmpdir(), 'wn-secret-'));
  const resultFile = join(dir, 'result.json');
  const childArgs = [opts.name, '--to', opts.to.join(','), '--env-file', opts.envFile, '--cwd', opts.cwd, '--here', '--result', resultFile];
  const command = [process.execPath, wnPath, 'secret', ...childArgs].map(shellQuote).join(' ') + '; exit';

  if (opts.url) openUrl(opts.url);
  if (!openTerminal(command)) {
    rmSync(dir, { recursive: true, force: true });
    const manual = ['wn', 'secret', ...childArgs.slice(0, -3)].map(a => (/^[\w,./-]+$/.test(a) ? a : shellQuote(a))).join(' ');
    console.log(`Could not open a terminal window. Ask the user to run this in their own terminal:\n  ${manual}`);
    return 2;
  }
  console.log(`Opened a terminal window for ${opts.name}. Waiting for the user to enter it...`);

  const deadline = Date.now() + opts.timeout * 1000;
  while (Date.now() < deadline && !existsSync(resultFile)) await new Promise(r => setTimeout(r, 500));
  if (!existsSync(resultFile)) {
    rmSync(dir, { recursive: true, force: true });
    console.log(`${opts.name}: NOT SET (timed out after ${opts.timeout}s)`);
    return 1;
  }
  const result = JSON.parse(readFileSync(resultFile, 'utf8'));
  rmSync(dir, { recursive: true, force: true });
  return report(result);
}

function report(result) {
  if (result.cancelled) {
    console.log(`${result.name}: NOT SET (cancelled)`);
    return 1;
  }
  const entries = Object.entries(result.targets);
  const ok = entries.filter(([, r]) => r.ok).map(([t]) => t);
  const failed = entries.filter(([, r]) => !r.ok);
  console.log(`${result.name}: ${ok.length ? `SET (${ok.join(', ')})` : 'NOT SET'}`);
  for (const [t, r] of failed) console.log(`  failed ${t}: ${r.error}`);
  for (const [t, r] of entries) if (r.warning) console.log(`  warning ${t}: ${r.warning}`);
  return failed.length ? 1 : 0;
}

export function checkSecret(opts) {
  const path = join(opts.cwd, opts.envFile);
  const set = existsSync(path) && envHas(readFileSync(path, 'utf8'), opts.name);
  console.log(`${opts.name}: ${set ? 'SET' : 'MISSING'} (${opts.envFile})`);
  return set ? 0 : 1;
}

// ─── Guard (Claude Code PreToolUse hook) ──────────────────────────────────────

const SAFE_ENV_FILE = /\.env\.(example|sample|template|dist|defaults)$/i;
const ENV_FILE = /(^|[\s/'"=<])\.env(\.[\w.-]+)?(?=$|[\s'";|&)>])/g;
const AGENT_CONFIG = /(mcp\.json|mcp_config\.json|claude_desktop_config\.json|\.claude\.json|\.codex\/config\.toml)$/;
const AGENT_CONFIG_IN_CMD = /[^\s'"]*(mcp\.json|mcp_config\.json|claude_desktop_config\.json|\.claude\.json|\.codex\/config\.toml)(?=$|[\s'";|&)>])/g;
const SECRET_VALUE = /\b(bak_|sk-|sk_live_|sk_test_|rk_live_|ghp_|gho_|github_pat_|xox[abp]-|glpat-|AKIA|eyJ)[A-Za-z0-9_-]{12,}|["']?[A-Za-z0-9_]*(KEY|SECRET|TOKEN|PASSWORD)[A-Za-z0-9_]*["']?\s*[:=]\s*["']?[^"'\s,{}$]{12,}/i;

const BASH_RULES = [
  [/(^|[;&|(]\s*|\bsudo\s+)(printenv|env|export\s+-p|set|declare\s+-x)\s*($|[;&|)])/, 'prints every environment variable'],
  [/\bprintenv\s+[A-Za-z_]/, 'prints an environment variable'],
  [/\brailway\s+variables?(\s+(list|ls))?(\s+-[\w-]+(\s+[\w-]+)?)*\s*($|[;&|>])/, 'lists Railway variables with values'],
  [/\brailway\s+variables?\b.*\s(--kv|-k|--json)\b/, 'lists Railway variables with values'],
  [/\bnetlify\s+env:(list|get)\b/, 'prints Netlify env values'],
  [/\bvercel\s+env\s+pull\b.*(\/dev\/stdout|\s-\s*$)/, 'prints Vercel env values'],
  [/\bheroku\s+config\b(?!:set|:unset)/, 'prints Heroku config values'],
  [/\bsecurity\s+find-(generic|internet)-password\b.*\s-[wg]\b/, 'prints a keychain password'],
  [/\bgcloud\s+secrets\s+versions\s+access\b/, 'prints a cloud secret'],
  [/\baws\s+secretsmanager\s+get-secret-value\b/, 'prints a cloud secret'],
  [/\bop\s+(read|item\s+get)\b/, 'prints a 1Password secret'],
  [/\bplutil\s+(-p|-convert\s+\S+\s+-o\s+-)(\s|$)|\b(cat|less|more|head|tail|bat)\b[^;&|]*\.plist\b/, 'prints a plist, which can hold service API keys'],
  [/\blaunchctl\s+print\b(?![^;&]*\|)/, 'prints a service environment, which can hold API keys'],
  [/\b(echo|printf)\b[^;&|]*\$\{?[A-Z0-9_]*(KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|DSN)/, 'prints a secret variable'],
];

const READERS = /\b(cat|less|more|head|tail|bat|grep|rg|ag|awk|sed|cut|sort|uniq|strings|xxd|od|hexdump|nl|tac|diff|base64|jq|curl|scp|rsync|python3?|node)\b/;

/** Names the .env files a command mentions, ignoring example files. */
function envFilesIn(cmd) {
  return [...cmd.matchAll(ENV_FILE)].map(m => m[0].replace(/^[\s/'"=<]/, '')).filter(f => !SAFE_ENV_FILE.test(f));
}

/**
 * Drops what a command only carries as data - heredoc bodies and multi-word quoted strings - so that
 * mentioning `cat .env` inside a JSON test payload or a script body does not trip the guard.
 * Heredocs fed to a shell, strings after -c/-e/eval and double-quoted strings that expand $VARS are kept.
 * With keepPaths, quoted paths that contain spaces ("my app/.env") are kept too.
 */
export function codeOnly(cmd, { keepPaths = false } = {}) {
  const noHeredocs = cmd.replace(/^(.*?)<<-?\s*(['"]?)(\w+)\2([^\n]*)\n[\s\S]*?\n[ \t]*\3[ \t]*(?=\n|$)/gm,
    (m, head, _q, _tag, rest) => (/\b(bash|sh|zsh|dash|source|eval)\b/.test(head) ? m : `${head}${rest}`));
  const isPath = (s) => /^[^{}]*\/[^/\s]+$/.test(s);
  return noHeredocs.replace(/(-c|-e|eval)?(\s*)('[^']*'|"(?:[^"\\]|\\.)*")/g, (m, flag, sp, str) => {
    const body = str.slice(1, -1);
    return flag || !/\s/.test(body) || (str[0] === '"' && body.includes('$')) || (keepPaths && isPath(body)) ? m : `${sp}''`;
  });
}

/** True when a local file looks like it holds a key or token. Unreadable files count as secret. */
export function fileHasSecrets(path) {
  try {
    return SECRET_VALUE.test(readFileSync(path, 'utf8').slice(0, 1_000_000));
  } catch (e) {
    return e.code !== 'ENOENT';
  }
}

function resolveFrom(cwd, p) {
  const home = process.env.HOME ?? '';
  const expanded = p.replace(/^~(?=\/)/, home).replace(/^\$\{?HOME\}?(?=\/)/, home);
  return expanded.startsWith('/') ? expanded : join(cwd ?? process.cwd(), expanded);
}

/** Returns a reason string when the tool call would expose a secret, else null. */
export function guardCheck(event) {
  const tool = event?.tool_name;
  const input = event?.tool_input ?? {};
  if (tool === 'Bash') {
    const raw = String(input.command ?? '');
    const cmd = codeOnly(raw);
    for (const [re, why] of BASH_RULES) if (re.test(cmd)) return why;
    if (!READERS.test(cmd)) return null;
    const files = codeOnly(raw, { keepPaths: true });
    if (envFilesIn(files).length) return 'reads a .env file';
    const configs = [...files.matchAll(AGENT_CONFIG_IN_CMD)].map(m => resolveFrom(event.cwd, m[0]));
    if (configs.some(p => !existsSync(p) || fileHasSecrets(p))) return 'reads an AI tool config that holds API keys';
    return null;
  }
  if (tool === 'Read' || tool === 'Grep' || tool === 'NotebookRead') {
    const p = String(input.file_path ?? input.path ?? '');
    const b = basename(p);
    if (/^\.env(\.|$)/.test(b) && !SAFE_ENV_FILE.test(b)) return 'reads a .env file';
    if (tool === 'Grep' && /^\.env/.test(String(input.glob ?? '')) && !SAFE_ENV_FILE.test(String(input.glob))) return 'reads a .env file';
    if (/\.(pem|p12|pfx|key)$/i.test(b) || /^id_(rsa|ed25519|ecdsa)$/.test(b)) return 'reads a private key file';
    if (AGENT_CONFIG.test(p) && fileHasSecrets(resolveFrom(event.cwd, p))) return 'reads an AI tool config that holds API keys';
  }
  return null;
}

export function guardMessage(why) {
  return `Blocked by What Next secret guard: this ${why}, which would put secret values into the chat.\n` +
    `Check presence instead: wn secret NAME --check (or [ -n "$VAR" ] && echo SET || echo MISSING).\n` +
    `To add or change a secret, run: wn secret NAME --to env,netlify,railway --url <where to get it>. ` +
    `It opens a separate terminal for the user and never shows you the value. Never ask the user to paste a secret into chat.`;
}

/** Hook entry: reads the event JSON on stdin, exits 2 with a reason to block. */
export async function runGuard() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let event;
  try { event = JSON.parse(raw); } catch { return 0; }
  const why = guardCheck(event);
  if (!why) return 0;
  process.stderr.write(guardMessage(why) + '\n');
  return 2;
}

// ─── Guard install (adds the hook to ~/.claude/settings.json) ─────────────────

export function addGuardHook(settings, command) {
  settings.hooks ??= {};
  settings.hooks.PreToolUse ??= [];
  const list = settings.hooks.PreToolUse;
  const existing = list.find(e => e.hooks?.some(h => typeof h.command === 'string' && /wn(\.js)?['"]? guard$/.test(h.command)));
  const entry = { matcher: 'Bash|Read|Grep', hooks: [{ type: 'command', command, timeout: 5 }] };
  if (existing) Object.assign(existing, entry);
  else list.push(entry);
  return settings;
}
