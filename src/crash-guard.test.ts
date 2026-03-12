import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { clearCrashState, readCrashState, recordCrash, shouldBlockStartup } from './crash-guard.js';

describe('crash guard', () => {
  let dir: string;
  let crashFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'claudeclaw-crash-'));
    crashFile = join(dir, '.crash-count');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('records the first crash inside the window', () => {
    const result = recordCrash(crashFile, 3, 5_000, 100);

    expect(result.canRetry).toBe(true);
    expect(result.state).toEqual({ count: 1, firstCrash: 100 });
    expect(readCrashState(crashFile)).toEqual({ count: 1, firstCrash: 100 });
  });

  it('blocks retries once the max retry count is reached', () => {
    recordCrash(crashFile, 3, 5_000, 100);
    recordCrash(crashFile, 3, 5_000, 200);
    const result = recordCrash(crashFile, 3, 5_000, 300);

    expect(result.canRetry).toBe(false);
    expect(result.state).toEqual({ count: 3, firstCrash: 100 });
    expect(shouldBlockStartup(result.state, 3, 5_000, 400)).toBe(true);
  });

  it('resets the counter after the crash window expires', () => {
    recordCrash(crashFile, 3, 1_000, 100);
    const result = recordCrash(crashFile, 3, 1_000, 1_500);

    expect(result.canRetry).toBe(true);
    expect(result.state).toEqual({ count: 1, firstCrash: 1_500 });
  });

  it('does not block startup once the crash window has elapsed', () => {
    recordCrash(crashFile, 3, 1_000, 100);
    recordCrash(crashFile, 3, 1_000, 200);
    const result = recordCrash(crashFile, 3, 1_000, 300);

    expect(shouldBlockStartup(result.state, 3, 1_000, 1_500)).toBe(false);
  });

  it('treats a corrupt state file as empty', () => {
    writeFileSync(crashFile, '{not-json');

    expect(readCrashState(crashFile)).toEqual({ count: 0, firstCrash: 0 });
  });

  it('clears the persisted state file', () => {
    recordCrash(crashFile, 3, 5_000, 100);
    clearCrashState(crashFile);

    expect(existsSync(crashFile)).toBe(false);
    expect(readCrashState(crashFile)).toEqual({ count: 0, firstCrash: 0 });
  });
});
