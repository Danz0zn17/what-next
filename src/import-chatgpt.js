/**
 * What Next - ChatGPT History Importer
 *
 * Usage:
 *   node src/import-chatgpt.js /path/to/conversations.json
 *
 * Reads your ChatGPT export, finds WHAT NEXT DUMP blocks where they exist,
 * and creates summarised sessions for all other conversations worth keeping.
 * Each session keeps the conversation's own date, and a conversation that was
 * already imported is skipped, so running the import twice is safe.
 *
 * The helpers are exported for scrape-chatgpt.js; the CLI only runs when this
 * file is executed directly.
 */

import { readFileSync, realpathSync } from 'fs';
import { fileURLToPath } from 'url';
import db, { addSession } from './db.js';
import { sanitizeFields, SESSION_TEXT_FIELDS } from './sanitize.js';
import { indexSession } from './indexer.js';

// ─── Extract messages from a conversation node tree ───────────────────────────
export function extractMessages(mapping) {
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
export function findDumpBlock(messages) {
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
// Unicode-aware so non-Latin titles keep their words; never returns ''.
export function titleToProject(title) {
  const slug = String(title ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 50)
    .replace(/^-+|-+$/g, '');
  return slug || 'chatgpt-import';
}

// ChatGPT exports give create_time as epoch seconds; the web API gives an ISO
// string. Returns the SQLite form "YYYY-MM-DD HH:MM:SS" (UTC) or null.
export function toSessionDate(createTime) {
  if (createTime == null || createTime === '') return null;
  const d = typeof createTime === 'number' ? new Date(createTime * 1000) : new Date(createTime);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

// ─── Build a basic summary from messages ─────────────────────────────────────
function buildSummary(title, messages) {
  const firstUser = messages.find(m => m.role === 'user')?.text ?? '';
  const preview = (str) => str.slice(0, 300).replace(/\n+/g, ' ').trim();
  return `[Imported from ChatGPT] "${title}". Started with: ${preview(firstUser)}`;
}

export function buildStack(messages) {
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
export function isWorthImporting(messages, minWords = 100) {
  const assistantWords = messages
    .filter(m => m.role === 'assistant')
    .map(m => m.text)
    .join(' ')
    .split(/\s+/).length;
  return assistantWords > minWords; // skip quick one-liners
}

const conversationTag = id => (typeof id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(id) ? `chatgpt:${id}` : null);

// True when this conversation is already stored: by its ChatGPT id tag when it
// has one, otherwise by the same summary on the same date.
export function alreadyImported({ id, summary, sessionDate }) {
  const tag = conversationTag(id);
  if (tag) {
    const rows = db.prepare(`SELECT tags FROM sessions WHERE tags LIKE ?`).all(`%${tag}%`);
    if (rows.some(r => String(r.tags).split(',').map(t => t.trim()).includes(tag))) return true;
  }
  if (!sessionDate) return false;
  const { values } = sanitizeFields({ summary }, SESSION_TEXT_FIELDS);
  return !!db.prepare(`SELECT 1 FROM sessions WHERE summary = ? AND substr(replace(session_date, 'T', ' '), 1, 19) = ?`)
    .get(values.summary, sessionDate);
}

/**
 * Store one conversation as a session, keeping its date, then index it.
 * conversation: { id, title, create_time, messages: [{ role, text }] }
 * Returns 'imported' | 'dump' | 'duplicate' | 'trivial'.
 */
export async function importConversation({ id, title, create_time, messages }, { minWords = 100, dryRun = false, index = true } = {}) {
  title = title ?? 'Untitled';
  if (!isWorthImporting(messages, minWords)) return 'trivial';
  const sessionDate = toSessionDate(create_time);
  const tag = conversationTag(id);

  const dump = findDumpBlock(messages);
  const fields = dump
    ? { ...dump }
    : {
        project: titleToProject(title),
        summary: buildSummary(title, messages),
        stack: buildStack(messages),
        tags: ['chatgpt-import', sessionDate ? sessionDate.slice(0, 7) : null].filter(Boolean).join(','),
      };
  if (tag) fields.tags = [fields.tags, tag].filter(Boolean).join(',');

  if (alreadyImported({ id, summary: fields.summary, sessionDate })) return 'duplicate';
  if (dryRun) return dump ? 'dump' : 'imported';

  const rowId = addSession(fields);
  if (sessionDate) db.prepare('UPDATE sessions SET session_date = ? WHERE id = ?').run(sessionDate, rowId);
  if (index) await indexSession(rowId, fields);
  return dump ? 'dump' : 'imported';
}

// ─── CLI ──────────────────────────────────────────────────────────────────────
async function main() {
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

  let imported = 0;
  let skipped = 0;
  let duplicates = 0;
  let fromDumpBlock = 0;

  // Sequential on purpose: each session is stored and indexed before the next.
  for (const convo of conversations) {
    const title = convo.title ?? 'Untitled';
    const result = await importConversation({
      id: convo.id ?? convo.conversation_id,
      title,
      create_time: convo.create_time,
      messages: extractMessages(convo.mapping),
    });
    if (result === 'trivial') { skipped++; continue; }
    if (result === 'duplicate') { duplicates++; continue; }
    if (result === 'dump') fromDumpBlock++;
    imported++;
    console.log(`  [${result === 'dump' ? 'DUMP BLOCK' : 'AUTO'}] ${toSessionDate(convo.create_time)?.slice(0, 10) ?? 'unknown date'} - ${title.slice(0, 60)}`);
  }

  console.log(`
─────────────────────────────────────────────
  Import complete
  Total conversations: ${conversations.length}
  Imported:           ${imported}
    ↳ From dump blocks: ${fromDumpBlock}
    ↳ Auto-summarised:  ${imported - fromDumpBlock}
  Already imported:   ${duplicates}
  Skipped (trivial):  ${skipped}
─────────────────────────────────────────────

Your What Next brain now has ${imported} new sessions from your ChatGPT history.
Open http://localhost:3747 to browse them.

TIP: The auto-summarised sessions are basic - just titles and stack detection.
They give your AI tools context about what you've worked on, which is the main goal.
`);
}

const isMain = (() => {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) main().catch(e => { console.error(e.message); process.exit(1); });
