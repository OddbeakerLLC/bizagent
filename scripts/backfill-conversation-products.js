#!/usr/bin/env node
'use strict';

/**
 * Backfill chat-product bindings (2026-11-08, chat-product binding phase 5).
 *
 *   scripts/backfill-conversation-products.js [--hub PATH] [--dry-run]
 *
 * For every conversation with no product bound:
 *   1. name → registry slug (normalized),
 *   2. message agent attribution (agent-completion status lines, form-request
 *      `agent` fields) — inference only, never a rewrite of message history.
 *
 * Results are stored as `products` + `products_inferred: true` so the console
 * shows muted chips for operator confirmation. Chats that already have products
 * are left alone; chats with no evidence stay unbound (the operator can set an
 * explicit "no product" state in the console). Cap: 3 products per chat.
 *
 * Nothing is written on the dry run.
 */

const { loadRegistry } = require('../control-plane/lib/config');
const {
  MAX_BOUND_PRODUCTS,
  getConversation,
  listConversations,
  normalizeProducts,
  updateConversationProducts,
} = require('../control-plane/lib/conversations');

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** name → slug, then message attribution. Returns { slug, evidence }. */
function inferProduct(hub, conv, slugs) {
  const name = normalizeName(conv.name);
  if (slugs.includes(name)) return { slug: name, evidence: 'name' };

  const registry = (() => {
    try {
      return loadRegistry(hub);
    } catch (_err) {
      return { products: [] };
    }
  })();
  for (const product of registry.products || []) {
    const slug = String((product && product.slug) || '').trim().toLowerCase();
    if (!slug) continue;
    const productName = normalizeName(product && product.name);
    if (productName && productName === name) return { slug, evidence: 'name' };
  }

  // Message attribution: CP-owned status lines carry agent attribution; the
  // console never stores an agent name on a user/hub message.
  for (const msg of conv.messages || []) {
    const content = String(msg.content || '');
    const completion = content.match(/Agent\s+([a-z0-9._-]+)\s+finished/i);
    if (completion) {
      const slug = completion[1].toLowerCase();
      if (slugs.includes(slug)) return { slug, evidence: 'message' };
    }
    if (msg.agent && slugs.includes(String(msg.agent).toLowerCase())) {
      return { slug: String(msg.agent).toLowerCase(), evidence: 'message' };
    }
    for (const slug of slugs) {
      if (new RegExp(`\\b${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(content)) {
        return { slug, evidence: 'message' };
      }
    }
  }
  return null;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('usage: backfill-conversation-products.js [--hub PATH] [--dry-run]');
    process.exit(0);
  }
  const dryRun = argv.includes('--dry-run');
  const hub = argValue(argv, '--hub') || process.argv[2] || process.env.BIZAGENT_HUB || process.cwd();
  const slugs = loadRegistry(hub).products
    .map((p) => String((p && p.slug) || '').trim().toLowerCase())
    .filter(Boolean);

  if (!slugs.length) {
    console.log('registry has no products — nothing to backfill');
    process.exit(0);
  }

  const rows = listConversations(hub);
  let changed = 0;
  let skipped = 0;
  for (const entry of rows) {
    if (entry.products.length) {
      skipped += 1;
      continue;
    }
    const conv = getConversation(hub, entry.id);
    if (!conv) continue;
    const hit = inferProduct(hub, conv, slugs);
    if (!hit) {
      console.log(`  ${entry.name} — no evidence (left unbound)`);
      continue;
    }
    const products = normalizeProducts([hit.slug]);
    if (dryRun) {
      console.log(`  ${entry.name} → ${products.join(', ')} (${hit.evidence}, inferred)`);
      changed += 1;
      continue;
    }
    updateConversationProducts(hub, entry.id, products, { inferred: true });
    console.log(`  ${entry.name} → ${products.join(', ')} (${hit.evidence}, inferred)`);
    changed += 1;
  }
  console.log(`backfilled ${changed} conversation(s); ${skipped} already bound; cap ${MAX_BOUND_PRODUCTS}`);
}

main();
