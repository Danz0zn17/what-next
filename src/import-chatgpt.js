/**
 * What Next — ChatGPT History Importer
 *
 * Usage:
 *   node src/import-chatgpt.js /path/to/conversations.json
 *
 * Reads your ChatGPT export, finds WHAT NEXT DUMP blocks where they exist,
 * and creates summarised sessions for all other conversations worth keeping.
 */

import { readFileSync } from 'fs';
import { addSession } from './db.js';

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: node src/import-chatgpt.js /path/to/conversations.json');
  process.exit(1);
}

let raw;
try {
  raw = readFileSync(filePath, 'utf-8');
} catch {
  console.error(`Cannot read file: ${filePath}`);
  process.exit(1);
}

const conversations = JSON.parse(raw);
console.log(`\nLoaded ${conversations.length} conversations from ChatGPT export.\n`);

// ─── Extract messages from a conversation node tree ───────────────────────────
function extractMessages(mapping) {
  if (!mapping) return [];
  const nodes = Object.values(mapping);
  // Sort by create_time so messages are in order
  const messages = nodes
    .filter(n => n.message && n.message.content && n.message.author)
    .map(n => ({
      role: n.message.author.role,
      text: (n.message.content.parts ?? [])
        .filter(p => typeof p === 'string')
        .join(''),
      time: n.message.create_time ?? 0,
    }))
    .filter(m => m.text.trim() && m.role !== 'system')
    .sort((a, b) => a.time - b.time);
  return messages;
}

// ─── Try to find an existing WHAT NEXT DUMP block in messages ──────────────
function findDumpBlock(messages) {
  for (const m of [...messages].reverse()) {
    const match = m.text.match(/---WHAT NEXT DUMP---([\s\S]*?)(?:---END DUMP---|$)/i);
    if (!match) continue;
    const block = match[1];
    const get = (key) => {
      const r = block.match(new RegExp(`${key}:\\s*(.+?)(?=\\n[A-Z]|$)`, 'is'));
      return r ? r[1].trim() : undefined;
    };
    const project = get('PROJECT');
    const summary = get('SUMMARY');
    if (project && summary) {
      return {
        project,
        summary,
        what_was_built: get('BUILT'),
        decisions: get('DECISIONS'),
        stack: get('STACK'),
        next_steps: get('NEXT'),
        tags: get('TAGS'),
      };
    }
  }
  return null;
}

// ─── Derive a project name from the conversation title ────────────────────────
function titleToProject(title) {
  return (title ?? 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 50);
}

// ─── Build a basic summary from messages ─────────────────────────────────────
function buildSummary(title, messages) {
  const firstUser = messages.find(m => m.role === 'user')?.text ?? '';
  const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant')?.text ?? '';
  const preview = (str) => str.slice(0, 300).replace(/\n+/g, ' ').trim();
  return `[Imported from ChatGPT] "${title}". Started with: ${preview(firstUser)}`;
}

function buildStack(messages) {
  const allText = messages.map(m => m.text).join(' ').toLowerCase();
  const known = ['react','next.js','nextjs','vue','angular','svelte','node','express','fastapi','django','flask',
    'typescript','javascript','python','rust','go','java','php','ruby','swift','kotlin',
    'supabase','firebase','mongodb','postgresql','mysql','sqlite','redis','prisma',
    'tailwind','shadcn','chakra','docker','kubernetes','aws','gcp','vercel','stripe',
    'openai','anthropic','langchain','trpc','graphql','rest'];
  const found = known.filter(t => allText.includes(t));
  return found.length ? found.join(', ') : undefined;
}

// ─── Skip conversations that are too short or trivial ─────────────────────────
function isWorthImporting(messages) {
  const assistantWords = messages
    .filter(m => m.role === 'assistant')
    .map(m => m.text)
    .join(' ')
    .split(/\s+/).length;
  return assistantWords > 100; // skip quick one-liners
}

// ─── Main import loop ─────────────────────────────────────────────────────────
let imported = 0;
let skipped = 0;
let fromDumpBlock = 0;

for (const convo of conversations) {
  const title = convo.title ?? 'Untitled';
  const messages = extractMessages(convo.mapping);
  const date = convo.create_time
    ? new Date(convo.create_time * 1000).toISOString().slice(0, 10)
    : 'unknown date';

  if (!isWorthImporting(messages)) {
    skipped++;
    continue;
  }

  // Try to find an existing dump block first
  const dump = findDumpBlock(messages);
  if (dump) {
    addSession(dump);
    console.log(`  [DUMP BLOCK] ${dump.project} — ${dump.summary.slice(0, 60)}...`);
    fromDumpBlock++;
    imported++;
    continue;
  }

  // Otherwise build a basic session from the conversation
  const project = titleToProject(title);
  const summary = buildSummary(title, messages);
  const stack = buildStack(messages);
  const tags = ['chatgpt-import', date.slice(0, 7)].join(','); // e.g. chatgpt-import,2024-11

  addSession({ project, summary, stack, tags });
  console.log(`  [AUTO] ${project} (${date}) — ${title.slice(0, 60)}`);
  imported++;
}

console.log(`
─────────────────────────────────────────────
  Import complete
  Total conversations: ${conversations.length}
  Imported:           ${imported}
    ↳ From dump blocks: ${fromDumpBlock}
    ↳ Auto-summarised:  ${imported - fromDumpBlock}
  Skipped (trivial):  ${skipped}
─────────────────────────────────────────────

Your What Next brain now has ${imported} sessions from your ChatGPT history.
Open http://localhost:3747 to browse them.

TIP: The auto-summarised sessions are basic — just titles and stack detection.
They give Claude Code context about what you've worked on, which is the main goal.
`);
