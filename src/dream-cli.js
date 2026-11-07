#!/usr/bin/env node
/**
 * What Next - run the dreaming pass from the command line.
 *
 *   npm run dream                 apply: disputed, duplicates, lessons, contradictions, re-check list, pages
 *   npm run dream:dry             report only, change nothing
 *   npm run dream -- --undo 42    revert every change run 42 made
 *   npm run dream -- --json       print the full report as JSON
 *
 * Uses the same local database as the MCP server (WHATNEXT_DATA_DIR).
 * Exit code 0 on success, 1 on error.
 */
const args = process.argv.slice(2);
const has = (f) => args.includes(f);

try {
  const undoAt = args.indexOf('--undo');
  if (undoAt !== -1) {
    const id = Number(args[undoAt + 1]);
    if (!Number.isInteger(id) || id < 1) throw new Error('--undo needs a run id, e.g. --undo 42');
    const { undoRun, getCurationRun } = await import('./db.js');
    if (!getCurationRun(id)) throw new Error(`no run ${id}`);
    const r = undoRun(id);
    console.log(has('--json') ? JSON.stringify(r, null, 2) : `Run ${id}: ${r.reverted} change(s) reverted, ${r.skipped} skipped (the fact changed again since).`);
  } else {
    const { runDream, formatDreamReport } = await import('./dreaming.js');
    const report = await runDream({ apply: !has('--dry-run') });
    console.log(has('--json') ? JSON.stringify(report, null, 2) : formatDreamReport(report).join('\n'));
  }
  process.exit(0);
} catch (err) {
  console.error(`[dream] ${err.message}`);
  process.exit(1);
}
