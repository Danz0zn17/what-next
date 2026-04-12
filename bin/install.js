#!/usr/bin/env node
/**
 * What Next — MCP config installer
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
 * Codex CLI agent — both read ~/.codex/config.toml for MCP servers.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { homedir } from 'os';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';
import { resolveConfigPath, isVscodeLikeClient } from '../src/platform-config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(join(__dirname, '..'));
const CLOUD_URL = 'https://what-next-production.up.railway.app';
const H = homedir();

// ─── Argument parsing ────────────────────────────────────────────────────────

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : null;
}

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
  copyFileSync(skillSrc, skillDest);
  console.log('\nWhat Next skill installed for OpenClaw');
  console.log(`  Skill: ${skillDest}`);
  console.log('\nStart a new OpenClaw session and try:');
  console.log('  /what_next or just ask about a project\n');
  process.exit(0);
}

// ─── Codex: TOML config (~/.codex/config.toml) ──────────────────────────────
// Covers both the VS Code Codex extension and the Codex CLI — they share the
// same config file. We handle this separately because it uses TOML, not JSON.

if (client === 'codex') {
  if (!apiKey) {
    console.log('\nWhat Next — MCP installer (Codex)\n');
    apiKey = await prompt('Your What Next API key (from your welcome email): ');
  }

  if (!apiKey || !apiKey.startsWith('bak_')) {
    console.error('\nAPI key should start with "bak_" — check your welcome email.\n');
    process.exit(1);
  }

  const configPath = join(H, '.codex', 'config.toml');

  // Use the currently-running node binary — guaranteed to be the right version.
  // On Windows TOML strings need backslashes doubled.
  const nodeExec = process.execPath.replace(/\\/g, '\\\\');
  const serverPath = join(ROOT, 'src', 'server.js').replace(/\\/g, '\\\\');

  const block = [
    '[mcp_servers.what-next]',
    `command = "${nodeExec}"`,
    `args = ["${serverPath}"]`,
    'tool_timeout_sec = 20',
    '',
    '[mcp_servers.what-next.env]',
    'WHATNEXT_CLOUD_URL = "https://what-next-production.up.railway.app"',
    `WHATNEXT_API_KEY = "${apiKey}"`,
  ].join('\n');

  let content = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';

  if (content.includes('[mcp_servers.what-next]')) {
    // Remove the existing section (header + all sub-keys) then re-append.
    // This handles re-runs and key updates without touching the rest of the file.
    const lines = content.split('\n');
    const start = lines.findIndex(l => l.startsWith('[mcp_servers.what-next]'));
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      // Stop at the next top-level section that isn't a sub-key of this one
      if (lines[i].startsWith('[') && !lines[i].startsWith('[mcp_servers.what-next.')) {
        end = i;
        break;
      }
    }
    const trimmed = [...lines.slice(0, start), ...lines.slice(end)].join('\n').trimEnd();
    content = trimmed ? trimmed + '\n\n' : '';
  } else {
    content = content.trimEnd() ? content.trimEnd() + '\n\n' : '';
  }

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, content + block + '\n');

  console.log('\nWhat Next added to Codex');
  console.log(`  Config: ${configPath}`);
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

// ─── Prompt helper ───────────────────────────────────────────────────────────

async function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer.trim()); }));
}

// ─── Collect API key ─────────────────────────────────────────────────────────

if (!apiKey) {
  console.log('\nWhat Next — MCP installer\n');
  apiKey = await prompt('Your What Next API key (from your welcome email): ');
}

if (!apiKey || !apiKey.startsWith('bak_')) {
  console.error('\nAPI key should start with "bak_" — check your welcome email.\n');
  process.exit(1);
}

// ─── Build the server entry ──────────────────────────────────────────────────

// VS Code / Copilot use "servers" key; everything else uses "mcpServers"
const isVscode = isVscodeLikeClient(client);
const serverKey = isVscode ? 'servers' : 'mcpServers';

const serverEntry = {
  command: 'node',
  args: [join(ROOT, 'src/server.js')],
  env: {
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
writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

// ─── Done ────────────────────────────────────────────────────────────────────

console.log(`\nWhat Next added to ${client}`);
console.log(`  Config: ${configPath}`);
console.log('\nRestart your AI tool, then try:');
console.log('  get_context');
console.log('  dump_session');
console.log('  search_memories "your query"\n');

if (platform === 'win32') {
  const apiPath = join(ROOT, 'src/api-server.js').replace(/\\/g, '\\\\');
  console.log('Windows tip (optional local web UI/API):');
  console.log(`  node "${apiPath}"`);
  console.log('To keep it always-on, create a Task Scheduler task:');
  console.log('  Program/script: node');
  console.log(`  Add arguments: ${apiPath}\n`);
} else if (platform === 'darwin') {
  console.log('macOS tip (optional local web UI/API):');
  console.log('  launchctl start com.whatnextai.api\n');
} else {
  const apiPath = join(ROOT, 'src/api-server.js');
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
  console.log('For always-on, add it to a user systemd service:');
  console.log('  systemctl --user enable --now what-next-api\n');
}
