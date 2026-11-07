import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmbedderLoader } from '../src/embeddings.js';

const tick = () => new Promise((r) => setTimeout(r, 5));

test('concurrent first calls share one model load (GRE-375)', async () => {
  let loads = 0;
  const get = createEmbedderLoader({
    load: async () => { loads++; await tick(); return 'model'; },
    clearCache: () => assert.fail('cache must not be cleared'),
  });
  const models = await Promise.all([get(), get(), get()]);
  assert.deepEqual(models, ['model', 'model', 'model']);
  assert.equal(loads, 1);
});

test('a corrupt cached model is cleared and fetched again', async () => {
  let loads = 0, cleared = 0;
  const get = createEmbedderLoader({
    load: async () => {
      loads++;
      if (cleared === 0) throw new Error('Load model from /x/model.onnx failed:Protobuf parsing failed.');
      return 'model';
    },
    clearCache: () => { cleared++; },
  });
  assert.equal(await get(), 'model');
  assert.equal(cleared, 1);
  assert.equal(loads, 2);
});

test('other load errors are not swallowed, and the next call retries', async () => {
  let loads = 0;
  const get = createEmbedderLoader({
    load: async () => { if (++loads === 1) throw new Error('fetch failed'); return 'model'; },
    clearCache: () => assert.fail('cache must not be cleared for network errors'),
  });
  await assert.rejects(get(), /fetch failed/);
  assert.equal(await get(), 'model');
  assert.equal(loads, 2);
});
