#!/usr/bin/env tsx

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSkills, enableSkill, disableSkill, syncSkills } from './skills-lib.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

const [, , command, ...args] = process.argv;

switch (command ?? 'list') {
  case 'list': {
    console.log(listSkills(PROJECT_ROOT));
    break;
  }

  case 'enable': {
    const id = args[0];
    if (!id) {
      console.error('Usage: npm run skills enable <skill-id>');
      process.exit(1);
    }
    console.log(enableSkill(PROJECT_ROOT, id));
    break;
  }

  case 'disable': {
    const id = args[0];
    if (!id) {
      console.error('Usage: npm run skills disable <skill-id>');
      process.exit(1);
    }
    console.log(disableSkill(PROJECT_ROOT, id));
    break;
  }

  case 'sync': {
    const result = syncSkills(PROJECT_ROOT);
    if (result.created.length > 0) {
      console.log(`Created symlinks: ${result.created.join(', ')}`);
    }
    if (result.removed.length > 0) {
      console.log(`Removed symlinks: ${result.removed.join(', ')}`);
    }
    if (result.newSkills.length > 0) {
      console.log('\nNew skills available:');
      for (const s of result.newSkills) {
        console.log(`  ${s.id.padEnd(20)} ${s.name} - ${s.description}`);
      }
      console.log('  Run: npm run skills enable <id>');
    }
    if (result.created.length === 0 && result.removed.length === 0 && result.newSkills.length === 0) {
      console.log('Skills are up to date.');
    }
    break;
  }

  default:
    console.error(`Unknown command: ${command}`);
    console.error('Usage: npm run skills [list|enable|disable|sync] [id]');
    process.exit(1);
}
