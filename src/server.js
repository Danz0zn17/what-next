import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { addSession, addFact, searchMemories, getProject, listProjects, storeEmbedding, getAllEmbeddings, getSessionById, getFactById, getRecentSessions, getAllFacts } from './db.js';
import { generateEmbedding, cosineSimilarity } from './embeddings.js';
import * as cloud from './cloud-client.js';
import { CloudUnavailableError } from './cloud-client.js';
import { syncPending, dumpToGist } from './gist-client.js';
import { buildUpdateNotice } from './update-check.js';

const server = new McpServer({
  name: 'what-next',
  version: '1.1.0',
});

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
    const local = server.version ?? '1.0.0';
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
  async (args) => {
    let source = 'cloud';

    // Try cloud first
    if (cloud.isEnabled()) {
      try {
        await cloud.postSession(args);
      } catch (err) {
        if (!(err instanceof CloudUnavailableError)) throw err;
        source = 'local';
        // Gist fallback (fire and forget — gist-client queues it)
        dumpToGist(args).catch(() => {});
      }
    } else {
      source = 'local';
    }

    // Always write to local SQLite as well (offline cache + embeddings)
    const id = addSession(args);
    const text = [args.summary, args.what_was_built, args.decisions, args.next_steps, args.tags].filter(Boolean).join(' ');
    generateEmbedding(text).then(emb => storeEmbedding('session', id, emb)).catch(() => {});

    const sourceLabel = source === 'cloud' ? 'cloud + local' : 'local only (cloud unreachable)';
    return {
      content: [{
        type: 'text',
        text: `Session dumped [${sourceLabel}] (local id: ${id})\nProject: ${args.project}\nSummary: ${args.summary}`,
      }],
    };
  }
);

// ─── TOOL: get_context ───────────────────────────────────────────────────────
server.tool(
  'get_context',
  {},
  async () => {
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

    if (context.facts?.length > 0) {
      lines.push('**Facts & Preferences:**');
      for (const f of context.facts) {
        const scope = f.project_name ? `[${f.project_name}]` : '[global]';
        lines.push(`${scope} ${f.category}: ${f.content}`);
      }
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

// ─── TOOL: search_memories ────────────────────────────────────────────────────
server.tool(
  'search_memories',
  {
    query: z.string().describe('Search query — can be a technology, concept, project name, or anything you remember working on'),
    limit: z.number().optional().default(5).describe('Max results to return'),
  },
  async ({ query, limit }) => {
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
  }
);

// ─── TOOL: get_project ────────────────────────────────────────────────────────
server.tool(
  'get_project',
  {
    name: z.string().describe('Project name to retrieve history for'),
  },
  async ({ name }) => {
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
  }
);

// ─── TOOL: list_projects ─────────────────────────────────────────────────────
server.tool(
  'list_projects',
  {},
  async () => {
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
  }
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
  async (args) => {
    let source = 'cloud';

    if (cloud.isEnabled()) {
      try {
        await cloud.postFact(args);
      } catch (err) {
        if (!(err instanceof CloudUnavailableError)) throw err;
        source = 'local';
      }
    } else {
      source = 'local';
    }

    const id = addFact(args);
    const text = [args.category, args.content, args.tags].filter(Boolean).join(' ');
    generateEmbedding(text).then(emb => storeEmbedding('fact', id, emb)).catch(() => {});

    const scope = args.project ? `project: ${args.project}` : 'global';
    return {
      content: [{
        type: 'text',
        text: `Fact stored [${source}] (local id: ${id}) [${scope}]\nCategory: ${args.category}\n${args.content}`,
      }],
    };
  }
);

// ─── TOOL: semantic_search ────────────────────────────────────────────────────
// Cloud-first (falls back to local embeddings if cloud unavailable)
server.tool(
  'semantic_search',
  {
    query: z.string().describe('What you\'re looking for — describe it naturally, no need for exact keywords'),
    limit: z.number().optional().default(5).describe('Max results to return'),
  },
  async ({ query, limit }) => {
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
  }
);

// ─── TOOL: send_feedback ─────────────────────────────────────────────────────
server.tool(
  'send_feedback',
  {
    message: z.string().describe('Your feedback, bug report, or feature request'),
    type: z.enum(['bug', 'feature', 'general']).optional().describe('Type of feedback'),
    context: z.string().optional().describe('Any extra context — what you were doing, what you expected'),
  },
  async (args) => {
    if (!cloud.isEnabled()) {
      return { content: [{ type: 'text', text: 'Cloud not configured — feedback could not be sent.' }] };
    }
    try {
      await cloud.postFeedback(args);
      return { content: [{ type: 'text', text: 'Feedback sent to Danny. Thank you!' }] };
    } catch {
      return { content: [{ type: 'text', text: 'Could not reach cloud — feedback not sent.' }] };
    }
  }
);

// ─── Start ────────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
