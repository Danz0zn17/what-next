#!/usr/bin/env node
/**
 * What Next MCP server - optional Streamable HTTP entry point.
 *
 * Serves the same tools as the stdio server (src/server.js) over MCP's
 * Streamable HTTP transport, so clients that cannot spawn a local process
 * (another machine on your tailnet, or claude.ai via Tailscale Funnel) can use
 * your memory.
 *
 * Safe by default:
 *   - Binds to 127.0.0.1 only. Nothing is reachable off the machine until you
 *     put a proxy in front of it (e.g. `tailscale serve` / `tailscale funnel`).
 *   - Refuses to start without WHATNEXT_MCP_HTTP_TOKEN (32+ chars). Every MCP
 *     request must carry `Authorization: Bearer <token>`.
 *   - Host header must be localhost or one of WHATNEXT_MCP_HTTP_ALLOWED_HOSTS
 *     (DNS-rebinding guard; add your *.ts.net name here).
 *   - Stateless: a fresh server + transport per request, nothing held between
 *     requests.
 *   - Does not touch the stdio server or the REST API on 3747.
 *
 * Env:
 *   WHATNEXT_MCP_HTTP_TOKEN            required, 32+ chars (e.g. `openssl rand -hex 32`)
 *   WHATNEXT_MCP_HTTP_PORT             default 3748
 *   WHATNEXT_MCP_HTTP_ALLOWED_HOSTS    comma-separated extra Host values, e.g. "mini.tail1234.ts.net"
 *   WHATNEXT_MCP_HTTP_ALLOW_PATH_TOKEN "1" to also accept POST /mcp/<token>, for
 *                                      clients that cannot send an Authorization
 *                                      header. The token then appears in URLs, so
 *                                      prefer the header whenever the client allows it.
 */
import { createServer as createHttpServer } from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

export const MIN_TOKEN_LENGTH = 32;
export const MAX_BODY_BYTES = 1_000_000;

function safeEqual(a, b) {
  // Hash first so lengths always match and timing does not leak the length.
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

export function loadConfig(env = process.env) {
  const token = env.WHATNEXT_MCP_HTTP_TOKEN ?? '';
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(
      `WHATNEXT_MCP_HTTP_TOKEN must be set to at least ${MIN_TOKEN_LENGTH} characters ` +
      '(generate one with: openssl rand -hex 32). Refusing to start without auth.'
    );
  }
  const port = Number(env.WHATNEXT_MCP_HTTP_PORT ?? 3748);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`WHATNEXT_MCP_HTTP_PORT is not a valid port: ${env.WHATNEXT_MCP_HTTP_PORT}`);
  }
  const extraHosts = (env.WHATNEXT_MCP_HTTP_ALLOWED_HOSTS ?? '')
    .split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
  const allowedHosts = new Set([
    `localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`,
    ...extraHosts,
  ]);
  return {
    token,
    port,
    allowedHosts,
    allowPathToken: env.WHATNEXT_MCP_HTTP_ALLOW_PATH_TOKEN === '1',
  };
}

// Returns null when authorised, otherwise { status, error }.
export function checkRequest(req, pathname, config) {
  const host = String(req.headers.host ?? '').toLowerCase();
  if (!config.allowedHosts.has(host)) {
    return { status: 403, error: `Host "${host}" not allowed. Add it to WHATNEXT_MCP_HTTP_ALLOWED_HOSTS.` };
  }
  if (pathname === '/mcp') {
    const header = String(req.headers.authorization ?? '');
    const m = header.match(/^Bearer\s+(.+)$/i);
    if (m && safeEqual(m[1].trim(), config.token)) return null;
    return { status: 401, error: 'Unauthorized' };
  }
  if (config.allowPathToken && pathname.startsWith('/mcp/')) {
    const supplied = decodeURIComponent(pathname.slice('/mcp/'.length));
    if (safeEqual(supplied, config.token)) return null;
    return { status: 401, error: 'Unauthorized' };
  }
  return { status: 404, error: 'Not found' };
}

function sendJson(res, status, body, extraHeaders = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function logLine(level, message) {
  process.stderr.write(`[what-next http-mcp] ${new Date().toISOString()} [${level}] ${message}\n`);
}

// createMcpServer is injected so tests can run without loading the database.
export function buildHttpServer(config, createMcpServer) {
  return createHttpServer(async (req, res) => {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      return sendJson(res, 400, { error: 'Bad request' });
    }

    if (req.method === 'GET' && pathname === '/health') {
      return sendJson(res, 200, { ok: true });
    }

    const denied = checkRequest(req, pathname, config);
    if (denied) {
      if (denied.status === 401) logLine('WARN', `rejected unauthenticated ${req.method} ${pathname.startsWith('/mcp/') ? '/mcp/<redacted>' : pathname}`);
      return sendJson(res, denied.status, { error: denied.error },
        denied.status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {});
    }

    // Stateless mode: no server-initiated streams or sessions to resume.
    if (req.method !== 'POST') {
      return sendJson(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null },
        { Allow: 'POST' });
    }

    let body;
    try {
      const raw = await readBody(req);
      body = raw ? JSON.parse(raw) : undefined;
    } catch (err) {
      return sendJson(res, err.status ?? 400, { jsonrpc: '2.0', error: { code: -32700, message: err.status ? err.message : 'Parse error' }, id: null });
    }

    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      logLine('ERROR', `request failed: ${err.message}`);
      sendJson(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  });
}

// ─── Start (only when run directly, not when imported by tests) ───────────────
const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    logLine('FATAL', err.message);
    process.exit(1);
  }
  const { createServer } = await import('./mcp-tools.js');
  const httpServer = buildHttpServer(config, createServer);
  httpServer.listen(config.port, '127.0.0.1', () => {
    logLine('INFO', `listening on http://127.0.0.1:${config.port}/mcp (allowed hosts: ${[...config.allowedHosts].join(', ')})`);
  });
  const shutdown = () => httpServer.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
