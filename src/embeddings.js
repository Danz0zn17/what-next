import { rmSync } from 'fs';
import { join } from 'path';
import { pipeline, env } from '@huggingface/transformers';

const MODEL = 'Xenova/all-MiniLM-L6-v2';

// One shared load: concurrent callers wait on the same promise instead of
// each loading the model. Parallel first loads each download the model into
// the same cache file and corrupt it ("Protobuf parsing failed"), after which
// every load fails until the cache is cleared (GRE-375).
// A failed load is forgotten so the next call retries. A corrupt cached model
// is deleted and fetched again once before giving up.
export function createEmbedderLoader({ load, clearCache }) {
  let promise = null;
  return function getEmbedder() {
    if (!promise) {
      promise = load()
        .catch((err) => {
          if (!/protobuf parsing failed/i.test(err?.message ?? '')) throw err;
          clearCache();
          return load();
        })
        .catch((err) => { promise = null; throw err; });
    }
    return promise;
  };
}

const getEmbedder = createEmbedderLoader({
  // dtype set explicitly: without it transformers.js prints a "dtype not
  // specified" notice to stderr on every load, which log drains read as an error.
  load: () => pipeline('feature-extraction', MODEL, { device: 'cpu', dtype: 'fp32' }),
  clearCache: () => rmSync(join(env.cacheDir, MODEL), { recursive: true, force: true }),
});

// Load the model ahead of the first search so semantic_search does not pay
// the cold start inside its tool timeout. Never throws.
export function warmEmbedder() {
  return getEmbedder().then(() => true, () => false);
}

export async function generateEmbedding(text) {
  const model = await getEmbedder();
  const output = await model(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

export function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
