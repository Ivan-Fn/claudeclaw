import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface CrashState {
  count: number;
  firstCrash: number;
}

export function readCrashState(crashFile: string): CrashState {
  try {
    if (existsSync(crashFile)) {
      return JSON.parse(readFileSync(crashFile, 'utf8')) as CrashState;
    }
  } catch {
    // Treat a missing/corrupt state file as "no crashes recorded".
  }

  return { count: 0, firstCrash: 0 };
}

export function clearCrashState(crashFile: string): void {
  try {
    if (existsSync(crashFile)) unlinkSync(crashFile);
  } catch {
    // Best effort.
  }
}

export function shouldBlockStartup(
  state: CrashState,
  maxCrashRetries: number,
  crashWindowMs: number,
  now = Date.now(),
): boolean {
  return state.count >= maxCrashRetries && now - state.firstCrash < crashWindowMs;
}

export function recordCrash(
  crashFile: string,
  maxCrashRetries: number,
  crashWindowMs: number,
  now = Date.now(),
): { canRetry: boolean; state: CrashState } {
  const state = readCrashState(crashFile);
  const nextState =
    state.count === 0 || state.firstCrash === 0 || now - state.firstCrash > crashWindowMs
      ? { count: 1, firstCrash: now }
      : { count: state.count + 1, firstCrash: state.firstCrash };

  try {
    mkdirSync(dirname(crashFile), { recursive: true });
    writeFileSync(crashFile, JSON.stringify(nextState));
  } catch {
    // Best effort. Still return the in-memory state so callers can decide how to exit.
  }

  return {
    canRetry: nextState.count < maxCrashRetries,
    state: nextState,
  };
}
