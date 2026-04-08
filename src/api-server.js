/**
 * What Next — Standalone REST API + Web UI
 * This runs as a persistent background service (macOS LaunchAgent).
 * Always available at http://localhost:3747 — survives reboots.
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
try { require('dotenv').config(); } catch {} // Load .env if present (optional dep)

import { startApiServer } from './api.js';
import { startPeriodicSync } from './sync.js';

startApiServer();
startPeriodicSync();
