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
 *   ~/.whatnext/brief.md             - six-line session brief: global lessons + where the rest lives.
 *                                        Inject this plus the project card at session start and pull
 *                                        the full brief on demand.
 *   {repo}/AGENTS.md                  - pointer block (only when AGENTS.md exists
 *                                        or the repo has neither AGENTS.md nor CLAUDE.md)
 *
 * The card header is byte-stable between writes (the updated date lives in the
 * footer) so a hook that injects it does not break prompt caching every day.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getProjectIntelligence, getRecentSessions, getWhatsNext, getAllFacts, listProjects, getRecentCommits, getHotFiles } from './db.js';
import { neutralize, DATA_NOTICE } from './sanitize.js';

const HOME = homedir();
const AGENTS_DIR = join(HOME, '.whatnext', 'agents');
const CONTEXT_FILE = join(HOME, '.whatnext', 'context.md');
const BRIEF_FILE = join(HOME, '.whatnext', 'brief.md');
const COPILOT_DIR = join(HOME, '.copilot');
const COPILOT_INSTRUCTIONS = join(COPILOT_DIR, 'copilot-instructions.md');
const CARD_WARN_CHARS = 12_000; // ~3k tokens - beyond this the card stops being "zero-cost"

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

// Every string that leaves the DB for one of these files is replayed into a
// future system prompt, so it is escaped on the way out as well as on the way
// in. Rows stored before the sanitiser existed have only this pass.
function clean(v) {
  return v == null ? '' : neutralize(String(v)).text;
}

function truncate(str, n) {
  if (!str) return '';
  const s = clean(str);
  return s.length > n ? s.slice(0, n - 3) + '...' : s;
}

export function writeSidecarForProject(projectName) {
  try {
    ensureDirs();
    const intel = getProjectIntelligence(projectName);
    const sessions = getRecentSessions(20).filter(s => s.project_name === projectName).slice(0, 3);
    const commits = getRecentCommits(projectName, 5);
    const whatsNext = getWhatsNext(20).find(i => i.project_name === projectName);
    const projectFacts = getAllFacts().filter(f => f.project_name === projectName);
    const lessons = projectFacts.filter(f => f.category === 'lesson').slice(0, 8);
    const tours = projectFacts.filter(f => f.category === 'tour').slice(0, 6);
    const hotFiles = getHotFiles(projectName);

    const lines = [];
    lines.push(`# ${clean(projectName)} | What Next Context`);
    lines.push('');
    lines.push(DATA_NOTICE);
    lines.push('');

    if (lessons.length > 0) {
      lines.push('## Lessons (do not repeat these mistakes)');
      for (const f of lessons) lines.push(`- ${truncate(f.content, 240)}`);
      lines.push('');
    }

    if (intel) {
      lines.push('## Project Map');
      if (safe(intel.repo_path)) lines.push(`**Repo:** ${clean(intel.repo_path)}`);
      if (safe(intel.stack)) lines.push(`**Stack:** ${clean(intel.stack)}`);
      if (safe(intel.deployment)) lines.push(`**Deployment:** ${clean(intel.deployment)}`);
      if (safe(intel.env_vars)) lines.push(`**Env vars (keys only):** ${clean(intel.env_vars)}`);
      lines.push('');

      if (safe(intel.key_dirs)) {
        lines.push('## Where Things Live');
        lines.push(clean(intel.key_dirs));
        lines.push('');
      }

      if (safe(intel.conventions)) {
        lines.push('## Conventions & Patterns');
        lines.push(clean(intel.conventions));
        lines.push('');
      }

      if (safe(intel.extra)) {
        lines.push('## Key Decisions');
        lines.push(clean(intel.extra));
        lines.push('');
      }
    }

    // Code tours: one fact per feature, tracing the files it flows through.
    // Written by a session that just did the reading, reused by the next one.
    if (tours.length > 0) {
      lines.push('## Code Tours');
      for (const f of tours) lines.push(`- ${truncate(f.content, 600)}`);
      lines.push('');
    }

    // Hot files: derived from commit history, no one has to write it.
    if (hotFiles.length > 0) {
      lines.push('## Hot Files (last 30 days)');
      for (const h of hotFiles) lines.push(`- ${clean(h.file)} (${h.commits} commit${h.commits === 1 ? '' : 's'})`);
      lines.push('');
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
      lines.push(clean(whatsNext.next_steps));
      lines.push('');
    }

    if (commits.length > 0) {
      lines.push('## Recent Commits');
      for (const c of commits) {
        const hash = clean(c.commit_hash).slice(0, 7);
        lines.push(`- \`${hash}\` ${truncate(c.message, 80)}`);
      }
      lines.push('');
    }

    lines.push('---');
    lines.push(`_Updated ${new Date().toISOString().split('T')[0]}. This file is auto-maintained by What Next. Do not edit manually._`);

    const filePath = join(AGENTS_DIR, `${projectName}.md`);
    const content = lines.join('\n');
    writeFileSync(filePath, content, 'utf8');
    if (content.length > CARD_WARN_CHARS) {
      process.stderr.write(`[sidecar] ${projectName} card is ${content.length} chars (~${Math.round(content.length / 4)} tokens) - trim project intelligence to keep orientation cheap\n`);
    }

    // Auto-write .cursorrules / AGENTS.md pointer if the repo is known
    if (intel?.repo_path) {
      writeCursorRules(projectName, intel.repo_path, filePath);
      writeAgentsMd(projectName, intel.repo_path, filePath);
    }
  } catch (err) {
    process.stderr.write(`[sidecar] Failed to write sidecar for ${projectName}: ${err.message}\n`);
  }
}

function writeCursorRules(projectName, repoPath, cardPath) {
  try {
    const cursorDir = join(repoPath, '.cursor');
    const cursorRulesPath = join(repoPath, '.cursorrules');
    const hasCursorDir = existsSync(cursorDir);
    const hasCursorRules = existsSync(cursorRulesPath);

    if (!hasCursorDir && !hasCursorRules) return;

    const marker = '# [What Next] Auto-managed block - do not edit below this line';
    const block = [
      marker,
      `# Context card for ${projectName} is at: ${cardPath}`,
      `# It is updated automatically on every session dump and git commit.`,
      `# Read it at the start of every session for instant orientation.`,
      '',
      readFileSync(cardPath, 'utf8').slice(0, 2000),
    ].join('\n');

    if (hasCursorRules) {
      const existing = readFileSync(cursorRulesPath, 'utf8');
      const markerIdx = existing.indexOf(marker);
      const base = markerIdx >= 0 ? existing.slice(0, markerIdx).trimEnd() : existing.trimEnd();
      writeFileSync(cursorRulesPath, base ? `${base}\n\n${block}` : block, 'utf8');
    } else {
      writeFileSync(join(cursorDir, 'rules'), block, 'utf8');
    }
  } catch {
    // cursor rules write is best-effort, never throw
  }
}

// Claude Code reads AGENTS.md when there is no CLAUDE.md; Codex and Copilot read
// it always. One managed block points all of them at the card.
function writeAgentsMd(projectName, repoPath, cardPath) {
  try {
    const agentsPath = join(repoPath, 'AGENTS.md');
    const hasAgents = existsSync(agentsPath);
    if (!hasAgents && existsSync(join(repoPath, 'CLAUDE.md'))) return;
    if (!hasAgents && !existsSync(join(repoPath, '.git'))) return;

    const marker = '<!-- What Next: auto-managed block - do not edit below this line -->';
    const block = [
      marker,
      '## Orientation (What Next)',
      `Read \`${cardPath}\` at the start of every session. It holds the stack, key dirs,`,
      `conventions, recent work and open tasks for ${projectName}, updated on every session dump and commit.`,
      '',
    ].join('\n');

    if (hasAgents) {
      const existing = readFileSync(agentsPath, 'utf8');
      const markerIdx = existing.indexOf(marker);
      const base = markerIdx >= 0 ? existing.slice(0, markerIdx).trimEnd() : existing.trimEnd();
      const next = base ? `${base}\n\n${block}` : block;
      if (next !== existing) writeFileSync(agentsPath, next, 'utf8');
    } else {
      writeFileSync(agentsPath, `# ${projectName}\n\n${block}`, 'utf8');
    }
  } catch {
    // best-effort, never throw
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
    lines.push('');
    lines.push(DATA_NOTICE);
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
        lines.push(`| ${clean(p.name)} | ${last} |`);
      }
      lines.push('');
    }

    if (recentSessions.length > 0) {
      lines.push('## Recent Work');
      for (const s of recentSessions) {
        lines.push(`**[${clean(s.project_name)}]** ${formatDate(s.session_date)}: ${truncate(s.summary, 200)}`);
        if (s.next_steps) lines.push(`- Open: ${truncate(s.next_steps, 150)}`);
      }
      lines.push('');
    }

    const lessons = globalFacts.filter(f => f.category === 'lesson');
    if (lessons.length > 0) {
      lines.push('## Lessons (do not repeat these mistakes)');
      for (const f of lessons) lines.push(`- ${truncate(f.content, 200)}`);
      lines.push('');
    }

    if (globalFacts.length > 0) {
      lines.push('## Global Facts & Preferences');
      for (const f of globalFacts.filter(f => f.category !== 'lesson')) {
        lines.push(`- **${clean(f.category)}:** ${truncate(f.content, 200)}`);
      }
      lines.push('');
    }

    lines.push('---');
    lines.push(`_Updated ${new Date().toISOString().split('T')[0]}. Auto-maintained by What Next. whatnextai.co.za_`);

    writeFileSync(CONTEXT_FILE, lines.join('\n'), 'utf8');

    writeSessionBrief(lessons);
    writeCopilotInstructions();
  } catch (err) {
    process.stderr.write(`[sidecar] Failed to write global context: ${err.message}\n`);
  }
}

// The part of the global brief worth paying for on every session start: the
// lessons, and one line saying where the rest is. Everything else is a tool
// call away. Header is byte-stable; no date.
function writeSessionBrief(lessons) {
  try {
    const lines = ['# What Next | Session Brief', '', DATA_NOTICE, ''];
    if (lessons.length > 0) {
      lines.push('## Lessons (do not repeat these mistakes)');
      for (const f of lessons.slice(0, 5)) lines.push(`- ${truncate(f.content, 200)}`);
      lines.push('');
    }
    lines.push('Project card follows (stack, gotchas, recent work, open tasks). For the portfolio, other projects and');
    lines.push('preferences call `get_context` or `whats_next`, or read ~/.whatnext/context.md. Search memory with');
    lines.push('`search_memories` (time phrases work: "auth decisions in August"). Save a `dump_session` at milestones.');
    writeFileSync(BRIEF_FILE, lines.join('\n') + '\n', 'utf8');
  } catch (err) {
    process.stderr.write(`[sidecar] Failed to write session brief: ${err.message}\n`);
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
Each tool describes itself. Start with \`get_orientation\`, end with \`dump_session\`.
`;
    writeFileSync(COPILOT_INSTRUCTIONS, content, 'utf8');
  } catch (err) {
    process.stderr.write(`[sidecar] Failed to write Copilot instructions: ${err.message}\n`);
  }
}
