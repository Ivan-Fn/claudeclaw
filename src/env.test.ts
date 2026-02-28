import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readEnvFile, _resetEnvCache } from './env.js';

const TMP = join(tmpdir(), 'master-agent-test-env');

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
  _resetEnvCache();
});

afterEach(() => {
  _resetEnvCache();
});

function writeEnv(content: string): string {
  const p = join(TMP, `.env-${Date.now()}`);
  writeFileSync(p, content);
  return p;
}

describe('readEnvFile', () => {
  it('returns empty object when file does not exist', () => {
    const result = readEnvFile('/tmp/nonexistent-env-file-12345');
    expect(result).toEqual({});
  });

  it('parses simple KEY=VALUE pairs', () => {
    const p = writeEnv('FOO=bar\nBAZ=qux');
    expect(readEnvFile(p)).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('handles double-quoted values', () => {
    const p = writeEnv('KEY="value with spaces"');
    expect(readEnvFile(p)).toEqual({ KEY: 'value with spaces' });
  });

  it('handles single-quoted values', () => {
    const p = writeEnv("KEY='value with spaces'");
    expect(readEnvFile(p)).toEqual({ KEY: 'value with spaces' });
  });

  it('skips comments and blank lines', () => {
    const p = writeEnv('# comment\n\nKEY=val\n  # another comment');
    expect(readEnvFile(p)).toEqual({ KEY: 'val' });
  });

  it('strips inline comments for unquoted values', () => {
    const p = writeEnv('KEY=value # this is a comment');
    expect(readEnvFile(p)).toEqual({ KEY: 'value' });
  });

  it('preserves inline # in quoted values', () => {
    const p = writeEnv('KEY="value # not a comment"');
    expect(readEnvFile(p)).toEqual({ KEY: 'value # not a comment' });
  });

  it('handles empty values', () => {
    const p = writeEnv('KEY=');
    expect(readEnvFile(p)).toEqual({ KEY: '' });
  });

  it('handles values with = in them', () => {
    const p = writeEnv('KEY=a=b=c');
    expect(readEnvFile(p)).toEqual({ KEY: 'a=b=c' });
  });

  it('does not pollute process.env', () => {
    const marker = `__TEST_ENV_MARKER_${Date.now()}`;
    const p = writeEnv(`${marker}=secret`);
    readEnvFile(p);
    expect(process.env[marker]).toBeUndefined();
  });
});
