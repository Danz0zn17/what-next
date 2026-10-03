/**
 * What Next - Smart Context Card writer
 *
 * Writes per-project and global context files to ~/.whatnext/agents/ so any
 * AI tool (with or without MCP) can read them at session start.
 *
 * Files written:
 *   ~/.whatnext/agents/{project}.md  - per-project orientation card
 *   ~/.whatnext/context.md           - global pointer + cross-project brief
 *   ~/.copilot/copilot-instructions.md - a generic managed block pointing Copilot
 *                                        CLI at the cards (only when ~/.copilot exists;
 *                                        text outside the block is kept)
 *   ~/.whatnext/brief.md             - six-line session brief: global lessons + where the rest lives.
 *                                        Inject this plus the project card at session start and pull
 *                                        the full brief on demand.
 *   {repo}/AGENTS.md                  - pointer block (only when AGENTS.md exists
 *                                        or the repo has neither AGENTS.md nor CLAUDE.md)
 *
 * The card header is byte-stable between writes (the updated date lives in the
 * footer) so a hook that injects it does not break prompt caching every day.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync, realpathSync, statSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { getProjectIntelligence, getRecentSessions, getRecentSessionsForProject, getWhatsNext, getAllFacts, listProjects, getRecentCommits, getHotFiles } from './db.js';
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
}

// Write only when the bytes differ, so editors and file watchers do not see a
// change on every commit.
function writeIfChanged(path, content) {
  try {
    if (readFileSync(path, 'utf8') === content) return false;
  } catch {}
  writeFileSync(path, content, 'utf8');
  return true;
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

// Single-line slots (bullets, commit subjects, summaries): stored newlines are
// flattened so a memory cannot open its own "## " section on the card.
function oneLine(v) {
  return clean(v).replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ').trim();
}

function truncate(str, n) {
  if (!str) return '';
  const s = oneLine(str);
  return s.length > n ? s.slice(0, n - 3) + '...' : s;
}

// Multi-line slots keep their lines, but a line that would read as a heading
// or a section rule is escaped so it renders as text inside its section.
function block(v) {
  return clean(v)
    .split(/\r?\n|\r|\u2028|\u2029/)
    .map(l => (/^\s{0,3}(?:#{1,6}(?:\s|$)|-{3,}\s*$|={3,}\s*$|\*{3,}\s*$|_{3,}\s*$)/.test(l) ? `\\${l.trimStart()}` : l))
    .join('\n');
}

// A project name interpolated into a heading, a pointer line or YAML
// frontmatter: one line, no leading heading/quote markers, no "---".
function inlineName(projectName) {
  return oneLine(projectName)
    .replace(/-{3,}/g, '-')
    .replace(/[`]/g, "'")
    .replace(/^[#>\s-]+/, '')
    .slice(0, 100) || 'project';
}

// Repo files and Copilot instructions point at the card by a home-relative
// path, so no absolute home directory lands in a committed file.
function cardRef(projectName) {
  return `~/.whatnext/agents/${cardFileName(projectName)}`;
}

// Card filename for a project. Ordinary names ("what-next", "gooner-news")
// map to themselves so existing cards and hooks keep working; anything that
// could leave AGENTS_DIR (separators, leading dots) is flattened.
export function cardFileName(projectName) {
  const slug = String(projectName ?? '')
    .replace(/[^\p{L}\p{N}._ -]+/gu, '-')
    .replace(/^[.\s-]+/, '')
    .slice(0, 100)
    .trim();
  return `${slug || 'project'}.md`;
}

export function cardPathFor(projectName) {
  const root = resolve(AGENTS_DIR);
  const filePath = resolve(root, cardFileName(projectName));
  if (!filePath.startsWith(root + sep)) throw new Error(`card path escapes ${root}`);
  return filePath;
}

function projectsDir() {
  return process.env.WHATNEXT_PROJECTS_DIR || join(homedir(), 'projects');
}

// A repo path from project intelligence is caller-supplied. Only write the
// AGENTS.md / Cursor pointer into an existing git repo under the projects dir
// (WHATNEXT_PROJECTS_DIR or ~/projects, the same root the watcher polls).
// Returns the resolved repo path, or null with the reason.
export function allowedRepoPath(repoPath) {
  let root;
  try {
    root = realpathSync(projectsDir());
  } catch {
    return { path: null, reason: `projects dir ${projectsDir()} does not exist` };
  }
  try {
    const real = realpathSync(resolve(String(repoPath)));
    if (!real.startsWith(root + sep)) return { path: null, reason: `not inside ${root}` };
    if (!statSync(real).isDirectory() || !existsSync(join(real, '.git'))) return { path: null, reason: 'not a git repo' };
    return { path: real, reason: null };
  } catch {
    return { path: null, reason: 'path does not exist' };
  }
}

// Returns { ok, path, repo } so a caller can report what actually happened.
// Never throws.
export function writeSidecarForProject(projectName) {
  try {
    ensureDirs();
    const intel = getProjectIntelligence(projectName);
    const sessions = getRecentSessionsForProject(projectName, 3);
    const commits = getRecentCommits(projectName, 5);
    const whatsNext = getWhatsNext(20).find(i => i.project_name === projectName);
    const projectFacts = getAllFacts().filter(f => f.project_name === projectName);
    const lessons = projectFacts.filter(f => f.category === 'lesson').slice(0, 8);
    const tours = projectFacts.filter(f => f.category === 'tour').slice(0, 6);
    const hotFiles = getHotFiles(projectName);

    const lines = [];
    lines.push(`# ${oneLine(projectName)} | What Next Context`);
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
      if (safe(intel.repo_path)) lines.push(`**Repo:** ${oneLine(intel.repo_path)}`);
      if (safe(intel.stack)) lines.push(`**Stack:** ${oneLine(intel.stack)}`);
      if (safe(intel.deployment)) lines.push(`**Deployment:** ${oneLine(intel.deployment)}`);
      if (safe(intel.env_vars)) lines.push(`**Env vars (keys only):** ${oneLine(intel.env_vars)}`);
      lines.push('');

      if (safe(intel.key_dirs)) {
        lines.push('## Where Things Live');
        lines.push(block(intel.key_dirs));
        lines.push('');
      }

      if (safe(intel.conventions)) {
        lines.push('## Conventions & Patterns');
        lines.push(block(intel.conventions));
        lines.push('');
      }

      if (safe(intel.extra)) {
        lines.push('## Key Decisions');
        lines.push(block(intel.extra));
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
      for (const h of hotFiles) lines.push(`- ${oneLine(h.file)} (${h.commits} commit${h.commits === 1 ? '' : 's'})`);
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
      lines.push(block(whatsNext.next_steps));
      lines.push('');
    }

    if (commits.length > 0) {
      lines.push('## Recent Commits');
      for (const c of commits) {
        const hash = oneLine(c.commit_hash).replace(/`/g, '').slice(0, 7);
        lines.push(`- \`${hash}\` ${truncate(c.message, 80)}`);
      }
      lines.push('');
    }

    lines.push('---');
    lines.push(`_Updated ${new Date().toISOString().split('T')[0]}. This file is auto-maintained by What Next. Do not edit manually._`);

    const filePath = cardPathFor(projectName);
    const content = lines.join('\n');
    writeFileSync(filePath, content, 'utf8');
    if (content.length > CARD_WARN_CHARS) {
      process.stderr.write(`[sidecar] ${projectName} card is ${content.length} chars (~${Math.round(content.length / 4)} tokens) - trim project intelligence to keep orientation cheap\n`);
    }

    // Auto-write .cursorrules / AGENTS.md pointer if the repo is known
    let repo = null;
    if (intel?.repo_path) {
      const { path: repoPath, reason } = allowedRepoPath(intel.repo_path);
      if (repoPath) {
        writeCursorRules(projectName, repoPath);
        writeAgentsMd(projectName, repoPath);
        repo = `pointer checked in ${repoPath}`;
      } else {
        repo = `repo pointer skipped (${reason})`;
      }
    }
    return { ok: true, path: filePath, repo };
  } catch (err) {
    process.stderr.write(`[sidecar] Failed to write sidecar for ${projectName}: ${err.message}\n`);
    return { ok: false, error: err.message };
  }
}

// Pointer only: the card itself (commit hashes, paths, env var names) never
// lands in a repo file, and the block only changes when the project does.
function writeCursorRules(projectName, repoPath) {
  try {
    const cursorDir = join(repoPath, '.cursor');
    const cursorRulesPath = join(repoPath, '.cursorrules');
    const rulesPath = join(cursorDir, 'rules');
    const hasCursorRules = existsSync(cursorRulesPath);
    const hasRules = existsSync(rulesPath);

    // Only repos already set up for Cursor rules; never create .cursor/rules.
    if (!hasCursorRules && !hasRules) return;

    const marker = '# [What Next] Auto-managed block - do not edit below this line';
    const block = [
      marker,
      `# Context card for ${inlineName(projectName)}: ${cardRef(projectName)}`,
      '# Read it at the start of every session. It holds the stack, key dirs, conventions,',
      '# recent work and open tasks, updated automatically on every session dump and git commit.',
      '',
    ].join('\n');

    // Append (or replace) the managed block in a rules file, keeping whatever
    // the user wrote above the marker.
    const mergeInto = (path) => {
      const existing = readFileSync(path, 'utf8');
      const markerIdx = existing.indexOf(marker);
      const base = markerIdx >= 0 ? existing.slice(0, markerIdx).trimEnd() : existing.trimEnd();
      writeIfChanged(path, base ? `${base}\n\n${block}` : block);
    };

    if (hasCursorRules) {
      mergeInto(cursorRulesPath);
      return;
    }
    // Current Cursor reads .cursor/rules/*.mdc; older builds read a single
    // .cursor/rules file. Only ever write our own managed file in the dir.
    if (!statSync(rulesPath).isDirectory()) {
      mergeInto(rulesPath);
      return;
    }
    const mdcPath = join(rulesPath, 'what-next.mdc');
    if (existsSync(mdcPath) && !readFileSync(mdcPath, 'utf8').includes(marker)) return; // user file, leave it
    const description = inlineName(projectName).replace(/[:#'"]/g, ' ').replace(/\s+/g, ' ').trim() || 'project';
    const frontmatter = ['---', `description: What Next context card for ${description}`, 'alwaysApply: true', '---', ''].join('\n');
    writeIfChanged(mdcPath, frontmatter + block);
  } catch {
    // cursor rules write is best-effort, never throw
  }
}

// Claude Code reads AGENTS.md when there is no CLAUDE.md; Codex and Copilot read
// it always. One managed block points all of them at the card.
function writeAgentsMd(projectName, repoPath) {
  try {
    const agentsPath = join(repoPath, 'AGENTS.md');
    const hasAgents = existsSync(agentsPath);
    if (!hasAgents && existsSync(join(repoPath, 'CLAUDE.md'))) return;
    if (!hasAgents && !existsSync(join(repoPath, '.git'))) return;

    const marker = '<!-- What Next: auto-managed block - do not edit below this line -->';
    const block = [
      marker,
      '## Orientation (What Next)',
      `Read \`${cardRef(projectName)}\` at the start of every session. It holds the stack, key dirs,`,
      `conventions, recent work and open tasks for ${inlineName(projectName)}, updated on every session dump and commit.`,
      '',
    ].join('\n');

    if (hasAgents) {
      const existing = readFileSync(agentsPath, 'utf8');
      const markerIdx = existing.indexOf(marker);
      const base = markerIdx >= 0 ? existing.slice(0, markerIdx).trimEnd() : existing.trimEnd();
      const next = base ? `${base}\n\n${block}` : block;
      if (next !== existing) writeFileSync(agentsPath, next, 'utf8');
    } else {
      writeFileSync(agentsPath, `# ${inlineName(projectName)}\n\n${block}`, 'utf8');
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
        lines.push(`| ${oneLine(p.name)} | ${last} |`);
      }
      lines.push('');
    }

    if (recentSessions.length > 0) {
      lines.push('## Recent Work');
      for (const s of recentSessions) {
        lines.push(`**[${oneLine(s.project_name)}]** ${formatDate(s.session_date)}: ${truncate(s.summary, 200)}`);
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
        lines.push(`- **${oneLine(f.category)}:** ${truncate(f.content, 200)}`);
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

const COPILOT_START = '<!-- What Next: managed block start - edits inside this block are overwritten -->';
const COPILOT_END = '<!-- What Next: managed block end -->';
const COPILOT_BLOCK = [
  COPILOT_START,
  '## What Next memory',
  'At the start of a session:',
  '1. Identify the project from the workspace folder name.',
  '2. Read `~/.whatnext/agents/{project-name}.md` if it exists: stack, key dirs, conventions, recent work and open tasks.',
  '   It is generated automatically, so read it but do not edit it.',
  '3. If there is no project card, read `~/.whatnext/context.md` for the cross-project overview.',
  '',
  'What Next MCP tools (if available): Each tool describes itself. Start with `get_orientation`, and save',
  'progress with `dump_session` at milestones and at the end of a session.',
  COPILOT_END,
].join('\n');

// Earlier releases replaced the whole file with one person's instructions.
// Recognised only by that generated text, so a file the user wrote is never
// treated as legacy.
function isLegacyCopilotFile(text) {
  return text.startsWith("# Danny's Copilot Instructions")
    && text.includes('~/.whatnext/agents/{project-name}.md')
    && text.includes('## What Next MCP tools');
}

// Keeps a managed block in ~/.copilot/copilot-instructions.md; text outside
// the markers is the user's. Exported for tests.
// Returns 'skipped' | 'unchanged' | 'written' | 'migrated'.
export function writeCopilotInstructions() {
  try {
    // Only for people who use Copilot CLI; never create ~/.copilot.
    if (!existsSync(COPILOT_DIR) || !statSync(COPILOT_DIR).isDirectory()) return 'skipped';

    let existing = null;
    try { existing = readFileSync(COPILOT_INSTRUCTIONS, 'utf8'); } catch {}

    if (existing != null && isLegacyCopilotFile(existing)) {
      const backup = `${COPILOT_INSTRUCTIONS}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      copyFileSync(COPILOT_INSTRUCTIONS, backup);
      writeFileSync(COPILOT_INSTRUCTIONS, COPILOT_BLOCK + '\n', 'utf8');
      process.stderr.write(`[sidecar] Replaced the old generated Copilot instructions; previous file kept at ${backup}\n`);
      return 'migrated';
    }

    let next;
    if (existing == null || existing.trim() === '') {
      next = COPILOT_BLOCK + '\n';
    } else {
      const startIdx = existing.indexOf(COPILOT_START);
      if (startIdx < 0) {
        next = `${existing.trimEnd()}\n\n${COPILOT_BLOCK}\n`;
      } else {
        const endIdx = existing.indexOf(COPILOT_END, startIdx);
        const after = endIdx >= 0 ? existing.slice(endIdx + COPILOT_END.length) : '\n';
        next = existing.slice(0, startIdx) + COPILOT_BLOCK + after;
      }
    }
    if (next === existing) return 'unchanged';
    writeFileSync(COPILOT_INSTRUCTIONS, next, 'utf8');
    return 'written';
  } catch (err) {
    process.stderr.write(`[sidecar] Failed to write Copilot instructions: ${err.message}\n`);
    return 'skipped';
  }
}
