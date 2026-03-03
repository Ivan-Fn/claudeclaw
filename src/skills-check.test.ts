import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { checkNewSkills } from './skills-check.js';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const TEMP_ROOT = join(import.meta.dirname!, '__test_skills_check__');

function writeCatalog(skills: Array<{ id: string; name: string; default: boolean }>) {
  const dir = join(TEMP_ROOT, 'skills-catalog');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'catalog.json'),
    JSON.stringify({
      version: 1,
      skills: skills.map((s) => ({ ...s, description: '', files: [`${s.id}.md`] })),
    }),
  );
}

function writeState(enabled: string[], disabled: string[]) {
  writeFileSync(join(TEMP_ROOT, 'skills.json'), JSON.stringify({ enabled, disabled }));
}

beforeEach(() => {
  mkdirSync(TEMP_ROOT, { recursive: true });
});

afterEach(() => {
  rmSync(TEMP_ROOT, { recursive: true, force: true });
});

describe('checkNewSkills', () => {
  it('returns empty when no catalog exists', () => {
    expect(checkNewSkills(TEMP_ROOT)).toEqual([]);
  });

  it('returns empty when no state file exists', () => {
    writeCatalog([{ id: 'crm', name: 'CRM', default: false }]);
    expect(checkNewSkills(TEMP_ROOT)).toEqual([]);
  });

  it('returns empty when all skills are known', () => {
    writeCatalog([
      { id: 'crm', name: 'CRM', default: false },
      { id: 'img', name: 'Image Gen', default: true },
    ]);
    writeState(['img'], ['crm']);
    expect(checkNewSkills(TEMP_ROOT)).toEqual([]);
  });

  it('returns new skills not in enabled or disabled', () => {
    writeCatalog([
      { id: 'crm', name: 'CRM', default: false },
      { id: 'img', name: 'Image Gen', default: true },
      { id: 'new-skill', name: 'New Skill', default: false },
    ]);
    writeState(['img'], ['crm']);
    const result = checkNewSkills(TEMP_ROOT);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('new-skill');
  });

  it('handles malformed JSON gracefully', () => {
    mkdirSync(join(TEMP_ROOT, 'skills-catalog'), { recursive: true });
    writeFileSync(join(TEMP_ROOT, 'skills-catalog', 'catalog.json'), 'not json');
    writeFileSync(join(TEMP_ROOT, 'skills.json'), '{}');
    expect(checkNewSkills(TEMP_ROOT)).toEqual([]);
  });
});
