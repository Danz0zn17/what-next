/**
 * What Next — Standalone REST API + Web UI
 * This runs as a persistent background service (macOS LaunchAgent).
 * Always available at http://localhost:3747 — survives reboots.
 */
import { startApiServer } from './api.js';

startApiServer();
