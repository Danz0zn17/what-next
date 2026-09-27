import { pipeline } from '@huggingface/transformers';

// One shared load: concurrent callers wait on the same promise instead of
// each loading the model. A failed load is forgotten so the next call retries.
let embedderPromise = null;

function getEmbedder() {
  if (!embedderPromise) {
    embedderPromise = pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')
      .catch((err) => { embedderPromise = null; throw err; });
  }
  return embedderPromise;
}

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
