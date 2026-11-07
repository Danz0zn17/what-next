/**
 * What Next - role start-up blocks (v2.5.0)
 *
 * get_context and get_orientation take an optional role. With one, the agent
 * gets a short block (about 30 lines) of what matters for that job instead of
 * everything; the rest is a search away. Without one, output is unchanged.
 *
 * What goes in, in order:
 *   1. facts tagged "role:<role>" (write these to steer a role)
 *   2. facts in the role's categories, lessons first, newest first
 *   3. the entity pages that role works from (products for builders, clients for growth)
 *   4. one line counting stale and disputed facts, so nobody acts on them blind
 * Disputed facts are left out of the block; stale ones carry their marker.
 */

import { getAllFacts, listPages } from './db.js';
import { freshnessOf, freshnessMarker } from './freshness.js';

export const ROLES = ['ceo', 'engineer', 'qa', 'growth', 'ops'];
export const ROLE_BLOCK_MAX_LINES = 30;

const PROFILES = {
  ceo: {
    title: 'CEO',
    focus: 'decisions, priorities, clients and money rules',
    categories: ['decision', 'priority', 'preference', 'policy', 'client', 'pricing', 'price', 'lesson'],
    pages: 'client',
  },
  engineer: {
    title: 'Engineer',
    focus: 'deploy targets, build rules, conventions and fixed mistakes',
    categories: ['lesson', 'deploy', 'deployment', 'hosting', 'convention', 'pattern', 'stack-choice', 'tour', 'gotcha', 'build'],
    pages: 'product',
  },
  qa: {
    title: 'QA',
    focus: 'the review bar, known bugs and fixed mistakes',
    categories: ['lesson', 'qa', 'review', 'bug', 'test', 'standard', 'gotcha'],
    pages: 'product',
  },
  growth: {
    title: 'Growth',
    focus: 'pipeline, clients, leads, pricing and contacts',
    categories: ['client', 'lead', 'pipeline', 'pricing', 'price', 'contact', 'outreach', 'offer'],
    pages: 'client',
  },
  ops: {
    title: 'Ops',
    focus: 'schedules, checks, deploy targets and contacts',
    categories: ['ops', 'schedule', 'deploy', 'deployment', 'hosting', 'contact', 'status', 'lesson'],
    pages: 'product',
  },
};

export function normaliseRole(role) {
  if (role == null || role === '') return null;
  const r = String(role).trim().toLowerCase();
  return ROLES.includes(r) ? r : null;
}

function trunc(s, n) {
  const flat = String(s ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n - 3) + '...' : flat;
}

const hasRoleTag = (f, role) => String(f.tags ?? '').toLowerCase().split(',').map(t => t.trim()).includes(`role:${role}`);

/**
 * Returns the block as lines (never more than ROLE_BLOCK_MAX_LINES).
 * project narrows facts to that project plus global ones.
 */
export function buildRoleBlock(role, { project = null, now = Date.now(), facts: given = null, pages: givenPages = null, maxLines = ROLE_BLOCK_MAX_LINES } = {}) {
  const r = normaliseRole(role);
  if (!r) throw new Error(`role must be one of ${ROLES.join(', ')}`);
  const profile = PROFILES[r];
  const all = (given ?? getAllFacts()).filter(f => !project || !f.project_name || f.project_name === project);
  const disputed = all.filter(f => freshnessOf(f, now).state === 'disputed');
  const usable = all.filter(f => freshnessOf(f, now).state !== 'disputed');

  const cats = new Set(profile.categories);
  const rank = (f) => (hasRoleTag(f, r) ? 0 : f.category === 'lesson' ? 1 : 2);
  const picked = usable
    .filter(f => hasRoleTag(f, r) || cats.has(String(f.category ?? '').toLowerCase()))
    .sort((a, b) => rank(a) - rank(b) || String(b.created_at).localeCompare(String(a.created_at)) || b.id - a.id);

  const lines = [`## ${profile.title} start-up block${project ? ` - ${project}` : ''}`, `Focus: ${profile.focus}.`, ''];
  const footer = [];
  const stale = all.filter(f => freshnessOf(f, now).state === 'stale').length;
  if (stale || disputed.length) {
    footer.push('', `Warning: ${stale} stale and ${disputed.length} disputed fact(s) in scope. Stale ones are marked; disputed ones are left out until re-checked (review_fact).`);
  }
  footer.push('', 'Everything else: search_memories or semantic_search. Pages: get_page.');

  const pages = (givenPages ?? listPages({ kind: profile.pages }))
    .filter(p => !project || !p.project_name || p.project_name === project)
    .slice(0, 6);
  const pageLines = pages.length
    ? [`**${profile.pages === 'client' ? 'Client' : 'Product'} pages:**`, ...pages.map(p => {
      const bits = ['hosting', 'live', 'contact'].map(k => p.fields[k]?.value).filter(Boolean).map(v => trunc(v, 50));
      return `- ${p.slug}${bits.length ? `: ${bits.join(' | ')}` : ''}`;
    }), '']
    : [];

  const room = maxLines - lines.length - footer.length - pageLines.length - 2;
  if (picked.length) {
    lines.push('**What to know:**');
    for (const f of picked.slice(0, Math.max(0, room))) {
      const scope = f.project_name ? `[${f.project_name}] ` : '';
      lines.push(`- ${scope}${f.category}: ${trunc(f.content, 200)}${freshnessMarker(f, now)}`);
    }
    if (picked.length > room && room > 0) lines[lines.length - 1] = `- ...${picked.length - room + 1} more: search_memories "${profile.categories[0]}"`;
    lines.push('');
  } else {
    lines.push(`_No ${profile.title} facts yet. Tag a fact "role:${r}" or use categories: ${profile.categories.slice(0, 5).join(', ')}._`, '');
  }
  return [...lines, ...pageLines, ...footer].slice(0, maxLines);
}
