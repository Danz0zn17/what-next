import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfigPath, isSupportedClient, isVscodeLikeClient } from '../src/platform-config.js';

test('supports expected clients', () => {
  assert.equal(isSupportedClient('vscode'), true);
  assert.equal(isSupportedClient('copilot'), true);
  assert.equal(isSupportedClient('claude'), true);
  assert.equal(isSupportedClient('cursor'), true);
  assert.equal(isSupportedClient('windsurf'), true);
  assert.equal(isSupportedClient('openclaw'), false);
});

test('detects vscode-like clients', () => {
  assert.equal(isVscodeLikeClient('vscode'), true);
  assert.equal(isVscodeLikeClient('copilot'), true);
  assert.equal(isVscodeLikeClient('claude'), false);
});

test('resolves windows vscode path using APPDATA', () => {
  const p = resolveConfigPath('vscode', 'win32', 'C:/Users/alex', 'C:/Users/alex/AppData/Roaming');
  assert.equal(p, 'C:/Users/alex/AppData/Roaming/Code/User/mcp.json');
});

test('resolves mac claude path', () => {
  const p = resolveConfigPath('claude', 'darwin', '/Users/alex');
  assert.equal(p, '/Users/alex/Library/Application Support/Claude/claude_desktop_config.json');
});

test('falls back to linux path for unknown platform', () => {
  const p = resolveConfigPath('cursor', 'freebsd', '/home/alex');
  assert.equal(p, '/home/alex/.cursor/mcp.json');
});

test('returns null for unsupported clients', () => {
  const p = resolveConfigPath('openclaw', 'darwin', '/Users/alex');
  assert.equal(p, null);
});
