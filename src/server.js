import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { sanitizeFields, neutralize, DATA_NOTICE, SESSION_TEXT_FIELDS, FACT_TEXT_FIELDS } from './sanitize.js';
import { addSession, addFact, editSession, searchMemories, getProject, listProjects, getAllEmbeddings, getSessionById, getFactById, getRecentSessions, getRecentSessionsForProject, getAllFacts, getWhatsNext, upsertProjectIntelligence, getProjectIntelligence, getLastSession, getCommitsSince, setSessionCloudId, setFactCloudId } from './db.js';
import { parseTimeRange, inRange } from './timeparse.js';
import { writeSidecarForProject, writeGlobalContext } from './sidecar.js';
import { generateEmbedding, cosineSimilarity, warmEmbedder } from './embeddings.js';
import { indexSession, indexFact } from './indexer.js';
import { runCuration } from './curator.js';
import * as cloud from './cloud-client.js';
import { CloudUnavailableError } from './cloud-client.js';
import { syncPending, dumpToGist } from './gist-client.js';
import { buildUpdateNotice } from './update-check.js';

const server = new McpServer({
  name: 'what-next',
  version: '2.3.0',
});

// ─── Tool timeout + error logging helpers ─────────────────────────────────────
const TOOL_TIMEOUT_MS = 15_000;
const AUDIT_LOG_DIR = process.env.WHATNEXT_AUDIT_LOG_DIR
  || (process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Logs', 'what-next')
    : join(homedir(), '.what-next', 'logs'));
const MCP_AUDIT_LOG_FILE = join(AUDIT_LOG_DIR, 'mcp-audit.log');

try {
  mkdirSync(AUDIT_LOG_DIR, { recursive: true });
} catch {
  // Logging must never block MCP startup.
}

function log(level, toolName, message) {
  const ts = new Date().toISOString();
  const line = `[what-next MCP] ${ts} [${level}] ${toolName}: ${message}\n`;
  process.stderr.write(line);
  try {
    appendFileSync(MCP_AUDIT_LOG_FILE, line);
  } catch {
    // Ignore audit-log write failures so tooling never breaks on logging.
  }
}

function logAudit(toolName, message) {
  log('INFO', toolName, message);
}

function syncSessionInBackground(args, localId) {
  if (!cloud.isEnabled()) return;
  setImmediate(async () => {
    try {
      const res = await cloud.postSession(args);
      if (res?.id) setSessionCloudId(localId, res.id);
      logAudit('dump_session', `cloud sync ok for local session ${localId}`);
    } catch (err) {
      if (err instanceof CloudUnavailableError) {
        log('WARN', 'dump_session', `cloud unavailable for local session ${localId}; queued gist fallback`);
        dumpToGist(args).catch((gistErr) => {
          log('ERROR', 'dump_session', `gist fallback failed for local session ${localId}: ${gistErr.message}`);
        });
        return;
      }
      log('ERROR', 'dump_session', `cloud sync failed for local session ${localId}: ${err.message}`);
    }
  });
}

function syncFactInBackground(args, localId) {
  if (!cloud.isEnabled()) return;
  setImmediate(async () => {
    try {
      const res = await cloud.postFact(args);
      if (res?.id) setFactCloudId(localId, res.id);
      logAudit('add_fact', `cloud sync ok for local fact ${localId}`);
    } catch (err) {
      if (err instanceof CloudUnavailableError) {
        log('WARN', 'add_fact', `cloud unavailable for local fact ${localId}`);
        return;
      }
      log('ERROR', 'add_fact', `cloud sync failed for local fact ${localId}: ${err.message}`);
    }
  });
}

const WRITE_TOOLS = new Set(['dump_session', 'add_fact', 'edit_session', 'update_project_intelligence']);

// Says only what is known about the local write when a tool fails.
function failureNote(toolName, wrote) {
  if (wrote) return `The local write completed before the failure (${wrote}); retrying would save it twice.`;
  if (toolName === 'curate_memory') return 'Curation was stopped; nothing further is archived after the stop, and archived facts are recoverable by ID.';
  if (WRITE_TOOLS.has(toolName)) return 'The local write was not confirmed. Check with search_memories before retrying.';
  return 'Nothing was changed.';
}

// Handlers get (args, ctx). ctx.signal aborts when the tool times out or the
// client cancels, so long work (curation) stops instead of running on after a
// failure is reported. Write handlers set ctx.wrote once the local row exists.
function withTimeout(toolName, handlerFn) {
  return async (args, extra) => {
    const start = Date.now();
    const controller = new AbortController();
    const onCancel = () => controller.abort();
    extra?.signal?.addEventListener?.('abort', onCancel, { once: true });
    const ctx = { signal: controller.signal, wrote: null };
    let timeoutId;
    const timer = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        reject(new Error(`Tool timed out after ${TOOL_TIMEOUT_MS}ms`));
      }, TOOL_TIMEOUT_MS);
    });
    try {
      const result = await Promise.race([handlerFn(args, ctx), timer]);
      const elapsed = Date.now() - start;
      if (elapsed > 3_000) log('WARN', toolName, `slow response: ${elapsed}ms`);
      return result;
    } catch (err) {
      controller.abort();
      log('ERROR', toolName, err.message);
      return {
        content: [{
          type: 'text',
          text: `[what-next] ⚠️ ${toolName} failed: ${err.message}\n\nThe MCP server is running but encountered an error. ${failureNote(toolName, ctx.wrote)} You can retry or use the REST API at http://localhost:3747`,
        }],
      };
    } finally {
      clearTimeout(timeoutId);
      extra?.signal?.removeEventListener?.('abort', onCancel);
    }
  };
}

// Project names become card filenames: no path separators, no "..".
const projectName = z.string().min(1).max(100).regex(/^(?!.*\.\.)[^/\\]+$/, 'no path separators or ".."');

// Everything the read tools return is recalled memory, some of it from the
// cloud, so it is escaped the same way the cards are and labelled as data.
function memoryResult(lines) {
  const body = Array.isArray(lines) ? lines.join('\n') : String(lines);
  return { content: [{ type: 'text', text: `${DATA_NOTICE}\n\n${neutralize(body).text}` }] };
}

// WHATNEXT_PREFER_LOCAL=1 (set by the installer): read tools answer from local
// SQLite and ask the cloud only when local has nothing. Otherwise the cloud is
// asked first and local answers when it is unreachable or has nothing (a 404
// for a project that only exists locally included).
const PREFER_LOCAL = process.env.WHATNEXT_PREFER_LOCAL === '1';

async function readMemory({ local, remote, isEmpty }) {
  const fromCloud = async () => {
    try {
      return await remote();
    } catch (err) {
      if (err instanceof CloudUnavailableError || err?.statusCode === 404) return undefined;
      throw err;
    }
  };
  if (!cloud.isEnabled()) return { data: local(), source: 'local' };
  if (PREFER_LOCAL) {
    const data = local();
    if (!isEmpty(data)) return { data, source: 'local' };
    const cloudData = await fromCloud().catch(() => undefined);
    return cloudData !== undefined && !isEmpty(cloudData) ? { data: cloudData, source: 'cloud' } : { data, source: 'local' };
  }
  const cloudData = await fromCloud();
  if (cloudData !== undefined && !isEmpty(cloudData)) return { data: cloudData, source: 'cloud' };
  return { data: local(), source: 'local' };
}

// ─── Startup: sync any pending gists to cloud ─────────────────────────────────
if (cloud.isEnabled()) {
  cloud.isReachable().then(reachable => {
    if (reachable) {
      syncPending().catch(() => {});
    }
  });
}

// ─── Startup: non-blocking update check ───────────────────────────────────────
// Fetches the latest GitHub release tag and logs a notice if a newer version is
// available. Fire-and-forget — never blocks MCP startup or throws.
(async () => {
  try {
    const res = await fetch(
      'https://api.github.com/repos/Danz0zn17/what-next/releases/latest',
      { headers: { 'User-Agent': 'what-next-mcp', Accept: 'application/vnd.github+json' } }
    );
    if (!res.ok) return; // no releases yet or rate-limited — silent
    const { tag_name } = await res.json();
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    const local = req('../package.json').version ?? '1.0.0';
    const notice = buildUpdateNotice(local, tag_name);
    if (notice) process.stderr.write(notice);
  } catch {
    // network unavailable — silently skip
  }
})();

// Stored memory is replayed into the system context of later sessions, so text
// that reads as an instruction is escaped (harness tags) or flagged (override
// phrasing) on the way in. Nothing is dropped - this line is the trail.
function injectionNote(flags) {
  if (!flags || flags.length === 0) return '';
  return `\n\nNote: this text tripped the stored-memory injection check [${flags.join(', ')}]. It is saved in full; harness tags are escaped so it cannot impersonate the harness when replayed. Review the full list at GET http://localhost:3747/flagged if it was not written by you.`;
}

// ─── TOOL: dump_session ───────────────────────────────────────────────────────
server.tool(
  'dump_session',
  "Save what this session did: summary, what was built, decisions, next steps. Call at every milestone and at session end. Updates the project context card automatically.",
  {
    project: projectName.describe('Project name (matches your folder name in ~/projects/)'),
    summary: z.string().describe('A concise summary of what happened this session'),
    what_was_built: z.string().optional().describe('Specific features, files, or components built'),
    decisions: z.string().optional().describe('Key architectural or design decisions made'),
    stack: z.string().optional().describe('Technologies, libraries, and tools used'),
    next_steps: z.string().optional().describe('What to pick up next session'),
    tags: z.string().optional().describe('Comma-separated tags e.g. "react,auth,api,bug-fix"'),
  },
  withTimeout('dump_session', async (args, ctx) => {
    const id = addSession(args);
    ctx.wrote = `local session ${id}`;
    // The row is stored either way; this only tells the caller that its text
    // read as an instruction and has been escaped or flagged. See sanitize.js.
    const { flags } = sanitizeFields(args, SESSION_TEXT_FIELDS);
    indexSession(id, args);
    logAudit('dump_session', `local write complete for session ${id} (${args.project})`);

    syncSessionInBackground(args, id);
    const sourceLabel = cloud.isEnabled() ? 'local, cloud sync queued' : 'local';

    setImmediate(() => {
      try { writeSidecarForProject(args.project); } catch {}
      try { writeGlobalContext(); } catch {}
    });

    return {
      content: [{
        type: 'text',
        text: `Session dumped [${sourceLabel}] (local id: ${id})\nProject: ${args.project}\nSummary: ${neutralize(args.summary).text}${injectionNote(flags)}`,
      }],
    };
  })
);

// ─── TOOL: get_context ───────────────────────────────────────────────────────
server.tool(
  'get_context',
  "Cross-project snapshot: active projects, recent sessions everywhere, global preferences. Use when the task spans projects or the card was not injected; for one project prefer get_orientation.",
  {
    surface: z.enum(['claude-code', 'copilot', 'codex', 'hermes', 'cursor', 'generic']).optional()
      .describe('Which AI surface is calling — shapes the response format and depth'),
  },
  withTimeout('get_context', async ({ surface } = {}) => {
    const { data: context, source } = await readMemory({
      local: () => ({
        recent_sessions: getRecentSessions(5),
        facts: getAllFacts(),
        active_projects: listProjects(),
      }),
      remote: () => cloud.getContext(),
      isEmpty: c => !c || (!c.recent_sessions?.length && !c.active_projects?.length),
    });

    const lines = [`## What Next — Session Context [${source}]\n`];

    if (context.active_projects?.length > 0) {
      lines.push('**Active Projects:**');
      for (const p of context.active_projects.slice(0, 8)) {
        const last = (p.last_session ?? '').split('T')[0] || 'never';
        lines.push(`- **${p.name}** — ${p.session_count} session(s), last active: ${last}`);
      }
      lines.push('');
    }

    if (context.recent_sessions?.length > 0) {
      lines.push('**Recent Sessions:**');
      for (const s of context.recent_sessions) {
        lines.push(`\n[${s.project_name ?? '?'}] ${(s.session_date ?? '').split('T')[0]}`);
        lines.push(s.summary);
        if (s.next_steps) lines.push(`→ Next: ${s.next_steps}`);
      }
      lines.push('');
    }

    // Hermes (mobile/Telegram): action-list only — no noise
    if (surface === 'hermes') {
      const hermes = ['## What Next — Open Actions\n'];
      for (const s of context.recent_sessions?.slice(0, 5) ?? []) {
        if (s.next_steps) hermes.push(`**${s.project_name ?? '?'}**: ${s.next_steps}`);
      }
      return memoryResult(hermes);
    }

    if (context.facts?.length > 0) {
      const globalFacts = context.facts.filter(f => !f.project_name);
      if (globalFacts.length > 0) {
        lines.push('**Global Facts & Preferences:**');
        for (const f of globalFacts.slice(0, 10)) {
          lines.push(`${f.category}: ${f.content}`);
        }
      }
    }

    return memoryResult(lines);
  })
);

// ─── TOOL: update_project_intelligence ───────────────────────────────────────
server.tool(
  'update_project_intelligence',
  "Record what an agent cannot infer from the repo: gotchas, non-obvious conventions, deployment quirks, env var names. Rendered on the project card. Do not restate the file tree.",
  {
    project: projectName.describe('Project name (matches folder name in ~/projects/)'),
    repo_path: z.string().optional().describe('Absolute path to the repo on disk'),
    stack: z.string().optional().describe('Tech stack summary e.g. "React + Vite + Supabase + Railway"'),
    key_dirs: z.string().optional().describe("Only what the tree does not make obvious: where the entry points are, which dir is generated, where the real config lives"),
    conventions: z.string().optional().describe("Rules an agent would get wrong without being told: naming, commit style, what must never be edited, required flags"),
    env_vars: z.string().optional().describe('Environment variable names (keys only, never values)'),
    deployment: z.string().optional().describe('How the app is deployed e.g. "Netlify (frontend) + Railway (backend)"'),
    extra: z.string().optional().describe("Gotchas and decisions first: things that cost a past session time. Skip anything derivable from the code."),
  },
  withTimeout('update_project_intelligence', async (args, ctx) => {
    upsertProjectIntelligence(args);
    ctx.wrote = `project intelligence for ${args.project}`;
    logAudit('update_project_intelligence', `updated for ${args.project}`);

    // The card write is local and fast; do it now so the reply is the truth.
    const card = writeSidecarForProject(args.project);
    setImmediate(() => {
      try { writeGlobalContext(); } catch {}
    });

    if (cloud.isEnabled()) {
      setImmediate(async () => {
        try { await cloud.postIntelligence(args); } catch {}
      });
    }

    return {
      content: [{
        type: 'text',
        text: card.ok
          ? `Project intelligence updated for ${args.project}. Context card written to ${card.path}${card.repo ? `\n${card.repo}` : ''}`
          : `Project intelligence updated for ${args.project}, but the context card was not written: ${card.error}`,
      }],
    };
  })
);

// ─── TOOL: get_orientation ────────────────────────────────────────────────────
server.tool(
  'get_orientation',
  "Start here for project work: stack, gotchas, last 3 sessions, open tasks, under 2000 tokens.",
  {
    project: projectName.describe('Project name to get a focused orientation brief for'),
  },
  withTimeout('get_orientation', async ({ project }) => {
    const intel = getProjectIntelligence(project);
    const sessions = getRecentSessionsForProject(project, 3);
    const whatsNext = getWhatsNext(20).find(i => i.project_name === project);
    const globalFacts = getAllFacts().filter(f => !f.project_id).slice(0, 8);

    const lines = [`# ${project} — Orientation Brief\n`];

    if (intel) {
      lines.push('## Project Map');
      if (intel.stack) lines.push(`Stack: ${intel.stack}`);
      if (intel.deployment) lines.push(`Deployment: ${intel.deployment}`);
      if (intel.repo_path) lines.push(`Repo: ${intel.repo_path}`);
      if (intel.env_vars) lines.push(`Env vars (keys): ${intel.env_vars}`);
      lines.push('');
      if (intel.key_dirs) { lines.push('## Where Things Live'); lines.push(intel.key_dirs); lines.push(''); }
      if (intel.conventions) { lines.push('## Conventions'); lines.push(intel.conventions); lines.push(''); }
      if (intel.extra) { lines.push('## Key Decisions'); lines.push(intel.extra); lines.push(''); }
    } else {
      lines.push('_No project intelligence saved yet. Call `update_project_intelligence` after exploring the codebase._\n');
    }

    if (sessions.length > 0) {
      lines.push('## Last 3 Sessions');
      for (const s of sessions) {
        lines.push(`**${(s.session_date ?? '').split('T')[0]}**: ${s.summary}`);
        if (s.what_was_built) lines.push(`Built: ${s.what_was_built}`);
        if (s.decisions) lines.push(`Decided: ${s.decisions}`);
        lines.push('');
      }
    }

    if (whatsNext?.next_steps) {
      lines.push('## Open Tasks');
      lines.push(whatsNext.next_steps);
      lines.push('');
    }

    if (globalFacts.length > 0) {
      lines.push('## Global Preferences');
      for (const f of globalFacts) lines.push(`${f.category}: ${f.content}`);
    }

    return memoryResult(lines);
  })
);

// ─── TOOL: search_memories ────────────────────────────────────────────────────
server.tool(
  'search_memories',
  "Keyword search over sessions and facts. Understands time phrases (\"auth decisions in August\", \"surf-rides last week\", \"since 2026-07-01\"): the window is applied first, text ranked inside it.",
  {
    query: z.string().describe('Search query — can be a technology, concept, project name, or anything you remember working on'),
    limit: z.number().optional().default(5).describe('Max results to return'),
  },
  withTimeout('search_memories', async ({ query, limit }) => {
    let results;
    let source;

    // Time phrases ("last week", "in August") narrow the window first, then
    // rank text inside it. Cloud search has no date filter, so stay local.
    const range = parseTimeRange(query);
    if (range) {
      results = searchMemories(range.text, limit, range);
      source = `local, ${range.label}`;
      query = range.text || query;
    } else {
      // Cloud returns { sessions, facts }
      const count = r => (r?.sessions?.length ?? 0) + (r?.facts?.length ?? 0);
      ({ data: results, source } = await readMemory({
        local: () => searchMemories(query, limit),
        remote: () => cloud.search(query),
        isEmpty: r => count(r) === 0,
      }));
      results = { sessions: results?.sessions ?? [], facts: results?.facts ?? [] };
    }

    const total = results.sessions.length + results.facts.length;

    if (total === 0) {
      return {
        content: [{ type: 'text', text: `No memories found for: "${query}" [${source}]` }],
      };
    }

    const lines = [`Found ${total} result(s) for "${query}" [${source}]:\n`];

    if (results.sessions.length > 0) {
      lines.push('## Sessions\n');
      for (const s of results.sessions) {
        lines.push(`**[${s.project_name ?? s.project ?? '?'}]** — ${s.session_date}`);
        lines.push(`${s.summary}`);
        if (s.stack) lines.push(`Stack: ${s.stack}`);
        if (s.what_was_built) lines.push(`Built: ${s.what_was_built}`);
        if (s.next_steps) lines.push(`Next: ${s.next_steps}`);
        lines.push('');
      }
    }

    if (results.facts.length > 0) {
      lines.push('## Facts\n');
      for (const f of results.facts) {
        const proj = f.project_name ? `[${f.project_name}]` : '[global]';
        lines.push(`**${proj} — ${f.category}**`);
        lines.push(f.content);
        lines.push('');
      }
    }

    return memoryResult(lines);
  })
);

// ─── TOOL: get_project ────────────────────────────────────────────────────────
server.tool(
  'get_project',
  "Full session history for one project, oldest to newest. Large; prefer get_orientation unless you need everything.",
  {
    name: projectName.describe('Project name to retrieve history for'),
  },
  withTimeout('get_project', async ({ name }) => {
    const { data: project, source } = await readMemory({
      local: () => getProject(name),
      remote: () => cloud.getProject(name),
      isEmpty: p => !p,
    });

    if (!project) {
      return {
        content: [{ type: 'text', text: `No project found with name: "${name}"` }],
      };
    }

    const lines = [
      `# ${project.name} [${source}]`,
      project.description ? `_${project.description}_` : '',
      `Created: ${project.created_at} | Last updated: ${project.updated_at}`,
      `Sessions: ${project.sessions?.length ?? 0}`,
      '',
    ];

    for (const s of project.sessions ?? []) {
      lines.push(`## Session — ${s.session_date}`);
      lines.push(s.summary);
      if (s.what_was_built) lines.push(`\n**Built:** ${s.what_was_built}`);
      if (s.decisions) lines.push(`\n**Decisions:** ${s.decisions}`);
      if (s.stack) lines.push(`\n**Stack:** ${s.stack}`);
      if (s.next_steps) lines.push(`\n**Next steps:** ${s.next_steps}`);
      if (s.tags) lines.push(`\n_Tags: ${s.tags}_`);
      lines.push('\n---\n');
    }

    return memoryResult(lines);
  })
);

// ─── TOOL: list_projects ─────────────────────────────────────────────────────
server.tool(
  'list_projects',
  "All known projects with session counts and last activity.",
  {},
  withTimeout('list_projects', async () => {
    const { data: projects, source } = await readMemory({
      local: () => listProjects(),
      remote: () => cloud.listProjects(),
      isEmpty: p => !p?.length,
    });

    if (projects.length === 0) {
      return {
        content: [{ type: 'text', text: 'No projects in What Next yet. Time to build something!' }],
      };
    }

    const lines = [`# What Next — All Projects (${projects.length}) [${source}]\n`];
    for (const p of projects) {
      lines.push(`**${p.name}** — ${p.session_count} session(s), last: ${p.last_session ?? p.updated_at ?? 'never'}`);
      if (p.description) lines.push(`  _${p.description}_`);
    }

    return memoryResult(lines);
  })
);

// ─── TOOL: add_fact ───────────────────────────────────────────────────────────
server.tool(
  'add_fact',
  "Store a durable fact outside any session. Category \"lesson\" (a fixed mistake) is shown first on cards and never auto-archived; \"tour\" (a feature traced through its files) is shown on the project card.",
  {
    category: z.string().describe('Category e.g. "preference", "pattern", "lesson" (a fixed mistake, shown first on cards, never auto-archived), "tour" (a code tour: one feature traced through 5-6 files with function names, checks and change boundary, shown on the project card), "stack-choice"'),
    content: z.string().describe('The fact or insight to remember'),
    project: projectName.optional().describe('Associate with a project, or leave blank for global facts'),
    tags: z.string().optional().describe('Comma-separated tags'),
  },
  withTimeout('add_fact', async (args, ctx) => {
    const id = addFact(args);
    ctx.wrote = `local fact ${id}`;
    const { flags } = sanitizeFields(args, FACT_TEXT_FIELDS);
    indexFact(id, args);
    logAudit('add_fact', `local write complete for fact ${id}`);

    syncFactInBackground(args, id);
    const source = cloud.isEnabled() ? 'local, cloud sync queued' : 'local';

    const scope = args.project ? `project: ${args.project}` : 'global';
    return {
      content: [{
        type: 'text',
        text: `Fact stored [${source}] (local id: ${id}) [${scope}]\nCategory: ${neutralize(args.category).text}\n${neutralize(args.content).text}${injectionNote(flags)}`,
      }],
    };
  })
);

// ─── TOOL: semantic_search ────────────────────────────────────────────────────
// Cloud-first (falls back to local embeddings if cloud unavailable), or
// local-first with WHATNEXT_PREFER_LOCAL=1.
// Archived facts are superseded by a newer one; never surface them.
const isLiveRecord = (rowtype, rec) => !!rec && (rowtype !== 'fact' || rec.status === 'active');

async function cloudSemantic(query, limit) {
  const { results } = await cloud.semanticSearch(query, limit);
  const lines = [`Semantic search: "${query}" [cloud]\n`];
  for (const r of results ?? []) {
    if (r.score < 0.3) continue;
    lines.push(`**[${r.rowtype}]** (score: ${Number(r.score).toFixed(2)})`);
    lines.push(r.text ?? '');
    lines.push('');
  }
  return lines.length > 1 ? lines : null;
}

// Returns { lines } to show, or { message } when there is nothing to show.
async function localSemantic(query, limit) {
  const allEmbeddings = getAllEmbeddings();
  if (allEmbeddings.length === 0) {
    return { message: 'No embeddings stored yet. Memories will be indexed as you add them.' };
  }
  const queryEmbedding = await generateEmbedding(query);
  const scored = allEmbeddings
    .map(e => ({ ...e, score: cosineSimilarity(queryEmbedding, e.embedding) }))
    .sort((a, b) => b.score - a.score);

  const lines = [`Semantic search: "${query}" [local]\n`];
  let shown = 0;
  for (const match of scored) {
    if (shown >= limit || match.score < 0.3) break;
    const record = match.rowtype === 'session'
      ? getSessionById(match.row_id)
      : getFactById(match.row_id);
    if (!isLiveRecord(match.rowtype, record)) continue;

    lines.push(`**[${record.project_name ?? 'global'}]** (score: ${match.score.toFixed(2)})`);
    if (match.rowtype === 'session') {
      lines.push(record.summary);
      if (record.what_was_built) lines.push(`Built: ${record.what_was_built}`);
      if (record.next_steps) lines.push(`Next: ${record.next_steps}`);
    } else {
      lines.push(`${record.category}: ${record.content}`);
    }
    lines.push('');
    shown++;
  }
  return shown > 0 ? { lines } : { message: `No strong matches found for: "${query}"` };
}

server.tool(
  'semantic_search',
  "Meaning-based search when you lack exact words. With a time phrase, exact matches in that window rank first and embeddings fill the rest.",
  {
    query: z.string().describe('What you\'re looking for — describe it naturally, no need for exact keywords'),
    limit: z.number().optional().default(5).describe('Max results to return'),
  },
  withTimeout('semantic_search', async ({ query, limit }) => {
    // With a time phrase: exact FTS matches inside the window come first,
    // embeddings (filtered to the same window) only fill what is left.
    const range = parseTimeRange(query);
    if (range) {
      const exact = searchMemories(range.text, limit, range);
      const lines = [`Semantic search: "${range.text || query}" [local, ${range.label}]\n`];
      const seen = new Set();
      for (const r of exact.sessions) {
        seen.add(`session:${r.id}`);
        lines.push(`**[${r.project_name}]** ${String(r.session_date).split('T')[0]} (exact)`);
        lines.push(r.summary);
        if (r.next_steps) lines.push(`Next: ${r.next_steps}`);
        lines.push('');
      }
      for (const f of exact.facts) {
        seen.add(`fact:${f.id}`);
        lines.push(`**[${f.project_name ?? 'global'}]** ${String(f.created_at).split('T')[0]} (exact)`);
        lines.push(`${f.category}: ${f.content}`);
        lines.push('');
      }
      let remaining = limit - exact.sessions.length - exact.facts.length;
      if (remaining > 0 && range.text) {
        const queryEmbedding = await generateEmbedding(range.text);
        const ranked = getAllEmbeddings()
          .map(e => ({ ...e, score: cosineSimilarity(queryEmbedding, e.embedding) }))
          .sort((a, b) => b.score - a.score);
        for (const m of ranked) {
          if (remaining <= 0) break;
          if (m.score < 0.3) break;
          if (seen.has(`${m.rowtype}:${m.row_id}`)) continue;
          const rec = m.rowtype === 'session' ? getSessionById(m.row_id) : getFactById(m.row_id);
          if (!isLiveRecord(m.rowtype, rec)) continue;
          const when = String(m.rowtype === 'session' ? rec.session_date : rec.created_at);
          if (!inRange(when, range)) continue;
          lines.push(`**[${rec.project_name ?? 'global'}]** ${when.split('T')[0]} (score: ${m.score.toFixed(2)})`);
          lines.push(m.rowtype === 'session' ? rec.summary : `${rec.category}: ${rec.content}`);
          lines.push('');
          remaining--;
        }
      }
      if (lines.length === 1) lines.push(`Nothing found between ${range.label}.`);
      return memoryResult(lines);
    }

    const tryCloud = async () => {
      if (!cloud.isEnabled()) return null;
      try {
        return await cloudSemantic(query, limit);
      } catch (err) {
        if (err instanceof CloudUnavailableError) return null;
        throw err;
      }
    };

    if (!PREFER_LOCAL) {
      const cloudLines = await tryCloud();
      if (cloudLines) return memoryResult(cloudLines);
    }

    const local = await localSemantic(query, limit);
    if (local.lines) return memoryResult(local.lines);

    if (PREFER_LOCAL) {
      const cloudLines = await tryCloud().catch(() => null);
      if (cloudLines) return memoryResult(cloudLines);
    }

    return { content: [{ type: 'text', text: local.message }] };
  })
);

// ─── TOOL: edit_session ───────────────────────────────────────────────────────
server.tool(
  'edit_session',
  "Correct or extend a saved session by its local id.",
  {
    id: z.number().describe('Local session ID to edit (from dump_session response or search results)'),
    summary: z.string().optional().describe('Updated session summary'),
    what_was_built: z.string().optional().describe('Updated built description'),
    decisions: z.string().optional().describe('Updated decisions'),
    stack: z.string().optional().describe('Updated stack'),
    next_steps: z.string().optional().describe('Updated next steps'),
    tags: z.string().optional().describe('Updated comma-separated tags'),
  },
  withTimeout('edit_session', async ({ id, ...updates }, ctx) => {
    const changed = editSession(id, updates);
    if (!changed) {
      return { content: [{ type: 'text', text: `Session ${id} not found or no fields to update.` }] };
    }
    ctx.wrote = `edit to local session ${id}`;
    // Re-index from the row as stored after the edit
    const session = getSessionById(id);
    if (session) indexSession(id, session);
    return { content: [{ type: 'text', text: `Session ${id} updated.` }] };
  })
);

// ─── TOOL: whats_next ─────────────────────────────────────────────────────────
server.tool(
  'whats_next',
  "Open next_steps across projects, newest first. The instant to-do list.",
  {
    limit: z.number().optional().default(8).describe('Max number of projects to include'),
  },
  withTimeout('whats_next', async ({ limit }) => {
    const items = getWhatsNext(limit);
    if (items.length === 0) {
      return { content: [{ type: 'text', text: 'No open next steps found.' }] };
    }
    const lines = ['## What Next — Open Action Items\n'];
    for (const item of items) {
      lines.push(`**${item.project_name}** — last session: ${(item.session_date ?? '').split('T')[0]}`);
      lines.push(`→ ${item.next_steps}`);
      lines.push('');
    }
    return memoryResult(lines);
  })
);

// ─── TOOL: send_feedback ─────────────────────────────────────────────────────
server.tool(
  'send_feedback',
  "Send a bug report or feature request to the What Next maintainer.",
  {
    message: z.string().describe('Your feedback, bug report, or feature request'),
    type: z.enum(['bug', 'feature', 'general']).optional().describe('Type of feedback'),
    context: z.string().optional().describe('Any extra context — what you were doing, what you expected'),
  },
  withTimeout('send_feedback', async (args) => {
    if (!cloud.isEnabled()) {
      return { content: [{ type: 'text', text: 'Cloud not configured — feedback could not be sent.' }] };
    }
    try {
      await cloud.postFeedback(args);
      return { content: [{ type: 'text', text: 'Feedback sent to Danny. Thank you!' }] };
    } catch {
      return { content: [{ type: 'text', text: 'Could not reach cloud — feedback not sent.' }] };
    }
  })
);

// ─── TOOL: curate_memory ─────────────────────────────────────────────────────
server.tool(
  'curate_memory',
  "Find and archive near-duplicate facts (recoverable). Runs daily on its own; call with dry_run to preview.",
  {
    dry_run: z.boolean().optional().default(false).describe('Preview what would be archived without changing anything'),
  },
  withTimeout('curate_memory', async ({ dry_run }, ctx) => {
    // Leave headroom under the tool timeout so the report gets back; facts not
    // indexed in time are picked up by the next run.
    const report = await runCuration({ apply: !dry_run, signal: ctx.signal, budgetMs: TOOL_TIMEOUT_MS - 4_000 });
    logAudit('curate_memory', `scanned ${report.facts_scanned}, ${dry_run ? 'would archive' : 'archived'} ${report.auto_archived.length}, flagged ${report.flagged_for_review.length}`);

    const lines = [`## Memory Curation${dry_run ? ' (dry run — nothing changed)' : ''}`];
    lines.push(`Scanned ${report.facts_scanned} active fact(s) in ${report.duration_ms}ms.`);
    if (report.aborted) lines.push('Run was cancelled part way; only the archives listed below happened.');
    lines.push('');

    if (report.auto_archived.length > 0) {
      lines.push(`**${dry_run ? 'Would archive' : 'Archived'} ${report.auto_archived.length} near-duplicate(s)** (newest kept, archived facts recoverable by ID):`);
      for (const p of report.auto_archived) {
        lines.push(`- #${p.archived_id} → superseded by #${p.kept_id} (${p.similarity}) [${p.project ?? 'global'}]`);
        lines.push(`  "${p.archived_excerpt}"`);
      }
      lines.push('');
    } else {
      lines.push('No near-duplicates found.');
      lines.push('');
    }

    if (report.flagged_for_review.length > 0) {
      lines.push(`**Flagged ${report.flagged_for_review.length} similar pair(s) for review** (no changes made):`);
      for (const p of report.flagged_for_review) {
        lines.push(`- #${p.a_id} vs #${p.b_id} (${p.similarity}) [${p.project ?? 'global'}]`);
        lines.push(`  "${p.a_excerpt}" vs "${p.b_excerpt}"`);
      }
      lines.push('');
    }

    if (report.unindexed_remaining > 0) {
      lines.push(`${report.unindexed_remaining} fact(s) not yet indexed — run curate_memory again to index more.`);
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  })
);

// ─── TOOL: since_last_session ────────────────────────────────────────────────
server.tool(
  'since_last_session',
  "What changed in a project since its last session: commits captured by the watcher, with Claude session links when present.",
  {
    project: projectName.describe('Project name to check'),
  },
  withTimeout('since_last_session', async (args) => {
    const last = getLastSession(args.project);
    if (!last) {
      return { content: [{ type: 'text', text: `No previous sessions found for "${args.project}".` }] };
    }

    const since = last.session_date;
    const commits = getCommitsSince(args.project, since);
    const daysSince = Math.round((Date.now() - new Date(since).getTime()) / 86_400_000);
    const daysLabel = daysSince === 0 ? 'today' : daysSince === 1 ? 'yesterday' : `${daysSince} days ago`;

    const lines = [
      `## Since your last session (${daysLabel} — ${String(since).split('T')[0]})`,
      '',
      `**Last session summary:** ${last.summary ?? 'n/a'}`,
    ];
    if (last.next_steps) lines.push(`**Open task:** ${last.next_steps}`);
    lines.push('');

    if (commits.length === 0) {
      lines.push('No git commits captured since then.');
    } else {
      lines.push(`**${commits.length} commit${commits.length === 1 ? '' : 's'} since then:**`);
      for (const c of commits) {
        const date = String(c.committed_at).split('T')[0];
        lines.push(`- ${date}: ${c.message}${c.session_url ? ` ([session](${c.session_url}))` : ''}`);
        if (c.changed_files) {
          const files = c.changed_files.split('\n').slice(0, 4);
          for (const f of files) lines.push(`  · ${f}`);
        }
      }
    }

    return memoryResult(lines);
  })
);

// ─── Start ────────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);

// Optionally load the embedding model shortly after startup, off the request path,
// so the first semantic_search does not spend its timeout on a cold model load.
// Opt-in: every client spawns its own MCP process and the model costs ~100MB each.
if (process.env.WHATNEXT_WARM_EMBEDDER === '1') {
  setTimeout(() => { warmEmbedder(); }, 5_000).unref();
}
