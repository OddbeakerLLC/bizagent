#!/usr/bin/env node
/**
 * scripts/migrate-from-legacy.js
 * 
 * Migration script for BizAgent Makeover Plan (Phase 1).
 * 
 * Safely migrates data from the old installation to the new architecture.
 * Run this after renaming the old hub directory to bizagent-legacy.
 * 
 * Usage:
 *   node scripts/migrate-from-legacy.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');

const HUB = process.cwd();
const LEGACY_DIR = path.join(HUB, '../bizagent-legacy');

const DRY_RUN = process.argv.includes('--dry-run');

console.log('=== BizAgent Migration Tool (Phase 1) ===');
console.log(`Hub: ${HUB}`);
console.log(`Legacy source: ${LEGACY_DIR}`);
if (DRY_RUN) console.log('DRY RUN — no changes will be made\n');

if (!fs.existsSync(LEGACY_DIR)) {
  console.error('Error: Could not find bizagent-legacy directory.');
  console.error('Please rename your old installation directory to "bizagent-legacy" and run this script again.');
  process.exit(1);
}

const migrations = [
  // Core configuration
  { src: 'registry.json', dst: 'registry.json', required: true },
  { src: '.bizagent/env', dst: '.bizagent/env', required: false },
  { src: 'cli.json', dst: 'cli.json', required: false },

  // Data directories
  { src: 'journal', dst: 'journal', required: false },
  { src: 'company', dst: 'company', required: false },
  { src: 'knowledge-stack', dst: 'knowledge-stack', required: false },
  { src: 'inbox', dst: 'inbox', required: false },
  { src: 'outbox', dst: 'outbox', required: false },
  { src: 'user', dst: 'user', required: false },

  // Agent data
  { src: 'agents', dst: 'agents', required: false },

  // Hidden operational data
  { src: '.bizagent/auth.json', dst: '.bizagent/auth.json', required: false },
  { src: '.bizagent/sessions.json', dst: '.bizagent/sessions.json', required: false },
  { src: '.bizagent/hub-session.md', dst: '.bizagent/hub-session.md', required: false },
  { src: '.bizagent/conversations', dst: '.bizagent/conversations', required: false },
];

function copyItem(srcPath, dstPath) {
  const fullSrc = path.join(LEGACY_DIR, srcPath);
  const fullDst = path.join(HUB, dstPath);

  if (!fs.existsSync(fullSrc)) {
    if (migrations.find(m => m.src === srcPath).required) {
      console.error(`ERROR: Required file/directory missing: ${srcPath}`);
      process.exit(1);
    }
    return false;
  }

  const dstDir = path.dirname(fullDst);
  if (!fs.existsSync(dstDir)) {
    if (!DRY_RUN) fs.mkdirSync(dstDir, { recursive: true });
    console.log(`Created directory: ${dstDir}`);
  }

  if (fs.statSync(fullSrc).isDirectory()) {
    if (!DRY_RUN) {
      // Simple recursive copy for directories
      fs.cpSync(fullSrc, fullDst, { recursive: true });
    }
    console.log(`Copied directory: ${srcPath} → ${dstPath}`);
  } else {
    if (!DRY_RUN) {
      fs.copyFileSync(fullSrc, fullDst);
    }
    console.log(`Copied file: ${srcPath} → ${dstPath}`);
  }
  return true;
}

console.log('\nStarting migration...\n');

let migrated = 0;
for (const item of migrations) {
  if (copyItem(item.src, item.dst)) migrated++;
}

console.log(`\nMigration complete! ${migrated} items processed.`);

if (DRY_RUN) {
  console.log('\nThis was a dry run. No files were changed.');
  console.log('Run without --dry-run to perform the actual migration.');
} else {
  console.log('\nNext steps:');
  console.log('1. Review the migrated files');
  console.log('2. Run: ./scripts/prune-archives.sh');
  console.log('3. Test the new system: scripts/control-plane.sh restart');
  console.log('4. Open the UI and verify everything works');
  console.log('\nThe old directory (bizagent-legacy) can be archived or deleted once you are confident.');
}

console.log('\nMigration script finished.');
