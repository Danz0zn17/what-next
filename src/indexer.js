// Local vector indexing on write. Every local writer (MCP tools, REST API,
// imports) calls these after the row is stored so semantic search sees it
// without waiting for a cloud echo. Fire and forget: never throws, never blocks
// the write path, and embeddings load lazily (native onnxruntime can be slow on boot).
import { storeEmbedding } from './db.js';

let embeddingsPromise = null;
function loadEmbeddings() {
  if (!embeddingsPromise) {
    embeddingsPromise = import('./embeddings.js').catch((err) => {
      process.stderr.write(`[indexer] embeddings unavailable - vector indexing skipped: ${err.message}\n`);
      return null;
    });
  }
  return embeddingsPromise;
}

export function sessionText(s) {
  return [s.summary, s.what_was_built, s.decisions, s.next_steps, s.tags].filter(Boolean).join(' ');
}

export function factText(f) {
  return [f.category, f.content, f.tags].filter(Boolean).join(' ');
}

async function index(rowtype, id, text) {
  if (!id || !text) return false;
  try {
    const mod = await loadEmbeddings();
    if (!mod?.generateEmbedding) return false;
    storeEmbedding(rowtype, id, await mod.generateEmbedding(text));
    return true;
  } catch (err) {
    process.stderr.write(`[indexer] ${rowtype} ${id} not indexed: ${err.message}\n`);
    return false;
  }
}

// Returns a promise that always resolves (true when indexed); callers may ignore it.
export function indexSession(id, fields) {
  return index('session', id, sessionText(fields));
}

export function indexFact(id, fields) {
  return index('fact', id, factText(fields));
}
