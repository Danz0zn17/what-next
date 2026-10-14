#!/usr/bin/env node
// Writes landing/monitoring-config.js from env vars so monitoring keys stay
// out of the repo. Runs as the Netlify build command (see netlify.toml).
//   SENTRY_DSN, POSTHOG_KEY, POSTHOG_HOST (optional)
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const out = fileURLToPath(new URL('../landing/monitoring-config.js', import.meta.url));
const config = {
  sentryDsn: process.env.SENTRY_DSN || null,
  posthogKey: process.env.POSTHOG_KEY || null,
  posthogHost: process.env.POSTHOG_HOST || null,
};

writeFileSync(out, `window.__MONITORING__ = ${JSON.stringify(config)};\n`);
console.log(`monitoring-config.js written (sentry: ${config.sentryDsn ? 'on' : 'off'}, posthog: ${config.posthogKey ? 'on' : 'off'})`);
