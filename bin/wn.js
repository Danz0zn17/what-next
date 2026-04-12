#!/usr/bin/env node
/**
 * wn — What Next CLI
 *
 * Talks to the local REST API at localhost:3747.
 * Start the local service first: launchctl start com.whatnextai.api
 *
 * Usage:
 *   wn context                          — dump full context (projects + sessions + facts)
 *   wn next                             — open next steps across all projects
 *   wn projects                         — list all projects
 *   wn project <name>                   — full history for one project
 *   wn search <query>                   — hybrid search across all memories
 *   wn dump                             — interactive session dump (prompts for fields)
 *   wn fact                             — interactive fact store
 *   wn install --client <x> --key <k>   — run the MCP installer
 *   wn open                             — open the web UI in your browser
 *   wn status                           — health check for local + cloud services
 */

import { createInterface } from 'readline';
import { spawnSync } from 'child_process';
import { basename } from 'path';

const BASE = 'http://localhost:3747';
const PORT = 3747;
const VERSION = '1.5.1';

// ─── Colours ──────────────────────────────────────────────────────────────────
const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  red:    '\x1b[31m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  blue:   '\x1b[34m',
  magenta:'\x1b[35m',
  cyan:   '\x1b[36m',
  white:  '\x1b[37m',
};

const col  = (color, text) => `${c[color]}${text}${c.reset}`;
const bold = (text) => `${c.bold}${text}${c.reset}`;
const dim  = (text) => `${c.dim}${text}${c.reset}`;

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, opts);
  } catch {
    console.error(col('red', `\nCannot reach What Next at ${BASE}.`));
    console.error(dim('  Start it with: launchctl start com.whatnextai.api'));
    console.error(dim('  Or:            node ~/what-next/src/api-server.js\n'));
    process.exit(1);
  }
  const text = await res.text();
  try {
    return { ok: res.ok, status: res.status, data: JSON.parse(text) };
  } catch {
    return { ok: res.ok, status: res.status, data: text };
  }
}

async function get(path)         { return api(path); }
async function post(path, body)  { return api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }

// ─── Prompt helper ────────────────────────────────────────────────────────────

async function prompt(question, required = false) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    const ask = () => {
      rl.question(question, answer => {
        const val = answer.trim();
        if (required && !val) {
          process.stdout.write(col('yellow', '  (required) '));
          ask();
        } else {
          rl.close();
          resolve(val);
        }
      });
    };
    ask();
  });
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function printSession(s, idx) {
  const date = s.session_date ?? s.created_at?.slice(0, 10) ?? '';
  const project = s.project_name ?? s.project ?? '';
  console.log(`\n${bold(col('cyan', `[${idx ?? ''}] ${project}`))} ${dim(date)}`);
  console.log(`  ${s.summary}`);
  if (s.stack)      console.log(dim(`  Stack: ${s.stack}`));
  if (s.next_steps) console.log(col('yellow', `  Next:  ${s.next_steps}`));
  if (s.tags)       console.log(dim(`  Tags:  ${s.tags}`));
}

function printFact(f) {
  const project = f.project_name ?? f.project ?? 'global';
  console.log(`\n${bold(col('magenta', f.category))} ${dim(`[${project}]`)}`);
  console.log(`  ${f.content}`);
}

function printProject(p) {
  console.log(`  ${bold(p.name)}  ${dim(`${p.session_count ?? 0} session(s) · last: ${p.last_session ?? 'never'}`)}`);
}

// ─── Commands ─────────────────────────────────────────────────────────────────

async function cmdContext() {
  const { ok, data } = await get('/context');
  if (!ok) { console.error(col('red', 'Failed to fetch context.'), data); process.exit(1); }

  const sessions = data.sessions ?? [];
  const facts    = data.facts    ?? [];

  console.log(`\n${bold('=== What Next — Full Context ===')}`);
  console.log(dim(`  ${sessions.length} session(s)   ${facts.length} fact(s)\n`));

  if (sessions.length) {
    console.log(bold('Recent sessions:'));
    sessions.slice(0, 10).forEach((s, i) => printSession(s, i + 1));
  }

  if (facts.length) {
    console.log(`\n${bold('Facts:')}`);
    facts.forEach(printFact);
  }

  console.log('');
}

async function cmdNext() {
  const { ok, data } = await get('/whats-next');
  if (!ok) { console.error(col('red', 'Failed to fetch next steps.'), data); process.exit(1); }

  const items = Array.isArray(data) ? data : (data.items ?? []);
  if (!items.length) {
    console.log(dim('\nNo open next steps found.\n'));
    return;
  }

  console.log(`\n${bold('=== Open Next Steps ===')}\n`);
  for (const item of items) {
    const project = item.project_name ?? item.project ?? '';
    const date    = item.session_date ?? item.created_at?.slice(0, 10) ?? '';
    console.log(`${bold(col('cyan', project))} ${dim(date)}`);
    console.log(`  ${col('yellow', item.next_steps)}\n`);
  }
}

async function cmdProjects() {
  const { ok, data } = await get('/projects');
  if (!ok) { console.error(col('red', 'Failed to fetch projects.'), data); process.exit(1); }

  const projects = Array.isArray(data) ? data : [];
  if (!projects.length) {
    console.log(dim('\nNo projects yet. Dump a session first.\n'));
    return;
  }

  console.log(`\n${bold('=== Projects ===')}\n`);
  projects.forEach(printProject);
  console.log('');
}

async function cmdProject(name) {
  if (!name) { console.error(col('red', 'Usage: wn project <name>')); process.exit(1); }
  const { ok, data } = await get(`/project/${encodeURIComponent(name)}`);
  if (!ok) { console.error(col('red', `Project "${name}" not found.`), data); process.exit(1); }

  const sessions = data.sessions ?? (Array.isArray(data) ? data : [data]);
  console.log(`\n${bold(`=== Project: ${name} ===`)} ${dim(`${sessions.length} session(s)`)}\n`);
  sessions.forEach((s, i) => printSession(s, i + 1));
  console.log('');
}

async function cmdSearch(query) {
  if (!query) { console.error(col('red', 'Usage: wn search <query>')); process.exit(1); }
  const { ok, data } = await get(`/hybrid-search?q=${encodeURIComponent(query)}&limit=10`);
  if (!ok) { console.error(col('red', 'Search failed.'), data); process.exit(1); }

  // /hybrid-search returns { results: [...], source: '...' }
  const results = data.results ?? [];

  console.log(`\n${bold(`=== Search: "${query}" ===`)}`);

  if (!results.length) {
    console.log(dim('\nNo results found.\n'));
    return;
  }

  results.forEach((s, i) => printSession(s, i + 1));
  console.log('');
}

async function cmdDump() {
  console.log(`\n${bold('=== Dump Session to What Next ===')}\n`);
  console.log(dim('  Leave optional fields blank to skip.\n'));

  const gitDetect   = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', cwd: process.cwd() });
  const gitDefault   = gitDetect.status === 0 ? basename(gitDetect.stdout.trim()) : '';
  const projectHint  = gitDefault ? bold(`Project name [${gitDefault}]: `) : bold('Project name: ');
  const projectInput = await prompt(projectHint, !gitDefault);
  const project      = projectInput || gitDefault;
  if (!project) { console.error(col('red', 'Project name is required.')); process.exit(1); }
  const summary      = await prompt(bold('Summary: '),      true);
  const what_built   = await prompt(dim('What was built: '));
  const decisions    = await prompt(dim('Key decisions: '));
  const stack        = await prompt(dim('Stack / technologies: '));
  const next_steps   = await prompt(dim('Next steps: '));
  const tags         = await prompt(dim('Tags (comma-separated): '));

  const body = { project, summary };
  if (what_built) body.what_was_built = what_built;
  if (decisions)  body.decisions      = decisions;
  if (stack)      body.stack          = stack;
  if (next_steps) body.next_steps     = next_steps;
  if (tags)       body.tags           = tags;

  const { ok, data } = await post('/session', body);
  if (ok) {
    console.log(col('green', `\n✓ Session saved (id: ${data.id})\n`));
  } else {
    console.error(col('red', '\nFailed to save session.'), data);
    process.exit(1);
  }
}

async function cmdFact(content) {
  if (content) {
    // wn fact "some content" — non-interactive
    const { ok, data } = await post('/fact', { content });
    if (ok) { console.log(col('green', `\n✓ Fact stored\n`)); }
    else { console.error(col('red', 'Failed to store fact.'), data); process.exit(1); }
    return;
  }

  console.log(`\n${bold('=== Add Fact to What Next ===')}`);;

  const factContent = await prompt(bold('Content: '), true);
  const category    = await prompt(dim('Category (optional, e.g. preference, lesson): '));
  const project     = await prompt(dim('Project (leave blank for global): '));
  const tags        = await prompt(dim('Tags (comma-separated): '));

  const body = { content: factContent };
  if (category) body.category = category;
  if (project)  body.project  = project;
  if (tags)     body.tags     = tags;

  const { ok, data } = await post('/fact', body);
  if (ok) {
    console.log(col('green', `\n✓ Fact stored\n`));
  } else {
    console.error(col('red', '\nFailed to store fact.'), data);
    process.exit(1);
  }
}

async function cmdStatus() {
  console.log(`\n${bold('=== What Next Status ===')}\n`);

  // Local
  const local = await get('/health').catch(() => null);
  if (local?.ok) {
    console.log(col('green', '  ✓ Local API') + dim('  localhost:3747'));
  } else {
    console.log(col('red', '  ✗ Local API down') + dim(`  start: launchctl start com.whatnextai.api`));
  }

  // Sync status
  const sync = await get('/sync/status').catch(() => null);
  if (sync?.data?.last_cloud_sync) {
    const ago = Math.round((Date.now() - new Date(sync.data.last_cloud_sync)) / 60000);
    console.log(col('green', '  ✓ Cloud sync') + dim(`  last: ${ago}m ago`));
  } else {
    console.log(col('yellow', '  ~ Cloud sync') + dim('  no sync data'));
  }

  console.log('');
}

async function cmdOpen() {
  const url = `http://localhost:${PORT}`;
  try {
    const platform = process.platform;
    const openCmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open';
    spawnSync(openCmd, [url], { stdio: 'ignore' });
    console.log(dim(`  Opened ${url}\n`));
  } catch {
    console.log(`  Open manually: ${col('cyan', url)}\n`);
  }
}

function cmdInstall(args) {
  // Delegate to the existing installer — spawnSync preserves stdio cleanly
  const installPath = new URL('./install.js', import.meta.url).pathname;
  const result = spawnSync(process.execPath, [installPath, ...args], { stdio: 'inherit' });
  process.exit(result.status ?? 0);
}

function printHelp() {
  console.log(`
${bold('wn')} — What Next CLI  ${dim('(localhost:3747)')}

${bold('Commands:')}
  ${col('cyan', 'wn context')}                     Full context: recent sessions + facts
  ${col('cyan', 'wn next')}                        Open next steps across all projects
  ${col('cyan', 'wn projects')}                    List all projects
  ${col('cyan', 'wn project')} ${col('yellow', '<name>')}             Full history for one project
  ${col('cyan', 'wn search')} ${col('yellow', '<query>')}             Hybrid search across all memories
  ${col('cyan', 'wn dump')}                        Interactive session dump
  ${col('cyan', 'wn fact')}                        Interactive fact store
  ${col('cyan', 'wn status')}                      Health check: local + cloud
  ${col('cyan', 'wn open')}                        Open web UI in browser
  ${col('cyan', 'wn install')} ${col('yellow', '--client <x> --key <k>')}  Run MCP installer

${bold('Examples:')}
  wn search "supabase auth"
  wn project what-next
  wn dump
  wn install --client codex --key bak_xxx

${bold('Local service not running?')}
  macOS:   ${dim('launchctl start com.whatnextai.api')}
  Other:   ${dim('node ~/what-next/src/api-server.js')}
`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const [,, cmd, ...rest] = process.argv;

switch (cmd) {
  case 'context':  await cmdContext();            break;
  case 'next':     await cmdNext();               break;
  case 'projects': await cmdProjects();           break;
  case 'project':  await cmdProject(rest[0]);     break;
  case 'search':   await cmdSearch(rest.join(' ')); break;
  case 'dump':     await cmdDump();               break;
  case 'fact':     await cmdFact();               break;
  case 'status':   await cmdStatus();             break;
  case 'open':     await cmdOpen();               break;
  case 'install':  cmdInstall(rest);              break;
  case '--version': case '-v': case 'version':   console.log(`wn v${VERSION}`); break;
  case '--help':
  case '-h':
  case 'help':
  case undefined:  printHelp();                   break;
  default:
    console.error(col('red', `\nUnknown command: ${cmd}`));
    printHelp();
    process.exit(1);
}
