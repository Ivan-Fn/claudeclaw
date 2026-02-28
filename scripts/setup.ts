#!/usr/bin/env tsx

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const ENV_FILE = join(PROJECT_ROOT, '.env');
const PLIST_NAME = 'com.claudeclaw.agent';
const PLIST_DIR = join(homedir(), 'Library', 'LaunchAgents');
const PLIST_PATH = join(PLIST_DIR, `${PLIST_NAME}.plist`);

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string): Promise<string> =>
  new Promise((resolve) => rl.question(q, resolve));

async function main() {
  console.log('\n🤖 Master Agent Setup\n');

  // Step 1: .env file
  if (existsSync(ENV_FILE)) {
    console.log('✅ .env file exists');
  } else {
    console.log('Creating .env from .env.example...\n');
    const template = readFileSync(join(PROJECT_ROOT, '.env.example'), 'utf8');
    const vars: Record<string, string> = {};

    vars['TELEGRAM_BOT_TOKEN'] = await ask('Telegram Bot Token (from @BotFather): ');
    vars['ALLOWED_CHAT_IDS'] = await ask('Allowed Chat IDs (comma-separated): ');

    const apiKey = await ask('Anthropic API Key (or press Enter to use claude login): ');
    if (apiKey) vars['ANTHROPIC_API_KEY'] = apiKey;

    const groqKey = await ask('Groq API Key for voice (or Enter to skip): ');
    if (groqKey) vars['GROQ_API_KEY'] = groqKey;

    const elevenKey = await ask('ElevenLabs API Key (or Enter to skip): ');
    if (elevenKey) {
      vars['ELEVENLABS_API_KEY'] = elevenKey;
      vars['ELEVENLABS_VOICE_ID'] = await ask('ElevenLabs Voice ID: ');
    }

    let envContent = template;
    for (const [key, value] of Object.entries(vars)) {
      envContent = envContent.replace(new RegExp(`^${key}=$`, 'm'), `${key}=${value}`);
    }

    writeFileSync(ENV_FILE, envContent);
    console.log('\n✅ .env file created');
  }

  // Step 2: Claude Code check
  try {
    const version = execSync('claude --version', { encoding: 'utf8' }).trim();
    console.log(`✅ Claude Code: ${version}`);
  } catch {
    console.log('⚠️  Claude Code not found. Install from https://claude.ai/download');
  }

  // Step 3: Build
  console.log('\nBuilding project...');
  try {
    execSync('npm run build', { cwd: PROJECT_ROOT, stdio: 'inherit' });
    console.log('✅ Build successful');
  } catch {
    console.log('❌ Build failed');
    rl.close();
    process.exit(1);
  }

  // Step 4: launchd setup
  const setupLaunchd = await ask('\nSet up launchd auto-start? (y/N): ');
  if (setupLaunchd.toLowerCase() === 'y') {
    const nodePath = execSync('which node', { encoding: 'utf8' }).trim();
    const logDir = join(homedir(), 'Library', 'Logs', 'master-agent');
    mkdirSync(logDir, { recursive: true });

    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_NAME}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${join(PROJECT_ROOT, 'dist', 'index.js')}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${PROJECT_ROOT}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${dirname(nodePath)}:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>${homedir()}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${join(logDir, 'master-agent.log')}</string>
  <key>StandardErrorPath</key>
  <string>${join(logDir, 'master-agent.error.log')}</string>
</dict>
</plist>`;

    mkdirSync(PLIST_DIR, { recursive: true });
    writeFileSync(PLIST_PATH, plist);
    console.log(`✅ launchd plist written to ${PLIST_PATH}`);
    console.log(`\nTo start: launchctl load ${PLIST_PATH}`);
    console.log(`To stop:  launchctl unload ${PLIST_PATH}`);
    console.log(`Logs:     ${logDir}/`);
  }

  console.log('\n✅ Setup complete! Run with: npm start (or npm run dev)\n');
  rl.close();
}

main().catch((err) => {
  console.error('Setup failed:', err);
  rl.close();
  process.exit(1);
});
