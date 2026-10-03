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

import { spawn, spawnSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync, chmodSync, renameSync } from 'fs';
import { tmpdir, userInfo } from 'os';
import { join, basename, dirname, resolve } from 'path';

export const TARGETS = ['env', 'netlify', 'railway', 'vercel', 'supabase', 'github', 'keychain'];
export const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Under Claude Code's 120s default Bash timeout, so the agent sees the result instead of a killed command
export const DEFAULT_TIMEOUT = 110;

// ─── Arguments ────────────────────────────────────────────────────────────────

export function parseSecretArgs(argv) {
  const opts = { name: null, to: ['env'], url: null, envFile: '.env', cwd: process.cwd(), here: false, check: false, result: null, timeout: DEFAULT_TIMEOUT };
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
  if (!(opts.timeout > 0)) throw new Error('--timeout needs a number of seconds');
  return opts;
}

// ─── .env handling ────────────────────────────────────────────────────────────

export function formatEnvValue(value) {
  if (/^[A-Za-z0-9_\-./+=:@,]*$/.test(value)) return value;
  // dotenv-expand and godotenv expand $VAR inside double quotes; single quotes keep the value literal
  if (value.includes('$') && !value.includes("'")) return `'${value}'`;
  return JSON.stringify(value);
}

/** Set or replace NAME in dotenv content, keeping every other line as is. */
export function upsertEnv(content, name, value) {
  const line = `${name}=${formatEnvValue(value)}`;
  const re = new RegExp(`^(export[ \\t]+)?${name}[ \\t]*=.*$`, 'm');
  // A replacer function, so $&, $' and $1 in the value are not treated as replacement patterns
  if (re.test(content)) return content.replace(re, (_m, exp) => `${exp ?? ''}${line}`);
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

function run(cmd, args, { cwd, input, detached = false } = {}) {
  const r = spawnSync(cmd, args, { cwd, input, detached, encoding: 'utf8', stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  if (r.error) return { ok: false, error: r.error.code === 'ENOENT' ? `${cmd} CLI not installed` : r.error.message };
  if (r.status !== 0) return { ok: false, error: (r.stderr || r.stdout || `exit ${r.status}`).trim().split('\n').slice(-3).join(' ') };
  return { ok: true };
}

function writeEnv(name, value, { cwd, envFile }) {
  const path = resolve(cwd, envFile);
  const isNew = !existsSync(path);
  writeFileSync(path, upsertEnv(isNew ? '' : readFileSync(path, 'utf8'), name, value));
  if (isNew) chmodSync(path, 0o600);
  const dir = dirname(path);
  const ignored = spawnSync('git', ['check-ignore', '-q', basename(path)], { cwd: dir }).status === 0;
  const inRepo = spawnSync('git', ['rev-parse', '--git-dir'], { cwd: dir, stdio: 'ignore' }).status === 0;
  return { ok: true, warning: inRepo && !ignored ? `${envFile} is not gitignored` : null };
}

/**
 * `security add-generic-password ... -w` with no value prompts for it. Run detached (no controlling
 * terminal) it reads the prompt answer from stdin, which keeps the value out of the process list.
 * The prompt silently truncates at 127 bytes, so longer values still go in argv.
 */
function writeKeychain(name, value) {
  if (process.platform !== 'darwin') return { ok: false, error: 'keychain target is macOS only' };
  const args = ['add-generic-password', '-U', '-a', userInfo().username, '-s', name, '-w'];
  if (Buffer.byteLength(value) < 128) return run('security', args, { input: `${value}\n${value}\n`, detached: true });
  return run('security', [...args, value]);
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
  // netlify env:set has no stdin or file input, so the value is passed in argv (briefly visible to `ps` on this machine)
  netlify: (name, value, { cwd }) => run('netlify', ['env:set', name, value, '--secret'], { cwd }),
  railway: (name, value, { cwd }) => run('railway', ['variable', 'set', name, '--stdin'], { cwd, input: value }),
  vercel: (name, value, { cwd }) => run('vercel', ['env', 'add', name, 'production'], { cwd, input: value }),
  supabase: writeSupabase,
  github: (name, value, { cwd }) => run('gh', ['secret', 'set', name], { cwd, input: value }),
  keychain: writeKeychain,
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
      const chars = [...chunk];
      for (let i = 0; i < chars.length; i++) {
        const ch = chars[i];
        if (ch === '\r' || ch === '\n') {
          // More text after Enter in the same chunk means a multi-line paste; saving only the first line would be silent truncation
          if (chars.slice(i + 1).some(c => c !== '\r' && c !== '\n')) {
            value = '';
            return done(new Error('Multi-line values are not supported. Save it to a file and point the app at the file path instead.'));
          }
          return done();
        }
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
  // Write then rename so the launcher never reads a half-written file. The launcher may have
  // timed out and gone, so a missing result folder is not an error: the targets are already saved.
  const save = () => {
    if (!opts.result) return;
    try {
      const tmp = `${opts.result}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(result));
      renameSync(tmp, opts.result);
    } catch { /* launcher gone */ }
  };
  console.log(`\n  What Next - secret entry\n`);
  console.log(`  Variable:  ${opts.name}`);
  console.log(`  Saving to: ${opts.to.join(', ')}  (in ${opts.cwd})`);
  if (opts.url) console.log(`  Get it at: ${opts.url}`);
  console.log(`\n  Paste the value and press Enter. Nothing is shown and nothing reaches the AI chat.\n`);
  let value;
  try {
    value = (await readHidden('  Value: ')).trim();
  } catch (e) {
    result.cancelled = true;
    if (e.message !== 'Cancelled') {
      result.reason = e.message;
      console.log(`  ${e.message} Nothing saved.`);
    }
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

/**
 * Starts a terminal emulator without waiting for it (xterm and konsole block until the window closes).
 * Resolves false when it is missing or exits with an error straight away.
 */
function spawnTerminal(bin, args) {
  return new Promise((done) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: 'ignore', detached: true });
    } catch {
      return done(false);
    }
    const timer = setTimeout(() => { child.unref(); done(true); }, 1500);
    child.on('error', () => { clearTimeout(timer); done(false); });
    child.on('exit', (code) => { clearTimeout(timer); done(code === 0); });
  });
}

/** Open a new terminal window running `command`. Resolves false when no window could be opened. */
async function openTerminal(command) {
  if (process.platform === 'darwin') {
    const script = `tell application "Terminal"\nactivate\ndo script "${command.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\nend tell`;
    return spawnSync('osascript', ['-e', script], { stdio: 'ignore' }).status === 0;
  }
  if (process.platform === 'linux') {
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false;
    for (const [bin, args] of [['x-terminal-emulator', ['-e']], ['gnome-terminal', ['--']], ['konsole', ['-e']], ['xterm', ['-e']]]) {
      if (await spawnTerminal(bin, [...args, 'sh', '-c', command])) return true;
    }
  }
  return false;
}

/** The command the user can paste into their own terminal. cmd.exe and PowerShell do not understand POSIX single quotes. */
export function manualCommand(args, platform = process.platform) {
  const quote = platform === 'win32' ? (a) => `"${String(a).replace(/"/g, '\\"')}"` : shellQuote;
  return ['wn', 'secret', ...args].map(a => (/^[\w,./-]+$/.test(a) ? a : quote(a))).join(' ');
}

/** Parsed result file, or null while it is missing or unreadable. */
function readResult(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export async function launchSecret(opts, wnPath) {
  const dir = mkdtempSync(join(tmpdir(), 'wn-secret-'));
  const resultFile = join(dir, 'result.json');
  const childArgs = [opts.name, '--to', opts.to.join(','), '--env-file', opts.envFile, '--cwd', opts.cwd, '--here', '--result', resultFile];
  const command = [process.execPath, wnPath, 'secret', ...childArgs].map(shellQuote).join(' ') + '; exit';

  if (opts.url) openUrl(opts.url);
  if (!(await openTerminal(command))) {
    rmSync(dir, { recursive: true, force: true });
    console.log(`Could not open a terminal window. Ask the user to run this in their own terminal:\n  ${manualCommand(childArgs.slice(0, -3))}`);
    return 2;
  }
  console.log(`Opened a terminal window for ${opts.name}. Waiting up to ${opts.timeout}s for the user to enter it...`);

  const deadline = Date.now() + opts.timeout * 1000;
  let result = readResult(resultFile);
  while (!result && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
    result = readResult(resultFile);
  }
  if (!result) {
    // The folder is left in place: the entry window may still be open and will write its result there
    console.log(`${opts.name}: NOT SET (timed out after ${opts.timeout}s). The entry window may still be open; once the user is done, check with: wn secret ${opts.name} --check${opts.envFile !== '.env' ? ` --env-file ${opts.envFile}` : ''}`);
    console.log(`Hint: if the user needs longer, re-run with a longer Bash tool timeout (e.g. 600000 ms) and --timeout 590.`);
    return 1;
  }
  rmSync(dir, { recursive: true, force: true });
  return report(result);
}

function report(result) {
  if (result.cancelled) {
    console.log(`${result.name}: NOT SET (${result.reason ?? 'cancelled'})`);
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
  const path = resolve(opts.cwd, opts.envFile);
  const set = existsSync(path) && envHas(readFileSync(path, 'utf8'), opts.name);
  console.log(`${opts.name}: ${set ? 'SET' : 'MISSING'} (${opts.envFile})`);
  return set ? 0 : 1;
}

// ─── Guard (Claude Code PreToolUse hook) ──────────────────────────────────────

const SAFE_ENV_FILE = /\.(example|sample|template|dist|defaults)$/i;
const ENV_NAME = String.raw`\.(?:env(?:\.[\w.*-]+)?|envrc|dev\.vars(?:\.[\w.-]+)?)`;
const ENV_FILE = new RegExp(String.raw`(^|[\s/'"=<])${ENV_NAME}\*?(?=$|[\s'";|&)>*])`, 'g');
const ENV_BASENAME = new RegExp(String.raw`^${ENV_NAME}$`);
const AGENT_CONFIG = /(mcp\.json|mcp_config\.json|claude_desktop_config\.json|\.claude\.json|\.codex\/config\.toml)$/;
const AGENT_CONFIG_IN_CMD = /[^\s'"]*(mcp\.json|mcp_config\.json|claude_desktop_config\.json|\.claude\.json|\.codex\/config\.toml)(?=$|[\s'";|&)>])/g;
const CRED_FILE = /(^|[\s/'"])(\.aws\/credentials|\.netrc|_netrc|\.pgpass|\.git-credentials)(?=$|[\s'";|&)>])/;
const NPMRC = /(^|\/)\.npmrc$/;
const NPMRC_IN_CMD = /[^\s'"]*\.npmrc(?=$|[\s'";|&)>])/g;
const SECRET_VALUE = /\b(bak_|sk-|sk_live_|sk_test_|rk_live_|ghp_|gho_|github_pat_|xox[abp]-|glpat-|npm_|AKIA|eyJ)[A-Za-z0-9_-]{12,}|["']?[A-Za-z0-9_]*(KEY|SECRET|TOKEN|PASSWORD)[A-Za-z0-9_]*["']?\s*[:=]\s*["']?[^"'\s,{}$]{12,}|^\s*_auth\s*=\s*\S{12,}/im;

// Environment variables that are safe to print
const SAFE_VARS = new Set(['HOME', 'PATH', 'SHELL', 'USER', 'LOGNAME', 'PWD', 'OLDPWD', 'LANG', 'LC_ALL', 'TERM', 'NODE_ENV', 'CI', 'TMPDIR', 'EDITOR', 'HOSTNAME', 'SHLVL']);
const SECRET_VAR = String.raw`[A-Z0-9_]*(KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|DSN|_URL|_URI|_CONN|CONNECTION_STRING)`;

const BASH_RULES = [
  [/(^\s*|[;&|(]\s*|\bsudo\s+)(printenv|env|export|export\s+-p|set|declare\s+-[xp]+)\s*($|[;&|)])/m, 'prints every environment variable'],
  [(c) => [...c.matchAll(/\bprintenv((?:[ \t]+[A-Za-z_]\w*)+)/g)].some(m => m[1].trim().split(/\s+/).some(v => !SAFE_VARS.has(v))), 'prints an environment variable'],
  [/\brailway\s+variables?(\s+(list|ls))?(\s+-[\w-]+(\s+[\w-]+)?)*\s*($|[;&|>])/, 'lists Railway variables with values'],
  [/\brailway\s+variables?\b.*\s(--kv|-k|--json)\b/, 'lists Railway variables with values'],
  [/\bnetlify\s+env:(list|get)\b/, 'prints Netlify env values'],
  [/\bvercel\s+env\s+pull\b.*(\/dev\/stdout|\s-\s*$)/, 'prints Vercel env values'],
  [/\bheroku\s+config\b(?!:set|:unset)/, 'prints Heroku config values'],
  [/\bsecurity\s+find-(generic|internet)-password\b.*\s-[wg]\b/, 'prints a keychain password'],
  [/\bgcloud\s+secrets\s+versions\s+access\b/, 'prints a cloud secret'],
  [/\baws\s+secretsmanager\s+get-secret-value\b/, 'prints a cloud secret'],
  [/\bop\s+(read|item\s+get)\b/, 'prints a 1Password secret'],
  [/\bsupabase\s+projects\s+api-keys\b/, 'prints Supabase API keys'],
  [/\bdocker(\s+|-)compose\b[^;&|\n]*\sconfig\b(?![^;&|\n]*\s(--services|--volumes|--images|--profiles|--networks|--hash|-q|--quiet)\b)/, 'prints the compose file with env values filled in'],
  [/\bplutil\s+(-p|-convert\s+\S+\s+-o\s+-)(\s|$)|\b(cat|less|more|head|tail|bat)\b[^;&|]*\.plist\b/, 'prints a plist, which can hold service API keys'],
  [/\blaunchctl\s+print\b(?![^;&]*\|)/, 'prints a service environment, which can hold API keys'],
  [new RegExp(String.raw`\b(echo|printf)\b[^;&|]*\$\{?${SECRET_VAR}`), 'prints a secret variable'],
  [/\b(console\.\w+|print|pprint|pp|puts|p|JSON\.stringify|util\.inspect|json\.dumps|var_dump|print_r|dict)\s*\(\s*(dict\(\s*)?(process\.env|os\.environ|Deno\.env\.toObject\(\s*\)|ENV|\$_ENV|getenv\(\s*\))(?![\w.[])/, 'prints every environment variable'],
];

const READERS = /\b(cat|less|more|head|tail|bat|grep|rg|ag|awk|sed|cut|sort|uniq|strings|xxd|od|hexdump|nl|tac|diff|base64|jq|curl|scp|rsync|python[\d.]*|node|ruby|perl|php|bun|deno|tsx)\b/;
const INTERPRETER = /(^|[\s|;&(/])(bash|sh|zsh|dash|source|eval|python[\d.]*|node|ruby|perl|bun|deno|tsx|php)(?=\s|$)/;

/** Names the .env files a command mentions, ignoring example files. */
function envFilesIn(cmd) {
  return [...cmd.matchAll(ENV_FILE)].map(m => m[0].replace(/^[\s/'"=<]/, '')).filter(f => !SAFE_ENV_FILE.test(f));
}

/** True when a Grep tool glob such as `**\/.env*` would search .env files. */
function globHitsEnv(glob) {
  return glob.split(/[/{},]/).some(part => /^\.(env|envrc|dev\.vars)/.test(part) && !SAFE_ENV_FILE.test(part));
}

/**
 * Turns `${VAR:+set}` and `${#VAR}` into a plain word: they only show whether a variable is set or how
 * long it is, never its value.
 */
function withoutPresenceChecks(cmd) {
  return cmd.replace(/\$\{#[A-Za-z_]\w*\}|\$\{[A-Za-z_]\w*:?\+[^}]*\}/g, 'SET');
}

/**
 * Drops what a command only carries as data - heredoc bodies and multi-word quoted strings - so that
 * mentioning `cat .env` inside a JSON test payload or a script body does not trip the guard.
 * Heredocs fed to a shell or an interpreter, strings after -c/-e/eval and double-quoted strings that
 * expand $VARS are kept. With keepPaths, quoted paths that contain spaces ("my app/.env") are kept too.
 */
export function codeOnly(cmd, { keepPaths = false } = {}) {
  const noHeredocs = cmd.replace(/^(.*?)<<-?\s*(['"]?)(\w+)\2([^\n]*)\n[\s\S]*?\n[ \t]*\3[ \t]*(?=\n|$)/gm,
    (m, head, _q, _tag, rest) => (INTERPRETER.test(head) ? m : `${head}${rest}`));
  const isPath = (s) => /^[^{}]*\/[^/\s]+$/.test(s);
  return noHeredocs.replace(/(-c|-e|eval)?(\s*)('[^']*'|"(?:[^"\\]|\\.)*")/g, (m, flag, sp, str) => {
    const body = str.slice(1, -1);
    return flag || !/\s/.test(body) || (str[0] === '"' && body.includes('$')) || (keepPaths && isPath(body)) ? m : `${sp}''`;
  });
}

/** Splits a command line on ; | & and newlines that are outside quotes. `2>&1` stays whole. */
function splitSegments(cmd) {
  const out = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      cur += c;
      if (c === '\\' && quote === '"') cur += cmd[++i] ?? '';
      else if (c === quote) quote = null;
    } else if (c === "'" || c === '"') {
      quote = c;
      cur += c;
    } else if (c === ';' || c === '|' || c === '\n' || (c === '&' && cmd[i - 1] !== '>' && cmd[i + 1] !== '>')) {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

// Commands that take a .env path without printing what is in it
const NON_READING = /^(echo|printf|touch|chmod|chown|ls|cp|mv|rm|mkdir|ln|stat|test|\[\[?|wn|realpath|dirname|basename|du|file|wc)$/;
const NON_READING_GIT = /^git\s+(check-ignore|ls-files|status|add|rm|mv|update-index)\b/;
const GREP_CMD = /^(grep|egrep|fgrep|rg|ag|ack)$/;
const GREP_OPT_WITH_ARG = /^(-[fmABCdDgtTMj]|--(file|max-count|context|after-context|before-context|glob|type|type-not|label|include|exclude))$/;

/** Drops the pattern argument of grep or rg, so `grep -n ".env" .gitignore` only counts as reading .gitignore. */
function withoutGrepPattern(words) {
  const out = [words[0]];
  let dropped = words.some(w => /^(-e|--regexp|-f|--file)(=|$)/.test(w));
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w === '-e' || w === '--regexp') { i++; continue; }
    if (/^--regexp=/.test(w)) continue;
    if (GREP_OPT_WITH_ARG.test(w)) { out.push(w, words[++i] ?? ''); continue; }
    if (!dropped && !w.startsWith('-')) { dropped = true; continue; }
    out.push(w);
  }
  return out.join(' ');
}

/**
 * The parts of a command that may read files: one string per command segment, leaving out segments
 * that only name a file (touch, chmod, ls, cp, echo .env >> .gitignore), output redirect targets,
 * --env-file flags (the program loads the file, it does not print it) and grep patterns.
 */
function readingParts(cmd) {
  const parts = [];
  for (const raw of splitSegments(cmd)) {
    const seg = raw.replace(/--env-file(=|\s+)\S+/g, '').replace(/\d*>>?\s*[^\s&]\S*/g, '').trim();
    const words = seg.match(/(?:[^\s'"]+|'[^']*'|"(?:[^"\\]|\\.)*")+/g) ?? [];
    let i = 0;
    while (i < words.length && (/^(sudo|time|command|nice|nohup)$/.test(words[i]) || /^[A-Za-z_]\w*=/.test(words[i]))) i++;
    const rest = words.slice(i);
    if (!rest.length) continue;
    const first = basename(rest[0]);
    const passesData = /\$\(|`|\/dev\/(stdout|stderr|tty|fd)/.test(seg);
    if (!passesData && (NON_READING.test(first) || NON_READING_GIT.test(rest.join(' ')))) continue;
    parts.push(GREP_CMD.test(first) ? withoutGrepPattern(rest) : rest.join(' '));
  }
  return parts;
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
    const cmd = withoutPresenceChecks(codeOnly(raw));
    for (const [rule, why] of BASH_RULES) if (typeof rule === 'function' ? rule(cmd) : rule.test(cmd)) return why;
    if (!READERS.test(cmd)) return null;
    const reads = readingParts(codeOnly(raw, { keepPaths: true })).join('\n');
    if (envFilesIn(reads).length) return 'reads a .env file';
    if (CRED_FILE.test(reads)) return 'reads a credentials file';
    const npmrcs = [...reads.matchAll(NPMRC_IN_CMD)].map(m => resolveFrom(event.cwd, m[0]));
    if (npmrcs.some(p => fileHasSecrets(p))) return 'reads an .npmrc that holds an auth token';
    const configs = [...reads.matchAll(AGENT_CONFIG_IN_CMD)].map(m => resolveFrom(event.cwd, m[0]));
    if (configs.some(p => !existsSync(p) || fileHasSecrets(p))) return 'reads an AI tool config that holds API keys';
    return null;
  }
  if (tool === 'Read' || tool === 'Grep') {
    const p = String(input.file_path ?? input.path ?? '');
    const b = basename(p);
    if (ENV_BASENAME.test(b) && !SAFE_ENV_FILE.test(b)) return 'reads a .env file';
    if (tool === 'Grep' && globHitsEnv(String(input.glob ?? ''))) return 'reads a .env file';
    if (/\.(pem|p12|pfx|key)$/i.test(b) || /^id_(rsa|ed25519|ecdsa)$/.test(b)) return 'reads a private key file';
    if (CRED_FILE.test(p)) return 'reads a credentials file';
    if (NPMRC.test(p) && fileHasSecrets(resolveFrom(event.cwd, p))) return 'reads an .npmrc that holds an auth token';
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

export const GUARD_MATCHER = 'Bash|Read|Grep';
const isGuardHook = (h) => typeof h?.command === 'string' && /wn(\.js)?['"]? guard$/.test(h.command.trim());

/**
 * Adds or updates the guard hook. Only our own hook object is touched: the user's hooks in the same
 * entry stay, and an entry shared with a different matcher keeps its matcher (our hook moves to its own entry).
 */
export function addGuardHook(settings, command) {
  settings.hooks ??= {};
  settings.hooks.PreToolUse ??= [];
  const ours = { type: 'command', command, timeout: 5 };
  const emptied = new Set();
  let placed = false;
  for (const entry of settings.hooks.PreToolUse) {
    if (!Array.isArray(entry?.hooks) || !entry.hooks.some(isGuardHook)) continue;
    const others = entry.hooks.filter(h => !isGuardHook(h));
    if (!placed && (!others.length || entry.matcher === GUARD_MATCHER)) {
      const at = entry.hooks.findIndex(isGuardHook);
      entry.hooks = entry.hooks.filter((h, j) => j === at || !isGuardHook(h)).map(h => (isGuardHook(h) ? ours : h));
      entry.matcher = GUARD_MATCHER;
      placed = true;
    } else {
      entry.hooks = others;
      if (!others.length) emptied.add(entry);
    }
  }
  settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter(e => !emptied.has(e));
  if (!placed) settings.hooks.PreToolUse.push({ matcher: GUARD_MATCHER, hooks: [ours] });
  return settings;
}
