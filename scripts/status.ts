#!/usr/bin/env tsx

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const PID_FILE = join(PROJECT_ROOT, 'store', 'master-agent.pid');
const DB_PATH = join(PROJECT_ROOT, 'store', 'master-agent.db');
const ENV_FILE = join(PROJECT_ROOT, '.env');

function check(label: string, ok: boolean, detail?: string): void {
  const icon = ok ? '✅' : '❌';
  console.log(`${icon} ${label}${detail ? ': ' + detail : ''}`);
}

console.log('\n🤖 Master Agent Status\n');

// PID check
if (existsSync(PID_FILE)) {
  const pid = readFileSync(PID_FILE, 'utf8').trim();
  try {
    process.kill(Number(pid), 0);
    check('Process', true, `running (PID ${pid})`);
  } catch {
    check('Process', false, `stale PID file (${pid})`);
  }
} else {
  check('Process', false, 'not running');
}

// .env check
check('.env file', existsSync(ENV_FILE));

// Database check
check('Database', existsSync(DB_PATH), DB_PATH);

// Claude Code check
try {
  const version = execSync('claude --version', { encoding: 'utf8' }).trim();
  check('Claude Code', true, version);
} catch {
  check('Claude Code', false, 'not found');
}

// Node check
try {
  const version = execSync('node --version', { encoding: 'utf8' }).trim();
  check('Node.js', true, version);
} catch {
  check('Node.js', false, 'not found');
}

// Build check
check('Build', existsSync(join(PROJECT_ROOT, 'dist', 'index.js')), 'dist/index.js');

console.log('');
