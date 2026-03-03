---
name: skills-manager
description: Use when the user asks to manage skills, list available skills, enable or disable skills, check for new skills, or on first startup when no skills.json exists.
---

# Skills Manager

You manage the bot's skill catalog. Skills are optional capabilities that can be enabled or disabled per bot instance.

## How it works

- All available skills live in `skills-catalog/` with a manifest at `skills-catalog/catalog.json`
- Active skills are symlinked into `.claude/skills/` (where the SDK auto-discovers them)
- Per-instance state is tracked in `skills.json` (enabled/disabled lists)
- The CLI tool `npm run skills` handles symlink creation and state management

## Commands

When the user asks about skills, run the appropriate command:

### List skills
```bash
npm run skills list
```
Shows all available skills with their enabled/disabled status and flags any new skills from upstream.

### Enable a skill
```bash
npm run skills enable <skill-id>
```
Creates the symlink and updates skills.json. The skill becomes active on the next agent session.

### Disable a skill
```bash
npm run skills disable <skill-id>
```
Removes the symlink and updates skills.json.

### Sync after update
```bash
npm run skills sync
```
Reconciles symlinks with skills.json. Run this after `git pull` to detect new skills and fix broken symlinks.

## First startup behavior

If `skills.json` does not exist (fresh install or first run after migration), do this:

1. Run `npm run skills list` to show available skills
2. Tell the user which skills are available and what each does
3. Ask which skills they want to enable (mention which are default-on)
4. Run `npm run skills enable <id>` for each chosen skill, or `npm run skills sync` to accept defaults

## Skill IDs

Read `skills-catalog/catalog.json` to get the current list of skill IDs, names, and descriptions. Do not hardcode skill names -- always read from the catalog.

## After enabling/disabling

Tell the user the change takes effect on the next message (new agent session). No restart needed.
