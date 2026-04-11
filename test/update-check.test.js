import test from 'node:test';
import assert from 'node:assert/strict';
import { isUpdateAvailable, buildUpdateNotice } from '../src/update-check.js';

test('detects newer patch/minor/major versions', () => {
  assert.equal(isUpdateAvailable('1.1.0', 'v1.1.1'), true);
  assert.equal(isUpdateAvailable('1.1.0', 'v1.2.0'), true);
  assert.equal(isUpdateAvailable('1.1.0', 'v2.0.0'), true);
});

test('does not flag same or older versions', () => {
  assert.equal(isUpdateAvailable('1.1.0', 'v1.1.0'), false);
  assert.equal(isUpdateAvailable('1.1.0', 'v1.0.9'), false);
});

test('handles invalid version strings safely', () => {
  assert.equal(isUpdateAvailable('1.1.0', 'latest'), false);
  assert.equal(isUpdateAvailable('dev', 'v1.2.0'), false);
});

test('builds user-facing notice only when update is available', () => {
  const notice = buildUpdateNotice('1.1.0', 'v1.1.1');
  assert.equal(typeof notice, 'string');
  assert.match(notice, /Update available: v1\.1\.1/);

  const none = buildUpdateNotice('1.1.1', 'v1.1.1');
  assert.equal(none, null);
});
