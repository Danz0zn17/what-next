#!/usr/bin/env node
/**
 * What Next - MCP config installer
 *
 * Patches your AI tool's MCP config to add What Next in one command.
 *
 * Usage:
 *   node bin/install.js --client claude  --key bak_xxx
 *   node bin/install.js --client vscode  --key bak_xxx
 *   node bin/install.js --client codex   --key bak_xxx
 *   node bin/install.js --client cursor  --key bak_xxx
 *   node bin/install.js --client openclaw
 *
 * Supported clients: claude, vscode, copilot, cursor, windsurf, codex, openclaw
 *
 * Codex note: covers both the VS Code Codex extension (openai.chatgpt) and the
 * Codex CLI agent - both read ~/.codex/config.toml for MCP servers.
 *
 * Every existing file is copied to a timestamped .bak before it is rewritten.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, realpathSync, chmodSync } from 'fs';
import { execFileSync, spawnSync } from 'child_process';
import { basename, dirname, join, resolve, posix } from 'path';
import { homedir } from 'os';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';
import { resolveConfigPath, isVscodeLikeClient } from '../src/platform-config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(join(__dirname, '..'));
const CLOUD_URL = 'https://what-next-production.up.railway.app';
const H = homedir();

// ─── Pure helpers (exported for tests) ───────────────────────────────────────

function timestamp(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

// Copy an existing file to <path>.bak-<timestamp> (or into backupDir) before
// it is modified. Returns the backup path, or null when there was nothing to back up.
export function backupFile(path, { now = new Date(), backupDir = null } = {}) {
  if (!existsSync(path)) return null;
  const dir = backupDir ?? dirname(path);
  mkdirSync(dir, { recursive: true });
  let dest = join(dir, `${basename(path)}.bak-${timestamp(now)}`);
  for (let n = 1; existsSync(dest); n++) dest = join(dir, `${basename(path)}.bak-${timestamp(now)}-${n}`);
  copyFileSync(path, dest);
  return dest;
}

// Split a TOML dotted key ("mcp_servers.\"what-next\".env") into its parts.
// Returns null when the key is malformed.
export function parseTomlKey(src) {
  const s = src.trim();
  const parts = [];
  let i = 0;
  while (i < s.length) {
    while (s[i] === ' ' || s[i] === '\t') i++;
    let part = '';
    if (s[i] === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\') { part += s[i + 1] ?? ''; i += 2; } else part += s[i++];
      }
      if (s[i] !== '"') return null;
      i++;
    } else if (s[i] === "'") {
      i++;
      while (i < s.length && s[i] !== "'") part += s[i++];
      if (s[i] !== "'") return null;
      i++;
    } else {
      while (i < s.length && /[A-Za-z0-9_-]/.test(s[i])) part += s[i++];
      if (!part) return null;
    }
    parts.push(part);
    while (s[i] === ' ' || s[i] === '\t') i++;
    if (i >= s.length) break;
    if (s[i] !== '.') return null;
    i++;
  }
  return parts.length ? parts : null;
}

// Track multi-line strings and open arrays/inline tables so a value line that
// happens to start with "[" is never mistaken for a table header.
function scanTomlValue(line, state, from = 0) {
  for (let i = from; i < line.length; i++) {
    if (state.ml) {
      const end = line.indexOf(state.ml, i);
      if (end === -1) return;
      i = end + 2;
      state.ml = null;
      continue;
    }
    const c = line[i];
    if (c === '#') return;
    if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
      state.ml = line.slice(i, i + 3);
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < line.length && line[i] !== c) i += (c === '"' && line[i] === '\\') ? 2 : 1;
      continue;
    }
    if (c === '[' || c === '{') state.depth++;
    else if ((c === ']' || c === '}') && state.depth > 0) state.depth--;
  }
}

const TOML_HEADER = /^\s*\[(\[)?\s*(.+?)\s*\](\])?\s*(?:#.*)?$/;

// Replace the [mcp_servers.what-next] table and its subtables with block,
// leaving every other line of the file untouched. The block goes where the
// first what-next table was, or at the end when there was none.
export function spliceCodexToml(content, block) {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  const owned = new Array(lines.length).fill(false);
  const kind = new Array(lines.length).fill('other');
  const state = { ml: null, depth: 0 };
  let ours = false;
  let insertAt = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const header = !state.ml && state.depth === 0 ? line.match(TOML_HEADER) : null;
    if (header) {
      const key = parseTomlKey(header[2]);
      ours = !!key && key[0] === 'mcp_servers' && key[1] === 'what-next';
      if (ours && insertAt === -1) insertAt = i;
      kind[i] = 'header';
    } else {
      if (state.ml) kind[i] = 'string';
      scanTomlValue(line, state);
    }
    owned[i] = ours;
  }

  // Comments at the end of a what-next run usually introduce the next
  // section; hand them (and blank lines between them) back to it.
  for (let i = 0; i < lines.length - 1; i++) {
    if (!owned[i] || owned[i + 1]) continue;
    let j = i;
    while (j >= 0 && owned[j] && kind[j] === 'other' && /^\s*(#.*)?$/.test(lines[j])) j--;
    let k = j + 1;
    while (k <= i && lines[k].trim() === '') k++;
    for (; k <= i; k++) owned[k] = false;
  }

  const before = [];
  const after = [];
  for (let i = 0; i < lines.length; i++) {
    if (owned[i]) continue;
    (insertAt !== -1 && i > insertAt ? after : before).push(lines[i]);
  }
  while (before.length && before[before.length - 1].trim() === '') before.pop();
  while (after.length && after[0].trim() === '') after.shift();
  while (after.length && after[after.length - 1].trim() === '') after.pop();

  const out = [];
  if (before.length) out.push(...before, '');
  out.push(...block.split('\n'));
  if (after.length) out.push('', ...after);
  return out.join(eol) + eol;
}

export function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function buildPlist({ programArgs, logsDir, root, home, cloudUrl, key }) {
  const x = xmlEscape;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.whatnextai.api</string>

    <key>ProgramArguments</key>
    <array>
${programArgs.map(a => `        <string>${x(a)}</string>`).join('\n')}
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>15</integer>

    <key>StandardOutPath</key>
    <string>${x(logsDir)}/api.log</string>
    <key>StandardErrorPath</key>
    <string>${x(logsDir)}/api-error.log</string>

    <key>WorkingDirectory</key>
    <string>${x(root)}</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>${x(home)}</string>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>WHATNEXT_CLOUD_URL</key>
        <string>${x(cloudUrl)}</string>
        <key>WHATNEXT_API_KEY</key>
        <string>${x(key)}</string>
        <key>WHATNEXT_PREFER_LOCAL</key>
        <string>1</string>
        <key>WHATNEXT_CLOUD_SYNC_MODE</key>
        <string>background</string>
        <key>WHATNEXT_PORT</key>
        <string>3747</string>
        <key>WHATNEXT_BOOT_RETRIES</key>
        <string>12</string>
        <key>WHATNEXT_BOOT_DELAY_MS</key>
        <string>750</string>
    </dict>
</dict>
</plist>
`;
}

// systemd quoting: double quotes with backslash escapes; % starts a specifier.
export function systemdQuote(value) {
  const s = String(value);
  if (/[\r\n]/.test(s)) throw new Error('newline not allowed in systemd value');
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
}

export function buildSystemdUnit({ nodeExec, root, cloudUrl, key }) {
  const q = systemdQuote;
  const env = {
    WHATNEXT_CLOUD_URL: cloudUrl,
    WHATNEXT_API_KEY: key,
    WHATNEXT_PREFER_LOCAL: '1',
    WHATNEXT_CLOUD_SYNC_MODE: 'background',
    WHATNEXT_PORT: '3747',
  };
  return [
    '[Unit]',
    'Description=What Next local REST API and web UI',
    'After=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${q(nodeExec)} ${q(posix.join(root, 'bin', 'local-api.js'))}`,
    `WorkingDirectory=${root.replace(/%/g, '%%')}`,
    ...Object.entries(env).map(([k, v]) => `Environment=${q(`${k}=${v}`)}`),
    'Restart=on-failure',
    'RestartSec=15',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

// ─── Argument parsing ────────────────────────────────────────────────────────

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : null;
}

// ─── Prompt helper ───────────────────────────────────────────────────────────

async function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer.trim()); }));
}

function reportBackup(path) {
  if (path) console.log(`  Backup: ${path}`);
}

async function main() {
  const client = (arg('--client') ?? 'claude').toLowerCase();
  let apiKey = arg('--key');

  // ─── OpenClaw: skill installer (no MCP config, no API key needed) ─────────────

  if (client === 'openclaw') {
    const skillSrc = join(ROOT, 'skills/what-next/SKILL.md');
    const skillDir = join(H, '.openclaw/skills/what-next');
    const skillDest = join(skillDir, 'SKILL.md');
    if (!existsSync(skillSrc)) {
      console.error(`\nSkill file not found: ${skillSrc}\n`);
      process.exit(1);
    }
    mkdirSync(skillDir, { recursive: true });
    const backup = backupFile(skillDest);
    copyFileSync(skillSrc, skillDest);
    console.log('\nWhat Next skill installed for OpenClaw');
    console.log(`  Skill: ${skillDest}`);
    reportBackup(backup);
    console.log('\nStart a new OpenClaw session and try:');
    console.log('  /what_next or just ask about a project\n');
    process.exit(0);
  }

  // ─── Codex: TOML config (~/.codex/config.toml) ──────────────────────────────
  // Covers both the VS Code Codex extension and the Codex CLI - they share the
  // same config file. We handle this separately because it uses TOML, not JSON.

  if (client === 'codex') {
    if (!apiKey) {
      console.log('\nWhat Next - MCP installer (Codex)\n');
      apiKey = await prompt('Your What Next API key (from your welcome email): ');
    }

    if (!apiKey || !apiKey.startsWith('bak_')) {
      console.error('\nAPI key should start with "bak_" - check your welcome email.\n');
      process.exit(1);
    }

    const configPath = join(H, '.codex', 'config.toml');

    // Use the currently-running node binary - guaranteed to be the right version.
    // On Windows TOML strings need backslashes doubled.
    const nodeExec = process.execPath.replace(/\\/g, '\\\\');
    const block = [
      '[mcp_servers.what-next]',
      `command = "${nodeExec}"`,
      `args = ["${join(ROOT, 'bin', 'bootstrap-entry.js').replace(/\\/g, '\\\\')}", "src/server.js", "mcp"]`,
      'tool_timeout_sec = 20',
      '',
      '[mcp_servers.what-next.env]',
      'WHATNEXT_PREFER_LOCAL = "1"',
      'WHATNEXT_CLOUD_SYNC_MODE = "background"',
      'WHATNEXT_BOOT_RETRIES = "12"',
      'WHATNEXT_BOOT_DELAY_MS = "750"',
      'WHATNEXT_CLOUD_URL = "https://what-next-production.up.railway.app"',
      `WHATNEXT_API_KEY = "${apiKey}"`,
    ].join('\n');

    const content = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';

    mkdirSync(dirname(configPath), { recursive: true });
    const backup = backupFile(configPath);
    writeFileSync(configPath, spliceCodexToml(content, block));

    console.log('\nWhat Next added to Codex');
    console.log(`  Config: ${configPath}`);
    reportBackup(backup);
    console.log('\nRestart VS Code (or open a new Codex CLI session), then try:');
    console.log('  get_context');
    console.log('  dump_session');
    console.log('  search_memories "your query"\n');
    process.exit(0);
  }

  // ─── Config file paths per client per platform ───────────────────────────────
  if (!resolveConfigPath(client, process.platform, H, process.env.APPDATA, process.env.XDG_CONFIG_HOME)) {
    console.error(`\nUnknown client: "${client}"`);
    console.error('Supported: claude, vscode, copilot, cursor, windsurf, codex, openclaw\n');
    process.exit(1);
  }

  const platform = process.platform;
  const configPath = resolveConfigPath(client, platform, H, process.env.APPDATA, process.env.XDG_CONFIG_HOME);

  // ─── Collect API key ─────────────────────────────────────────────────────────

  if (!apiKey) {
    console.log('\nWhat Next - MCP installer\n');
    apiKey = await prompt('Your What Next API key (from your welcome email): ');
  }

  if (!apiKey || !apiKey.startsWith('bak_')) {
    console.error('\nAPI key should start with "bak_" - check your welcome email.\n');
    process.exit(1);
  }

  // ─── Build the server entry ──────────────────────────────────────────────────

  // VS Code / Copilot use "servers" key; everything else uses "mcpServers"
  const isVscode = isVscodeLikeClient(client);
  const serverKey = isVscode ? 'servers' : 'mcpServers';

  const serverEntry = {
    command: process.execPath,
    args: [join(ROOT, 'bin', 'bootstrap-entry.js'), 'src/server.js', 'mcp'],
    env: {
      WHATNEXT_PREFER_LOCAL: '1',
      WHATNEXT_CLOUD_SYNC_MODE: 'background',
      WHATNEXT_BOOT_RETRIES: '12',
      WHATNEXT_BOOT_DELAY_MS: '750',
      WHATNEXT_API_KEY: apiKey,
      WHATNEXT_CLOUD_URL: CLOUD_URL,
    },
  };

  // ─── Read, patch, write ──────────────────────────────────────────────────────

  let config = {};
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch {
      console.error(`\nCould not parse existing config at:\n  ${configPath}\n`);
      console.error('Fix the JSON or delete the file and retry.\n');
      process.exit(1);
    }
  }

  config[serverKey] ??= {};
  config[serverKey]['what-next'] = serverEntry;

  mkdirSync(dirname(configPath), { recursive: true });
  const backup = backupFile(configPath);
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

  // ─── Done ────────────────────────────────────────────────────────────────────

  console.log(`\nWhat Next added to ${client}`);
  console.log(`  Config: ${configPath}`);
  reportBackup(backup);
  console.log('\nRestart your AI tool, then try:');
  console.log('  get_context');
  console.log('  dump_session');
  console.log('  search_memories "your query"\n');

  if (platform === 'win32') {
    const apiPath = join(ROOT, 'bin', 'local-api.js').replace(/\\/g, '\\\\');
    console.log('Windows tip (optional local web UI/API):');
    console.log(`  node "${apiPath}"`);
    console.log('To keep it always-on, create a Task Scheduler task:');
    console.log('  Program/script: node');
    console.log(`  Add arguments: ${apiPath}\n`);
  } else if (platform === 'darwin') {
    setupMacOSLaunchAgent(apiKey);
  } else {
    const apiPath = join(ROOT, 'bin', 'local-api.js');
    console.log('Linux notes:');
    console.log(`  Config written to: ${configPath}`);
    if (client === 'claude') {
      console.log('  Claude Desktop on Linux: restart Claude completely for the MCP server to appear.');
      console.log('  If the tool list is still empty, verify your Claude Desktop config path:');
      console.log('    cat "' + configPath + '"');
      console.log('  Some Linux builds use a different path. If yours differs, set XDG_CONFIG_HOME:');
      console.log('    XDG_CONFIG_HOME=/your/path node bin/install.js --client claude --key ' + apiKey);
    }
    console.log('\nOptional local web UI/API:');
    console.log(`  node ${apiPath}`);
    setupSystemdUserService(apiKey);
  }
}

// ─── macOS LaunchAgent setup ─────────────────────────────────────────────────
// Writes com.whatnextai.api.plist to ~/Library/LaunchAgents/ and loads it so
// the REST API starts on every login and auto-restarts on crash.
// Safe to re-run: unloads the old service before rewriting the plist.

function setupMacOSLaunchAgent(key) {
  const nodeExec = process.execPath;
  const launchAgentsDir = join(H, 'Library', 'LaunchAgents');
  const logsDir = join(H, 'Library', 'Logs', 'what-next');
  const plistPath = join(launchAgentsDir, 'com.whatnextai.api.plist');
  const startScript = join(ROOT, 'start-api.sh');
  const bootstrapEntry = join(ROOT, 'bin', 'bootstrap-entry.js');

  // Use start-api.sh if it exists (includes self-heal steps), else fall back to bootstrap-entry.js
  const useStartScript = existsSync(startScript);
  const programArgs = useStartScript
    ? ['/bin/zsh', startScript]
    : [nodeExec, bootstrapEntry, 'src/api-server.js', 'api'];

  const plistXml = buildPlist({ programArgs, logsDir, root: ROOT, home: H, cloudUrl: CLOUD_URL, key });

  try {
    mkdirSync(launchAgentsDir, { recursive: true });
    mkdirSync(logsDir, { recursive: true });

    // Unload existing service gracefully before rewriting plist
    if (existsSync(plistPath)) {
      try {
        execFileSync('launchctl', ['unload', plistPath], { stdio: 'ignore' });
      } catch {
        // Not loaded - that's fine
      }
    }

    // Backup kept outside LaunchAgents so launchd never loads a second copy.
    const backup = backupFile(plistPath, { backupDir: join(H, '.whatnext', 'backups') });
    writeFileSync(plistPath, plistXml);

    // Load and start the service
    execFileSync('launchctl', ['load', plistPath]);

    console.log('\nWhat Next REST API configured as a macOS LaunchAgent');
    console.log(`  Plist:  ${plistPath}`);
    reportBackup(backup);
    console.log(`  Logs:   ${logsDir}/`);
    console.log('  Port:   http://localhost:3747');
    console.log('  Status: launchctl list com.whatnextai.api');
    console.log('  Start:  launchctl start com.whatnextai.api');
    console.log('  Stop:   launchctl stop com.whatnextai.api\n');
  } catch (err) {
    console.error('\nLaunchAgent setup failed:', err.message);
    console.error('To set it up manually:');
    console.error(`  launchctl load "${plistPath}"\n`);
  }
}

// ─── Linux systemd user service ──────────────────────────────────────────────
// Writes ~/.config/systemd/user/what-next-api.service. Does not start it: the
// local API is optional on Linux, so the user enables it with one command.

function setupSystemdUserService(key) {
  const unitDir = join(process.env.XDG_CONFIG_HOME || join(H, '.config'), 'systemd', 'user');
  const unitPath = join(unitDir, 'what-next-api.service');
  try {
    const unit = buildSystemdUnit({ nodeExec: process.execPath, root: ROOT, cloudUrl: CLOUD_URL, key });
    mkdirSync(unitDir, { recursive: true });
    const backup = backupFile(unitPath);
    writeFileSync(unitPath, unit, { mode: 0o600 });
    chmodSync(unitPath, 0o600);
    spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
    console.log(`  systemd user unit written: ${unitPath}`);
    reportBackup(backup);
    console.log('For always-on (starts now and on every login):');
    console.log('  systemctl --user enable --now what-next-api\n');
  } catch (err) {
    console.error(`  Could not write systemd unit (${err.message}). Run the API manually with the command above.\n`);
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) await main();
