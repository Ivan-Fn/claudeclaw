import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
  unlinkSync,
  readdirSync,
  lstatSync,
  readlinkSync,
  rmdirSync,
} from 'node:fs';
import { join, dirname, relative } from 'node:path';

// ── Types ────────────────────────────────────────────────────────────

export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  files: string[];
  default: boolean;
}

interface Catalog {
  version: number;
  skills: CatalogEntry[];
}

export interface SkillsState {
  enabled: string[];
  disabled: string[];
}

// ── Paths ────────────────────────────────────────────────────────────

export function getPaths(projectRoot: string) {
  return {
    catalogDir: join(projectRoot, 'skills-catalog'),
    catalogJson: join(projectRoot, 'skills-catalog', 'catalog.json'),
    skillsDir: join(projectRoot, '.claude', 'skills'),
    stateFile: join(projectRoot, 'skills.json'),
  };
}

// ── Read catalog ─────────────────────────────────────────────────────

export function readCatalog(projectRoot: string): Catalog {
  const { catalogJson } = getPaths(projectRoot);
  if (!existsSync(catalogJson)) {
    throw new Error(`Catalog not found: ${catalogJson}`);
  }
  return JSON.parse(readFileSync(catalogJson, 'utf8')) as Catalog;
}

// ── Read/write state ─────────────────────────────────────────────────

export function readState(projectRoot: string): SkillsState | null {
  const { stateFile } = getPaths(projectRoot);
  if (!existsSync(stateFile)) return null;
  return JSON.parse(readFileSync(stateFile, 'utf8')) as SkillsState;
}

export function writeState(projectRoot: string, state: SkillsState): void {
  const { stateFile } = getPaths(projectRoot);
  writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n');
}

// ── Symlink management ───────────────────────────────────────────────

function createSkillSymlink(projectRoot: string, catalogFile: string): void {
  const { catalogDir, skillsDir } = getPaths(projectRoot);
  const linkPath = join(skillsDir, catalogFile);
  const targetPath = join(catalogDir, catalogFile);

  // Ensure parent directory exists
  mkdirSync(dirname(linkPath), { recursive: true });

  // Remove existing file/symlink if present
  if (existsSync(linkPath) || lstatExists(linkPath)) {
    unlinkSync(linkPath);
  }

  // Create relative symlink
  const relTarget = relative(dirname(linkPath), targetPath);
  symlinkSync(relTarget, linkPath);
}

function removeSkillSymlink(projectRoot: string, catalogFile: string): void {
  const { skillsDir } = getPaths(projectRoot);
  const linkPath = join(skillsDir, catalogFile);

  if (lstatExists(linkPath)) {
    unlinkSync(linkPath);
  }

  // Clean up empty parent directories
  const parentDir = dirname(linkPath);
  if (parentDir !== skillsDir && existsSync(parentDir)) {
    try {
      const entries = readdirSync(parentDir);
      if (entries.length === 0) {
        rmdirSync(parentDir);
      }
    } catch {
      // Best effort
    }
  }
}

/** lstat that doesn't throw on ENOENT (handles broken symlinks) */
function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

// ── Core operations ──────────────────────────────────────────────────

export interface SyncResult {
  created: string[];
  removed: string[];
  newSkills: CatalogEntry[];
}

export function syncSkills(projectRoot: string): SyncResult {
  const catalog = readCatalog(projectRoot);
  const { skillsDir } = getPaths(projectRoot);
  let state = readState(projectRoot);

  // First run: create state from defaults
  if (!state) {
    state = {
      enabled: catalog.skills.filter((s) => s.default).map((s) => s.id),
      disabled: catalog.skills.filter((s) => !s.default).map((s) => s.id),
    };
    writeState(projectRoot, state);
  }

  // Detect new skills (not in enabled or disabled)
  const known = new Set([...state.enabled, ...state.disabled]);
  const newSkills = catalog.skills.filter((s) => !known.has(s.id));

  // Ensure .claude/skills/ exists
  mkdirSync(skillsDir, { recursive: true });

  const catalogById = new Map(catalog.skills.map((s) => [s.id, s]));
  const created: string[] = [];
  const removed: string[] = [];

  // Remove symlinks for disabled skills or skills no longer in catalog
  for (const entry of readdirSkillFiles(skillsDir, '')) {
    const matchingSkill = catalog.skills.find((s) => s.files.includes(entry));
    if (!matchingSkill || !state.enabled.includes(matchingSkill.id)) {
      removeSkillSymlink(projectRoot, entry);
      removed.push(entry);
    }
  }

  // Create symlinks for enabled skills
  for (const id of state.enabled) {
    const skill = catalogById.get(id);
    if (!skill) continue;

    for (const file of skill.files) {
      const linkPath = join(skillsDir, file);
      const isValidSymlink = lstatExists(linkPath) && isSymlinkValid(linkPath);

      if (!isValidSymlink) {
        createSkillSymlink(projectRoot, file);
        created.push(file);
      }
    }
  }

  return { created, removed, newSkills };
}

export function enableSkill(projectRoot: string, skillId: string): string {
  const catalog = readCatalog(projectRoot);
  const skill = catalog.skills.find((s) => s.id === skillId);
  if (!skill) return `Unknown skill: ${skillId}`;

  let state = readState(projectRoot);
  if (!state) {
    // Initialize state first
    syncSkills(projectRoot);
    state = readState(projectRoot)!;
  }

  if (state.enabled.includes(skillId)) {
    return `${skill.name} is already enabled`;
  }

  state.enabled.push(skillId);
  state.disabled = state.disabled.filter((id) => id !== skillId);
  writeState(projectRoot, state);

  for (const file of skill.files) {
    createSkillSymlink(projectRoot, file);
  }

  return `Enabled: ${skill.name}`;
}

export function disableSkill(projectRoot: string, skillId: string): string {
  const catalog = readCatalog(projectRoot);
  const skill = catalog.skills.find((s) => s.id === skillId);
  if (!skill) return `Unknown skill: ${skillId}`;

  let state = readState(projectRoot);
  if (!state) {
    syncSkills(projectRoot);
    state = readState(projectRoot)!;
  }

  if (!state.enabled.includes(skillId)) {
    return `${skill.name} is already disabled`;
  }

  state.enabled = state.enabled.filter((id) => id !== skillId);
  if (!state.disabled.includes(skillId)) {
    state.disabled.push(skillId);
  }
  writeState(projectRoot, state);

  for (const file of skill.files) {
    removeSkillSymlink(projectRoot, file);
  }

  return `Disabled: ${skill.name}`;
}

export function listSkills(projectRoot: string): string {
  const catalog = readCatalog(projectRoot);
  const state = readState(projectRoot);
  const enabled = new Set(state?.enabled ?? []);
  const known = new Set([...(state?.enabled ?? []), ...(state?.disabled ?? [])]);

  const lines: string[] = ['Skills:'];
  for (const skill of catalog.skills) {
    const status = enabled.has(skill.id) ? '[x]' : '[ ]';
    lines.push(`  ${status} ${skill.id.padEnd(20)} ${skill.name}`);
  }

  const newSkills = catalog.skills.filter((s) => !known.has(s.id));
  if (newSkills.length > 0) {
    lines.push('');
    lines.push('New skills available:');
    for (const skill of newSkills) {
      lines.push(`  ${skill.id.padEnd(20)} ${skill.name} - ${skill.description}`);
    }
    lines.push('  Run: npm run skills enable <id>');
  }

  return lines.join('\n');
}

// ── Helpers ──────────────────────────────────────────────────────────

function isSymlinkValid(linkPath: string): boolean {
  try {
    const stat = lstatSync(linkPath);
    if (!stat.isSymbolicLink()) return false;
    // Check target exists
    readlinkSync(linkPath);
    return existsSync(linkPath); // resolves symlink
  } catch {
    return false;
  }
}

/** Recursively list all files in skillsDir relative to it */
function readdirSkillFiles(baseDir: string, prefix: string): string[] {
  const results: string[] = [];
  const dir = prefix ? join(baseDir, prefix) : baseDir;

  if (!existsSync(dir)) return results;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relPath = prefix ? join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) {
      results.push(...readdirSkillFiles(baseDir, relPath));
    } else {
      results.push(relPath);
    }
  }
  return results;
}
