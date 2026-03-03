import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from './env.js';

interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  files: string[];
  default: boolean;
}

interface SkillsState {
  enabled: string[];
  disabled: string[];
}

export function checkNewSkills(projectRoot: string = PROJECT_ROOT): CatalogEntry[] {
  const catalogPath = join(projectRoot, 'skills-catalog', 'catalog.json');
  const statePath = join(projectRoot, 'skills.json');

  if (!existsSync(catalogPath) || !existsSync(statePath)) return [];

  try {
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as { skills: CatalogEntry[] };
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as SkillsState;
    const known = new Set([...state.enabled, ...state.disabled]);
    return catalog.skills.filter((s) => !known.has(s.id));
  } catch {
    return [];
  }
}
