# _recipes

A version-controlled library of Claude skills, shared across projects and dev boxes.

Skills are plain markdown files. Claude reads them on demand — they are not code libraries and are not imported per-project. One clone per dev box.

## Setup

```sh
git clone git@github.com:<org>/_recipes ~/_recipes
cd ~/_recipes && ./install.sh
```

`install.sh` writes a block into `~/.claude/CLAUDE.md` that tells Claude where to find skills. It uses the actual clone path, so you can clone anywhere.

## Updating

```sh
cd ~/_recipes && git pull && ./install.sh
```

Re-running `install.sh` after a pull replaces only the `_recipes` block in `~/.claude/CLAUDE.md` — other content in that file is untouched.

## Using a skill

Include `rx` anywhere in your task prompt to trigger skill lookup:

```
rx implement otp auth for the login flow
scrape example.com for product listings rx
```

Claude reads `_index.md`, finds the matching skill, and follows it. If no clear match exists, it asks before proceeding.

## Adding a skill

1. Create a directory: `_recipes/<skill-name>/`
2. Add `SKILL.md` with YAML frontmatter (`name`, `description`) and markdown body
3. Add a row to `_index.md`
4. Commit and push — teammates get it on next `git pull && ./install.sh`

## Skills

See `_index.md` for the full list.
