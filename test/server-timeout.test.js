/**
 * Tests for the withTimeout wrapper used by all MCP tool handlers.
 *
 * We extract the logic as a standalone helper here to avoid importing the
 * full server (which boots an MCP stdio transport and requires env vars).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// ─── Inline the same withTimeout logic ───────────────────────────────────────
// Keep in sync with what-next/src/server.js

const TOOL_TIMEOUT_MS = 15_000;

function withTimeout(toolName, handlerFn) {
  return async (args) => {
    const timer = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Tool timed out after ${TOOL_TIMEOUT_MS}ms`)), TOOL_TIMEOUT_MS)
    );
    try {
      return await Promise.race([handlerFn(args), timer]);
    } catch (err) {
      return {
        content: [{
          type: 'text',
          text: `[what-next] ⚠️ ${toolName} failed: ${err.message}\n\nThe MCP server is running but encountered an error. Your session data is safe in local SQLite. You can retry or use the REST API at http://localhost:3747`,
        }],
      };
    }
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test('withTimeout passes through successful results', async () => {
  const handler = withTimeout('test_tool', async () => ({
    content: [{ type: 'text', text: 'ok' }],
  }));
  const result = await handler({});
  assert.equal(result.content[0].text, 'ok');
});

test('withTimeout catches thrown errors and returns friendly message', async () => {
  const handler = withTimeout('test_tool', async () => {
    throw new Error('cloud unreachable');
  });
  const result = await handler({});
  assert.ok(result.content[0].text.includes('test_tool failed'));
  assert.ok(result.content[0].text.includes('cloud unreachable'));
  assert.ok(result.content[0].text.includes('localhost:3747'));
});

test('withTimeout returns error message on timeout (fast fake timeout)', async () => {
  // Use a 1ms timeout clone to test timeout path without waiting 15s
  function withShortTimeout(toolName, handlerFn) {
    return async (args) => {
      const timer = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Tool timed out after 1ms')), 1)
      );
      try {
        return await Promise.race([handlerFn(args), timer]);
      } catch (err) {
        return {
          content: [{ type: 'text', text: `[what-next] ⚠️ ${toolName} failed: ${err.message}` }],
        };
      }
    };
  }

  const handler = withShortTimeout('slow_tool', () => new Promise(() => {})); // never resolves
  const result = await handler({});
  assert.ok(result.content[0].text.includes('slow_tool failed'));
  assert.ok(result.content[0].text.includes('timed out'));
});

test('withTimeout passes args through to handler', async () => {
  const handler = withTimeout('echo_tool', async (args) => ({
    content: [{ type: 'text', text: JSON.stringify(args) }],
  }));
  const result = await handler({ project: 'test-project', summary: 'hello' });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.project, 'test-project');
  assert.equal(parsed.summary, 'hello');
});
