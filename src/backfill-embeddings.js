// Run once to generate embeddings for all existing sessions and facts
// Usage: node src/backfill-embeddings.js

import db, { storeEmbedding } from './db.js';
import { generateEmbedding } from './embeddings.js';

const sessions = db.prepare('SELECT s.*, p.name as project_name FROM sessions s JOIN projects p ON p.id = s.project_id').all();
const facts = db.prepare('SELECT * FROM facts').all();

console.log(`Backfilling ${sessions.length} sessions and ${facts.length} facts...`);

for (const s of sessions) {
  const existing = db.prepare('SELECT id FROM embeddings WHERE rowtype = ? AND row_id = ?').get('session', s.id);
  if (existing) { process.stdout.write('.'); continue; }
  const text = [s.summary, s.what_was_built, s.decisions, s.next_steps, s.tags].filter(Boolean).join(' ');
  const emb = await generateEmbedding(text);
  storeEmbedding('session', s.id, emb);
  process.stdout.write('S');
}

for (const f of facts) {
  const existing = db.prepare('SELECT id FROM embeddings WHERE rowtype = ? AND row_id = ?').get('fact', f.id);
  if (existing) { process.stdout.write('.'); continue; }
  const text = [f.category, f.content, f.tags].filter(Boolean).join(' ');
  const emb = await generateEmbedding(text);
  storeEmbedding('fact', f.id, emb);
  process.stdout.write('F');
}

console.log('\nDone.');
