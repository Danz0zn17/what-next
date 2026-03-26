/**
 * What Next — ChatGPT Scraper
 *
 * Opens Chrome, waits for you to log in, then scrapes all conversations
 * in the SAME browser session and imports them into What Next.
 * No session files, no handoffs, no expiry issues.
 *
 * Usage:
 *   node src/scrape-chatgpt.js
 *   node src/scrape-chatgpt.js --dry-run
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const WHATNEXT_API = 'http://localhost:3747';
const DRY_RUN = process.argv.includes('--dry-run');

mkdirSync(DATA_DIR, { recursive: true });

// ── Helpers ───────────────────────────────────────────────────────────────────
function titleToProject(title) {
  return (title ?? 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 50) || 'chatgpt-import';
}

function detectStack(text) {
  const known = ['react','next.js','nextjs','vue','svelte','angular','node','express',
    'fastapi','django','flask','typescript','javascript','python','rust','go',
    'supabase','firebase','postgresql','mongodb','mysql','sqlite','prisma','redis',
    'tailwind','docker','aws','vercel','stripe','openai','anthropic','playwright','graphql'];
  return known.filter(t => text.toLowerCase().includes(t)).join(', ') || undefined;
}

function isWorthImporting(messages) {
  return messages.filter(m => m.role === 'assistant').map(m => m.content).join(' ').split(/\s+/).length > 80;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  console.log('\n🔵 What Next — ChatGPT Scraper\n');
  if (DRY_RUN) console.log('  DRY RUN — nothing will be imported\n');

  // Open real Chrome with stealth flags
  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome',
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--no-first-run',
    ],
  });

  const page = await browser.newPage();
  await page.goto('https://chatgpt.com', { waitUntil: 'domcontentloaded' });

  console.log('  Chrome is open. Log in to ChatGPT...\n');

  // Wait for post-login state: URL must not be an auth/error page
  console.log('  Waiting for you to complete login...\n');
  let loggedIn = false;
  for (let i = 0; i < 180; i++) {
    await page.waitForTimeout(2000);
    try {
      const result = await page.evaluate(async () => {
        const url = window.location.href;
        // Must be on chatgpt.com but NOT on an auth/error page
        if (!url.includes('chatgpt.com')) return { ok: false, reason: 'wrong domain' };
        if (url.includes('/auth') || url.includes('/login') || url.includes('error')) return { ok: false, reason: 'auth page' };
        // Hit the conversations API
        const r = await fetch('/api/v2/conversations?limit=1', { credentials: 'include' });
        return { ok: r.ok, status: r.status, url };
      });
      if (result.ok) { loggedIn = true; break; }
    } catch { /* still loading */ }
    process.stdout.write(`\r  Waiting... (${i * 2}s)`);
  }

  if (!loggedIn) {
    console.log('\n❌ Login not detected. Closing.');
    await browser.close();
    process.exit(1);
  }

  console.log('\n✅ Logged in! Starting scrape...\n');

  // Fetch all conversations (paginated)
  const allConversations = [];
  let offset = 0;
  const limit = 50;

  while (true) {
    const batch = await page.evaluate(async ({ offset, limit }) => {
      const r = await fetch(`/api/v2/conversations?offset=${offset}&limit=${limit}&order=updated`);
      if (!r.ok) return null;
      return r.json();
    }, { offset, limit });

    if (!batch?.items?.length) break;
    allConversations.push(...batch.items);
    process.stdout.write(`\r  Found ${allConversations.length} conversations...`);
    if (batch.items.length < limit) break;
    offset += limit;
    await page.waitForTimeout(300);
  }

  console.log(`\n  Total conversations: ${allConversations.length}\n`);

  // Fetch and import each conversation
  let imported = 0, skipped = 0, errors = 0;

  for (let i = 0; i < allConversations.length; i++) {
    const convo = allConversations[i];
    process.stdout.write(`\r  ${i + 1}/${allConversations.length} — imported: ${imported}, skipped: ${skipped}...`);

    try {
      const detail = await page.evaluate(async (id) => {
        const r = await fetch(`/api/v2/conversation/${id}`);
        if (!r.ok) return null;
        return r.json();
      }, convo.id);

      if (!detail?.mapping) { skipped++; continue; }

      const messages = Object.values(detail.mapping)
        .filter(n => n.message?.content?.content_type === 'text' && n.message?.author)
        .map(n => ({
          role: n.message.author.role,
          content: (n.message.content.parts ?? []).filter(p => typeof p === 'string').join(''),
          time: n.message.create_time ?? 0,
        }))
        .filter(m => m.content.trim() && m.role !== 'system')
        .sort((a, b) => a.time - b.time);

      if (!isWorthImporting(messages)) { skipped++; continue; }

      const title = convo.title ?? 'Untitled';
      const date = convo.create_time ? new Date(convo.create_time * 1000).toISOString().slice(0, 10) : 'unknown';
      const firstUser = messages.find(m => m.role === 'user')?.content ?? '';

      const session = {
        project: titleToProject(title),
        summary: `[ChatGPT Import] "${title}". ${firstUser.slice(0, 250).replace(/\n+/g, ' ').trim()}`,
        stack: detectStack(messages.map(m => m.content).join(' ')),
        tags: `chatgpt-import,${date.slice(0, 7)}`,
      };

      if (!DRY_RUN) {
        const resp = await fetch(`${WHATNEXT_API}/session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(session),
        });
        if (!resp.ok) { errors++; continue; }
      }

      imported++;
      await page.waitForTimeout(80);
    } catch {
      errors++;
    }
  }

  console.log('\n');
  console.log('  ─────────────────────────────────');
  console.log(`  Total:    ${allConversations.length}`);
  console.log(`  Imported: ${imported}`);
  console.log(`  Skipped:  ${skipped} (too short)`);
  console.log(`  Errors:   ${errors}`);
  console.log('  ─────────────────────────────────');
  if (!DRY_RUN) console.log(`\n  ✅ Done. Open http://localhost:3747 to browse your memories.\n`);

  await browser.close();
}

run().catch(e => { console.error(e.message); process.exit(1); });
