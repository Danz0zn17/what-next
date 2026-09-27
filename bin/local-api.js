#!/usr/bin/env node
/**
 * What Next - local REST API + web UI (Windows, Linux, manual starts).
 *
 * Thin shim kept at this path because the installer, README and `wn` point
 * here. It runs the same server as the macOS LaunchAgent: bound to 127.0.0.1,
 * Host/Origin checked, sanitised writes, data in ~/.whatnext/data
 * (override with WHATNEXT_DATA_DIR, port with WHATNEXT_PORT).
 */
await import('../src/api-server.js');
