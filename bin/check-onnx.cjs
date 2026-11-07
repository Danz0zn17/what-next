#!/usr/bin/env node
// postinstall: fail the install early if the onnxruntime native binding is
// missing, instead of failing later on the first embedding. The binding is
// found the way Node finds the module: npm may hoist onnxruntime-node to the
// install root, nest it under this package, or under @huggingface/transformers.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const rel = path.join('bin', 'napi-v3', os.platform(), os.arch(), 'onnxruntime_binding.node');

// Walk up from `from` through each node_modules, as Node's resolver does. Done
// by hand because a package's "exports" can hide its package.json from
// require.resolve (@huggingface/transformers does).
function pkgDir(name, from) {
  for (let dir = path.resolve(from); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return fs.realpathSync(candidate);
    if (path.dirname(dir) === dir) return null;
  }
}

const roots = [__dirname];
const transformers = pkgDir('@huggingface/transformers', __dirname);
if (transformers) roots.push(transformers);

const tried = [];
for (const from of roots) {
  const dir = pkgDir('onnxruntime-node', from);
  if (!dir) continue;
  const binding = path.join(dir, rel);
  if (fs.existsSync(binding)) {
    console.log(`OK: onnxruntime binding present (${binding})`);
    process.exit(0);
  }
  if (!tried.includes(binding)) tried.push(binding);
}

console.error(tried.length
  ? `FATAL: onnxruntime native binding missing at ${tried.join(', ')}\nRun: npm install --force`
  : 'FATAL: onnxruntime-node is not installed (needed by @huggingface/transformers)\nRun: npm install --force');
process.exit(1);
