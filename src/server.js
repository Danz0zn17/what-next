import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { addSession, addFact, editSession, searchMemories, getProject, listProjects, storeEmbedding, getAllEmbeddings, getSessionById, getFactById, getRecentSessions, getAllFacts, getWhatsNext, upsertProjectIntelligence, getProjectIntelligence } from './db.js';
import { writeSidecarForProject, writeGlobalContext } from './sidecar.js';
import { generateEmbedding, cosineSimilarity } from './embeddings.js';
import * as cloud from './cloud-client.js';
import { CloudUnavailableError } from './cloud-client.js';
import { syncPending, dumpToGist } from './gist-client.js';
import { buildUpdateNotice } from './update-check.js';

const server = new McpServer({
  name: 'what-next',
  version: '2.0.0',
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
      await cloud.postSession(args);
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
      await cloud.postFact(args);
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

function withTimeout(toolName, handlerFn) {
  return async (args) => {
    const start = Date.now();
    const timer = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Tool timed out after ${TOOL_TIMEOUT_MS}ms`)), TOOL_TIMEOUT_MS)
    );
    try {
      const result = await Promise.race([handlerFn(args), timer]);
      const elapsed = Date.now() - start;
      if (elapsed > 3_000) log('WARN', toolName, `slow response: ${elapsed}ms`);
      return result;
    } catch (err) {
      log('ERROR', toolName, err.message);
      return {
        content: [{
          type: 'text',
          text: `[what-next] ⚠️ ${toolName} failed: ${err.message}\n\nThe MCP server is running but encountered an error. Your session data is safe in local SQLite. You can retry or use the REST API at http://localhost:3747`,
        }],
      };
    }
  };
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

// ─── TOOL: dump_session ───────────────────────────────────────────────────────
server.tool(
  'dump_session',
  {
    project: z.string().describe('Project name (matches your folder name in ~/Documents/projects/)'),
    summary: z.string().describe('A concise summary of what happened this session'),
    what_was_built: z.string().optional().describe('Specific features, files, or components built'),
    decisions: z.string().optional().describe('Key architectural or design decisions made'),
    stack: z.string().optional().describe('Technologies, libraries, and tools used'),
    next_steps: z.string().optional().describe('What to pick up next session'),
    tags: z.string().optional().describe('Comma-separated tags e.g. "react,auth,api,bug-fix"'),
  },
  withTimeout('dump_session', async (args) => {
    const id = addSession(args);
    const text = [args.summary, args.what_was_built, args.decisions, args.next_steps, args.tags].filter(Boolean).join(' ');
    generateEmbedding(text).then(emb => storeEmbedding('session', id, emb)).catch(() => {});
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
        text: `Session dumped [${sourceLabel}] (local id: ${id})\nProject: ${args.project}\nSummary: ${args.summary}`,
      }],
    };
  })
);

// ─── TOOL: get_context ───────────────────────────────────────────────────────
server.tool(
  'get_context',
  {
    surface: z.enum(['claude-code', 'copilot', 'codex', 'hermes', 'cursor', 'generic']).optional()
      .describe('Which AI surface is calling — shapes the response format and depth'),
  },
  withTimeout('get_context', async ({ surface } = {}) => {
    let context;
    let source = 'cloud';

    if (cloud.isEnabled()) {
      try {
        context = await cloud.getContext();
      } catch (err) {
        if (!(err instanceof CloudUnavailableError)) throw err;
        source = 'local';
      }
    }

    if (!context) {
      source = 'local';
      context = {
        recent_sessions: getRecentSessions(5),
        facts: getAllFacts(),
        active_projects: listProjects(),
      };
    }

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
      return { content: [{ type: 'text', text: hermes.join('\n') }] };
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

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  })
);

// ─── TOOL: update_project_intelligence ───────────────────────────────────────
server.tool(
  'update_project_intelligence',
  {
    project: z.string().describe('Project name (matches folder name in ~/Documents/projects/)'),
    repo_path: z.string().optional().describe('Absolute path to the repo on disk'),
    stack: z.string().optional().describe('Tech stack summary e.g. "React + Vite + Supabase + Railway"'),
    key_dirs: z.string().optional().describe('Where things live — key directories and what they contain'),
    conventions: z.string().optional().describe('Coding patterns, naming conventions, architectural rules'),
    env_vars: z.string().optional().describe('Environment variable names (keys only, never values)'),
    deployment: z.string().optional().describe('How the app is deployed e.g. "Netlify (frontend) + Railway (backend)"'),
    extra: z.string().optional().describe('Key decisions, gotchas, anything a new session should know'),
  },
  withTimeout('update_project_intelligence', async (args) => {
    upsertProjectIntelligence(args);
    logAudit('update_project_intelligence', `updated for ${args.project}`);

    setImmediate(() => {
      try { writeSidecarForProject(args.project); } catch {}
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
        text: `Project intelligence updated for ${args.project}. Context card written to ~/.whatnext/agents/${args.project}.md`,
      }],
    };
  })
);

// ─── TOOL: get_orientation ────────────────────────────────────────────────────
server.tool(
  'get_orientation',
  {
    project: z.string().describe('Project name to get a focused orientation brief for'),
  },
  withTimeout('get_orientation', async ({ project }) => {
    const intel = getProjectIntelligence(project);
    const sessions = getRecentSessions(20).filter(s => s.project_name === project).slice(0, 3);
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

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  })
);

// ─── TOOL: search_memories ────────────────────────────────────────────────────
server.tool(
  'search_memories',
  {
    query: z.string().describe('Search query — can be a technology, concept, project name, or anything you remember working on'),
    limit: z.number().optional().default(5).describe('Max results to return'),
  },
  withTimeout('search_memories', async ({ query, limit }) => {
    let results;
    let source = 'cloud';

    if (cloud.isEnabled()) {
      try {
        results = await cloud.search(query);
        // Cloud returns { sessions, facts }
      } catch (err) {
        if (!(err instanceof CloudUnavailableError)) throw err;
        source = 'local';
      }
    }

    if (!results) {
      source = 'local';
      results = searchMemories(query, limit);
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

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  })
);

// ─── TOOL: get_project ────────────────────────────────────────────────────────
server.tool(
  'get_project',
  {
    name: z.string().describe('Project name to retrieve history for'),
  },
  withTimeout('get_project', async ({ name }) => {
    let project;
    let source = 'cloud';

    if (cloud.isEnabled()) {
      try {
        project = await cloud.getProject(name);
      } catch (err) {
        if (err.statusCode === 404) {
          project = null;
        } else if (!(err instanceof CloudUnavailableError)) {
          throw err;
        }
        source = 'local';
      }
    }

    if (project === undefined) {
      source = 'local';
      project = getProject(name);
    }

    if (!project) {
      return {
        content: [{ type: 'text', text: `No project found with name: "${name}"` }],
      };
    }

    const lines = [
      `# ${project.name} [${source}]`,
      project.description ? `_${project.description}_` : '',
      `Created: ${project.created_at} | Last updated: ${project.updated_at}`,
      `Sessions: ${project.sessions.length}`,
      '',
    ];

    for (const s of project.sessions) {
      lines.push(`## Session — ${s.session_date}`);
      lines.push(s.summary);
      if (s.what_was_built) lines.push(`\n**Built:** ${s.what_was_built}`);
      if (s.decisions) lines.push(`\n**Decisions:** ${s.decisions}`);
      if (s.stack) lines.push(`\n**Stack:** ${s.stack}`);
      if (s.next_steps) lines.push(`\n**Next steps:** ${s.next_steps}`);
      if (s.tags) lines.push(`\n_Tags: ${s.tags}_`);
      lines.push('\n---\n');
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  })
);

// ─── TOOL: list_projects ─────────────────────────────────────────────────────
server.tool(
  'list_projects',
  {},
  withTimeout('list_projects', async () => {
    let projects;
    let source = 'cloud';

    if (cloud.isEnabled()) {
      try {
        projects = await cloud.listProjects();
      } catch (err) {
        if (!(err instanceof CloudUnavailableError)) throw err;
        source = 'local';
      }
    }

    if (!projects) {
      source = 'local';
      projects = listProjects();
    }

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

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  })
);

// ─── TOOL: add_fact ───────────────────────────────────────────────────────────
server.tool(
  'add_fact',
  {
    category: z.string().describe('Category e.g. "preference", "pattern", "lesson", "stack-choice"'),
    content: z.string().describe('The fact or insight to remember'),
    project: z.string().optional().describe('Associate with a project, or leave blank for global facts'),
    tags: z.string().optional().describe('Comma-separated tags'),
  },
  withTimeout('add_fact', async (args) => {
    const id = addFact(args);
    const text = [args.category, args.content, args.tags].filter(Boolean).join(' ');
    generateEmbedding(text).then(emb => storeEmbedding('fact', id, emb)).catch(() => {});
    logAudit('add_fact', `local write complete for fact ${id}`);

    syncFactInBackground(args, id);
    const source = cloud.isEnabled() ? 'local, cloud sync queued' : 'local';

    const scope = args.project ? `project: ${args.project}` : 'global';
    return {
      content: [{
        type: 'text',
        text: `Fact stored [${source}] (local id: ${id}) [${scope}]\nCategory: ${args.category}\n${args.content}`,
      }],
    };
  })
);

// ─── TOOL: semantic_search ────────────────────────────────────────────────────
// Cloud-first (falls back to local embeddings if cloud unavailable)
server.tool(
  'semantic_search',
  {
    query: z.string().describe('What you\'re looking for — describe it naturally, no need for exact keywords'),
    limit: z.number().optional().default(5).describe('Max results to return'),
  },
  withTimeout('semantic_search', async ({ query, limit }) => {
    // Try cloud semantic search first
    if (cloud.isEnabled()) {
      try {
        const { results } = await cloud.semanticSearch(query, limit);
        if (results.length > 0) {
          const lines = [`Semantic search: "${query}" [cloud]\n`];
          for (const r of results) {
            if (r.score < 0.3) continue;
            lines.push(`**[${r.rowtype}]** (score: ${Number(r.score).toFixed(2)})`);
            lines.push(r.text ?? '');
            lines.push('');
          }
          if (lines.length > 1) {
            return { content: [{ type: 'text', text: lines.join('\n') }] };
          }
        }
      } catch (err) {
        if (!(err instanceof CloudUnavailableError)) throw err;
      }
    }

    // Fall back to local embeddings
    const queryEmbedding = await generateEmbedding(query);
    const allEmbeddings = getAllEmbeddings();

    if (allEmbeddings.length === 0) {
      return { content: [{ type: 'text', text: 'No embeddings stored yet. Memories will be indexed as you add them.' }] };
    }

    const scored = allEmbeddings
      .map(e => ({ ...e, score: cosineSimilarity(queryEmbedding, e.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    const lines = [`Semantic search: "${query}" [local]\n`];

    for (const match of scored) {
      if (match.score < 0.3) continue;
      const record = match.rowtype === 'session'
        ? getSessionById(match.row_id)
        : getFactById(match.row_id);

      if (!record) continue;

      lines.push(`**[${record.project_name ?? 'global'}]** (score: ${match.score.toFixed(2)})`);
      if (match.rowtype === 'session') {
        lines.push(record.summary);
        if (record.what_was_built) lines.push(`Built: ${record.what_was_built}`);
        if (record.next_steps) lines.push(`Next: ${record.next_steps}`);
      } else {
        lines.push(`${record.category}: ${record.content}`);
      }
      lines.push('');
    }

    if (lines.length === 1) {
      return { content: [{ type: 'text', text: `No strong matches found for: "${query}"` }] };
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  })
);

// ─── TOOL: edit_session ───────────────────────────────────────────────────────
server.tool(
  'edit_session',
  {
    id: z.number().describe('Local session ID to edit (from dump_session response or search results)'),
    summary: z.string().optional().describe('Updated session summary'),
    what_was_built: z.string().optional().describe('Updated built description'),
    decisions: z.string().optional().describe('Updated decisions'),
    stack: z.string().optional().describe('Updated stack'),
    next_steps: z.string().optional().describe('Updated next steps'),
    tags: z.string().optional().describe('Updated comma-separated tags'),
  },
  withTimeout('edit_session', async ({ id, ...updates }) => {
    const changed = editSession(id, updates);
    if (!changed) {
      return { content: [{ type: 'text', text: `Session ${id} not found or no fields to update.` }] };
    }
    // Refresh embedding for updated session
    const session = getSessionById(id);
    if (session) {
      const text = [session.summary, session.what_was_built, session.decisions, session.next_steps, session.tags].filter(Boolean).join(' ');
      generateEmbedding(text).then(emb => storeEmbedding('session', id, emb)).catch(() => {});
    }
    return { content: [{ type: 'text', text: `Session ${id} updated.` }] };
  })
);

// ─── TOOL: whats_next ─────────────────────────────────────────────────────────
server.tool(
  'whats_next',
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
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  })
);

// ─── TOOL: send_feedback ─────────────────────────────────────────────────────
server.tool(
  'send_feedback',
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

// ─── Start ────────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
