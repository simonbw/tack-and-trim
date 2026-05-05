# Profiles

Reference profile output captured by `npm run profile-game --json`. Useful as
a baseline when investigating perf regressions.

| File | What it captures |
|---|---|
| `baseline.json` | CPU profile on the default level — the comparison point for `apostle-islands`/`san-juan-islands` runs |
| `baseline.rendering.json` | Same level, with the rendering-heavy scopes broken out |
| `after.json` / `after.rendering.json` | Most recent post-change capture; overwrite when comparing |

To regenerate, see `.claude/skills/profile-game/SKILL.md`.
