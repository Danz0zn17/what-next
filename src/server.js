// What Next MCP server - stdio entry point.
//
// Claude Desktop, Claude Code and the installer spawn this file (via
// bin/bootstrap-entry.js). The tools themselves live in ./mcp-tools.js so the
// optional HTTP entry (./http-mcp.js) serves the identical tool set.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer, loadEmbeddings, log } from './mcp-tools.js';

// ─── Start ────────────────────────────────────────────────────────────────────
const server = createServer();
const transport = new StdioServerTransport();
await server.connect(transport);

// Optionally load the embedding model shortly after startup, off the request path,
// so the first semantic_search does not spend its timeout on a cold model load.
// Opt-in: every client spawns its own MCP process and the model costs ~100MB each.
if (process.env.WHATNEXT_WARM_EMBEDDER === '1') {
  setTimeout(() => {
    loadEmbeddings().then(m => m.warmEmbedder?.()).catch(err => log('WARN', 'warm_embedder', err.message));
  }, 5_000).unref();
}
