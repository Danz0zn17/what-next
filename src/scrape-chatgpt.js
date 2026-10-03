/**
 * What Next - ChatGPT Scraper
 *
 * Opens Chrome, waits for you to log in, then scrapes all conversations
 * in the SAME browser session and imports them into What Next.
 * No session files, no handoffs, no expiry issues.
 *
 * Usage:
 *   node src/scrape-chatgpt.js --login            log in and confirm access, import nothing
 *   node src/scrape-chatgpt.js [--scrape]         log in, then scrape and import
 *   node src/scrape-chatgpt.js --scrape --dry-run count what would be imported
 *
 * Sessions keep each conversation's date, conversations already imported are
 * skipped, and nothing is written inside the package install dir.
 */

import { chromium } from 'playwright';
import { importConversation } from './import-chatgpt.js';

const KNOWN_FLAGS = new Set(['--login', '--scrape', '--dry-run']);
const args = process.argv.slice(2);
const unknown = args.filter(a => !KNOWN_FLAGS.has(a));
if (unknown.length || (args.includes('--login') && args.includes('--scrape'))) {
  console.error('Usage: node src/scrape-chatgpt.js [--login | --scrape] [--dry-run]');
  process.exit(1);
}
const LOGIN_ONLY = args.includes('--login');
const DRY_RUN = args.includes('--dry-run');

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  console.log('\nWhat Next - ChatGPT Scraper\n');
  if (LOGIN_ONLY) console.log('  LOGIN ONLY - checks access, nothing will be imported\n');
  else if (DRY_RUN) console.log('  DRY RUN - nothing will be imported\n');

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
    console.log('\n  Login not detected. Closing.');
    await browser.close();
    process.exit(1);
  }

  if (LOGIN_ONLY) {
    console.log('\n  Logged in and the conversations API answers. Run with --scrape to import.\n');
    await browser.close();
    return;
  }

  console.log('\n  Logged in. Starting scrape...\n');

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

  // Fetch and import each conversation, one at a time
  let imported = 0, skipped = 0, duplicates = 0, errors = 0;

  for (let i = 0; i < allConversations.length; i++) {
    const convo = allConversations[i];
    process.stdout.write(`\r  ${i + 1}/${allConversations.length} - imported: ${imported}, skipped: ${skipped}, already there: ${duplicates}...`);

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
          text: (n.message.content.parts ?? []).filter(p => typeof p === 'string').join(''),
          time: n.message.create_time ?? 0,
        }))
        .filter(m => m.text.trim() && m.role !== 'system')
        .sort((a, b) => a.time - b.time);

      const result = await importConversation({
        id: convo.id,
        title: convo.title ?? detail.title,
        create_time: convo.create_time ?? detail.create_time,
        messages,
      }, { minWords: 80, dryRun: DRY_RUN });

      if (result === 'trivial') { skipped++; continue; }
      if (result === 'duplicate') { duplicates++; continue; }
      imported++;
      await page.waitForTimeout(80);
    } catch {
      errors++;
    }
  }

  console.log('\n');
  console.log('  ─────────────────────────────────');
  console.log(`  Total:           ${allConversations.length}`);
  console.log(`  ${DRY_RUN ? 'Would import' : 'Imported'}:    ${imported}`);
  console.log(`  Already there:   ${duplicates}`);
  console.log(`  Skipped:         ${skipped} (too short)`);
  console.log(`  Errors:          ${errors}`);
  console.log('  ─────────────────────────────────');
  if (!DRY_RUN) console.log(`\n  Done. Open http://localhost:3747 to browse your memories.\n`);

  await browser.close();
}

run().catch(e => { console.error(e.message); process.exit(1); });
