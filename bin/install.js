#!/usr/bin/env node
/**
 * What Next — MCP config installer
 *
 * Patches your AI tool's MCP config to add What Next in one command.
 *
 * Usage:
 *   node bin/install.js --client claude --key bak_xxx
 *   node bin/install.js --client vscode  --key bak_xxx
 *   node bin/install.js --client cursor  --key bak_xxx
 *
 * Supported clients: claude, vscode, copilot, cursor, windsurf
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { homedir } from 'os';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(join(__dirname, '..'));
const CLOUD_URL = 'https://what-next-production.up.railway.app';

// ─── Argument parsing ────────────────────────────────────────────────────────

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : null;
}

const client = (arg('--client') ?? 'claude').toLowerCase();
let apiKey = arg('--key');

// ─── Config file paths per client per platform ───────────────────────────────

const H = homedir();
const APPDATA = process.env.APPDATA ?? join(H, 'AppData', 'Roaming');

const CONFIG_PATHS = {
  claude: {
    darwin: join(H, 'Library/Application Support/Claude/claude_desktop_config.json'),
    linux:  join(H, '.config/Claude/claude_desktop_config.json'),
    win32:  join(APPDATA, 'Claude/claude_desktop_config.json'),
  },
  vscode: {
    darwin: join(H, 'Library/Application Support/Code/User/mcp.json'),
    linux:  join(H, '.config/Code/User/mcp.json'),
    win32:  join(APPDATA, 'Code/User/mcp.json'),
  },
  copilot: {
    darwin: join(H, 'Library/Application Support/Code/User/mcp.json'),
    linux:  join(H, '.config/Code/User/mcp.json'),
    win32:  join(APPDATA, 'Code/User/mcp.json'),
  },
  cursor: {
    darwin: join(H, '.cursor/mcp.json'),
    linux:  join(H, '.cursor/mcp.json'),
    win32:  join(H, '.cursor/mcp.json'),
  },
  windsurf: {
    darwin: join(H, '.codeium/windsurf/mcp_config.json'),
    linux:  join(H, '.codeium/windsurf/mcp_config.json'),
    win32:  join(H, '.codeium/windsurf/mcp_config.json'),
  },
};

const paths = CONFIG_PATHS[client];
if (!paths) {
  console.error(`\nUnknown client: "${client}"`);
  console.error(`Supported: ${Object.keys(CONFIG_PATHS).join(', ')}\n`);
  process.exit(1);
}

const platform = process.platform;
const configPath = paths[platform] ?? paths.linux;

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
const isVscode = ['vscode', 'copilot'].includes(client);
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
