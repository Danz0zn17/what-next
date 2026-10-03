import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_HOME = mkdtempSync(join(tmpdir(), 'wn-copilot-test-'));
process.env.WHATNEXT_DATA_DIR = join(TEST_HOME, 'data');
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const { writeCopilotInstructions, writeGlobalContext } = await import('../src/sidecar.js');

const DIR = join(TEST_HOME, '.copilot');
const FILE = join(DIR, 'copilot-instructions.md');
const read = () => readFileSync(FILE, 'utf8');
const backups = () => readdirSync(DIR).filter(f => f.startsWith('copilot-instructions.md.bak-'));

const LEGACY = `# Danny's Copilot Instructions

You are working with Danny Mchunu (Greenberries studio, Durban).

## Session start - mandatory
1. Identify the project from the workspace folder name
2. Read \`~/.whatnext/agents/{project-name}.md\` - full context

## Danny's defaults
- Footer on every site: Terms & Conditions link + "Built by Greenberries" linking to greenberries.co.za

## What Next MCP tools (if available)
Each tool describes itself. Start with \`get_orientation\`, end with \`dump_session\`.
`;

beforeEach(() => { rmSync(DIR, { recursive: true, force: true }); });
after(() => { try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {} });

test('no ~/.copilot: nothing written, dir not created', () => {
  assert.equal(writeCopilotInstructions(), 'skipped');
  writeGlobalContext();
  assert.ok(!existsSync(DIR));
});

test('fresh: managed block only, product-neutral, does not ask Copilot to edit cards', () => {
  mkdirSync(DIR);
  assert.equal(writeCopilotInstructions(), 'written');
  const c = read();
  assert.ok(c.includes('<!-- What Next: managed block start'));
  assert.ok(c.includes('<!-- What Next: managed block end -->'));
  assert.ok(c.includes('Each tool describes itself'));
  assert.ok(c.includes('~/.whatnext/agents/{project-name}.md'));
  assert.ok(!/Danny|Greenberries|Mchunu/i.test(c));
  assert.ok(!/^\s*(?:\d+\.\s*)?Update `~\/\.whatnext\/agents/m.test(c), 'must not tell Copilot to edit the generated cards');
});

test('user text outside the markers is preserved, block replaced in place', () => {
  mkdirSync(DIR);
  writeFileSync(FILE, '# My rules\nAlways write tests.\n');
  writeCopilotInstructions();
  let c = read();
  assert.ok(c.startsWith('# My rules\nAlways write tests.\n\n<!-- What Next: managed block start'));
  writeFileSync(FILE, c.replace('Each tool describes itself', 'stale text') + '\n## After\nmine too\n');
  assert.equal(writeCopilotInstructions(), 'written');
  c = read();
  assert.ok(c.startsWith('# My rules\nAlways write tests.'));
  assert.ok(c.endsWith('## After\nmine too\n'));
  assert.ok(c.includes('Each tool describes itself') && !c.includes('stale text'));
  assert.equal((c.match(/managed block start/g) || []).length, 1);
});

test('legacy generated file is backed up once and replaced with the block', () => {
  mkdirSync(DIR);
  writeFileSync(FILE, LEGACY);
  assert.equal(writeCopilotInstructions(), 'migrated');
  assert.equal(backups().length, 1);
  assert.equal(readFileSync(join(DIR, backups()[0]), 'utf8'), LEGACY);
  const c = read();
  assert.ok(c.startsWith('<!-- What Next: managed block start'));
  assert.ok(!/Danny|Greenberries/.test(c));
  assert.equal(writeCopilotInstructions(), 'unchanged');
  assert.equal(backups().length, 1, 'no second backup');
});

test('a user file that merely mentions Danny is not treated as legacy', () => {
  mkdirSync(DIR);
  writeFileSync(FILE, "# Danny's Copilot Instructions\nMy own text.\n");
  assert.equal(writeCopilotInstructions(), 'written');
  assert.equal(backups().length, 0);
  assert.ok(read().startsWith("# Danny's Copilot Instructions\nMy own text."));
});

test('unchanged content is not rewritten', () => {
  mkdirSync(DIR);
  writeCopilotInstructions();
  const t = new Date(Date.now() - 60_000);
  utimesSync(FILE, t, t);
  assert.equal(writeCopilotInstructions(), 'unchanged');
  assert.ok(Math.abs(statSync(FILE).mtimeMs - t.getTime()) < 1, 'unchanged content not rewritten');
});
