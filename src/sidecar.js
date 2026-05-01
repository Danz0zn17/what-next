/**
 * What Next — Smart Context Card writer
 *
 * Writes per-project and global context files to ~/.whatnext/agents/ so any
 * AI tool (with or without MCP) can read them at session start.
 *
 * Files written:
 *   ~/.whatnext/agents/{project}.md  — per-project orientation card
 *   ~/.whatnext/context.md           — global pointer + cross-project brief
 *   ~/.copilot/copilot-instructions.md — Copilot session-start instructions
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getProjectIntelligence, getRecentSessions, getWhatsNext, getAllFacts, listProjects, getRecentCommits } from './db.js';

const HOME = homedir();
const AGENTS_DIR = join(HOME, '.whatnext', 'agents');
const CONTEXT_FILE = join(HOME, '.whatnext', 'context.md');
const COPILOT_DIR = join(HOME, '.copilot');
const COPILOT_INSTRUCTIONS = join(COPILOT_DIR, 'copilot-instructions.md');

function ensureDirs() {
  mkdirSync(AGENTS_DIR, { recursive: true });
  mkdirSync(COPILOT_DIR, { recursive: true });
}

function safe(v) {
  return v ? String(v).trim() : null;
}

function formatDate(iso) {
  return iso ? iso.split('T')[0] : 'unknown';
}

function truncate(str, n) {
  if (!str) return '';
  return str.length > n ? str.slice(0, n - 3) + '...' : str;
}

export function writeSidecarForProject(projectName) {
  try {
    ensureDirs();
    const intel = getProjectIntelligence(projectName);
    const sessions = getRecentSessions(20).filter(s => s.project_name === projectName).slice(0, 3);
    const commits = getRecentCommits(projectName, 5);
    const whatsNext = getWhatsNext(20).find(i => i.project_name === projectName);

    const lines = [];
    lines.push(`# ${projectName} | What Next Context`);
    lines.push(`_Updated ${new Date().toISOString().split('T')[0]}_`);
    lines.push('');

    if (intel) {
      lines.push('## Project Map');
      if (safe(intel.repo_path)) lines.push(`**Repo:** ${intel.repo_path}`);
      if (safe(intel.stack)) lines.push(`**Stack:** ${intel.stack}`);
      if (safe(intel.deployment)) lines.push(`**Deployment:** ${intel.deployment}`);
      if (safe(intel.env_vars)) lines.push(`**Env vars (keys only):** ${intel.env_vars}`);
      lines.push('');

      if (safe(intel.key_dirs)) {
        lines.push('## Where Things Live');
        lines.push(intel.key_dirs);
        lines.push('');
      }

      if (safe(intel.conventions)) {
        lines.push('## Conventions & Patterns');
        lines.push(intel.conventions);
        lines.push('');
      }

      if (safe(intel.extra)) {
        lines.push('## Key Decisions');
        lines.push(intel.extra);
        lines.push('');
      }
    }

    lines.push('---');
    lines.push('');

    if (sessions.length > 0) {
      lines.push('## Recent Work');
      for (const s of sessions) {
        lines.push(`### ${formatDate(s.session_date)}`);
        lines.push(truncate(s.summary, 300));
        if (s.what_was_built) lines.push(`Built: ${truncate(s.what_was_built, 200)}`);
        if (s.decisions) lines.push(`Decided: ${truncate(s.decisions, 200)}`);
        lines.push('');
      }
    }

    if (whatsNext?.next_steps) {
      lines.push('## Open Tasks');
      lines.push(whatsNext.next_steps);
      lines.push('');
    }

    if (commits.length > 0) {
      lines.push('## Recent Commits');
      for (const c of commits) {
        const hash = c.commit_hash.slice(0, 7);
        lines.push(`- \`${hash}\` ${truncate(c.message, 80)}`);
      }
      lines.push('');
    }

    lines.push('---');
    lines.push('_This file is auto-maintained by What Next. Do not edit manually._');

    const filePath = join(AGENTS_DIR, `${projectName}.md`);
    writeFileSync(filePath, lines.join('\n'), 'utf8');
  } catch (err) {
    process.stderr.write(`[sidecar] Failed to write sidecar for ${projectName}: ${err.message}\n`);
  }
}

export function writeGlobalContext() {
  try {
    ensureDirs();
    const projects = listProjects().slice(0, 12);
    const recentSessions = getRecentSessions(5);
    const globalFacts = getAllFacts().filter(f => !f.project_id).slice(0, 20);

    const lines = [];
    lines.push('# What Next | Global Context');
    lines.push(`_Updated ${new Date().toISOString().split('T')[0]}_`);
    lines.push('');
    lines.push('At the start of each session, read the project-specific context file:');
    lines.push('`~/.whatnext/agents/{project-name}.md`');
    lines.push('');

    if (projects.length > 0) {
      lines.push('## Active Projects');
      lines.push('| Project | Last Session |');
      lines.push('|---------|-------------|');
      for (const p of projects) {
        const last = formatDate(p.last_session);
        lines.push(`| ${p.name} | ${last} |`);
      }
      lines.push('');
    }

    if (recentSessions.length > 0) {
      lines.push('## Recent Work');
      for (const s of recentSessions) {
        lines.push(`**[${s.project_name}]** ${formatDate(s.session_date)}: ${truncate(s.summary, 200)}`);
        if (s.next_steps) lines.push(`- Open: ${truncate(s.next_steps, 150)}`);
      }
      lines.push('');
    }

    if (globalFacts.length > 0) {
      lines.push('## Global Facts & Preferences');
      for (const f of globalFacts) {
        lines.push(`- **${f.category}:** ${truncate(f.content, 200)}`);
      }
      lines.push('');
    }

    lines.push('---');
    lines.push('_Auto-maintained by What Next. whatnextai.co.za_');

    writeFileSync(CONTEXT_FILE, lines.join('\n'), 'utf8');

    writeCopilotInstructions();
  } catch (err) {
    process.stderr.write(`[sidecar] Failed to write global context: ${err.message}\n`);
  }
}

function writeCopilotInstructions() {
  try {
    const content = `# Danny's Copilot Instructions

You are working with Danny Mchunu (Greenberries studio, Durban).

## Session start — mandatory
1. Identify the project from the workspace folder name
2. Read \`~/.whatnext/agents/{project-name}.md\` — full context: stack, structure, conventions, recent work, open tasks
3. If no project file exists: read \`~/.whatnext/context.md\` for global context
4. Start oriented. No codebase exploration, no clarifying questions.

## Session end — mandatory
Update \`~/.whatnext/agents/{project-name}.md\` with anything new discovered this session.
Also call \`dump_session\` via What Next MCP if available.

## Danny's defaults
- Stack: React + Vite + TypeScript + Tailwind + Supabase + Netlify (frontend) + Railway (backend)
- All repos private. Never create a public repo without explicit confirmation.
- Concise and direct. Lead with the answer. No long explanations unless asked.
- No emojis. No long dashes — use hyphens.
- Security: anon key frontend only, service role key backend only, RLS on every Supabase table.
- Footer on every site: Terms & Conditions link + "Built by Greenberries" linking to greenberries.co.za

## What Next MCP tools (if available)
- \`get_context\` — full cross-project context snapshot
- \`get_orientation\` — project-focused brief (stack + last 3 sessions + open tasks, under 2000 tokens)
- \`update_project_intelligence\` — save what you learned about the codebase structure
- \`dump_session\` — save session summary, decisions, next steps
- \`search_memories\` / \`semantic_search\` — find past decisions and context
`;
    writeFileSync(COPILOT_INSTRUCTIONS, content, 'utf8');
  } catch (err) {
    process.stderr.write(`[sidecar] Failed to write Copilot instructions: ${err.message}\n`);
  }
}
