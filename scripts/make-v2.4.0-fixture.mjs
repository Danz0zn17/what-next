// Builds test/fixtures/v2.4.0.db: a What Next v2.4.0 database with sample rows.
// Run from a checkout of v2.4.0 (git worktree add /tmp/wn-240 v2.4.0-or-main):
//   WHATNEXT_DATA_DIR=/tmp/fx HOME=/tmp/fx node /path/to/this/scripts/make-v2.4.0-fixture.mjs && cp /tmp/fx/what-next.db test/fixtures/v2.4.0.db
// test/migration-v250.test.js opens a copy with the current code.
const db = await import(process.cwd() + '/src/db.js');
const { addSession, addFact, upsertProjectIntelligence, archiveFact, recordCurationRun, storeEmbedding } = db;
addSession({ project: 'surf-rides', summary: 'Built the booking flow', decisions: 'Lesson: always run tsc -b before pushing, the host runs it. Never commit node_modules.', next_steps: 'Wire payments', tags: 'booking' });
addSession({ project: 'ulwazi', summary: 'Shipped the hero visual', what_was_built: 'Canvas hero', next_steps: 'SEO pass' });
upsertProjectIntelligence({ project: 'surf-rides', repo_path: 'github.com/Danz0zn17/surf-rides', stack: 'React + Vite + Supabase', deployment: 'Netlify site surf-rides', extra: 'Deposit 50%' });
const a = addFact({ category: 'preference', content: 'South African English, no long dashes' });
const b = addFact({ project: 'surf-rides', category: 'deploy', content: 'Surf Rides is live at https://surf-rides.netlify.app' });
const c = addFact({ project: 'surf-rides', category: 'client', content: 'Surf Rides Co: owner Jo, phone 082 555 1234' });
const d = addFact({ category: 'lesson', content: 'An empty package.json on GitHub means the deploy never worked' });
const e = addFact({ category: 'preference', content: 'South African English, no long dashes please' });
archiveFact(e, a);
recordCurationRun({ dry_run: false, facts_scanned: 5, auto_archived: 1, flagged: 0, report: { ran_at: '2026-10-01T00:00:00Z' } });
storeEmbedding('fact', a, [1, 0, 0]);
// Backdate the volatile facts so they read as old
db.default.prepare("UPDATE facts SET created_at = '2026-08-01 10:00:00' WHERE id IN (?, ?)").run(b, c);
db.default.pragma('wal_checkpoint(TRUNCATE)');
db.default.close();
console.log('ok', { a, b, c, d, e });
