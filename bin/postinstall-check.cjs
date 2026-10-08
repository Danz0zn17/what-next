// Postinstall: confirm the onnxruntime native binding exists. Resolves onnxruntime-node the way Node does,
// so it works when npm hoists it to the parent project's node_modules (project installs) or nests it (global).
const fs = require('fs');
const os = require('os');
const path = require('path');

let binding = null;
try {
  const root = path.dirname(require.resolve('onnxruntime-node/package.json'));
  binding = path.join(root, 'bin', 'napi-v3', os.platform(), os.arch(), 'onnxruntime_binding.node');
} catch {
  // onnxruntime-node not resolvable at all
}
if (!binding || !fs.existsSync(binding)) {
  console.error('FATAL: onnxruntime native binding missing' + (binding ? ' at ' + binding : ' (onnxruntime-node not installed)') + '\nRun: npm install --force');
  process.exit(1);
}
console.log('OK: onnxruntime binding present (' + binding + ')');
