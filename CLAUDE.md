# CLAUDE.md

`cohesion-agent-kit`: what `cohesion-claude-code` and `cohesion-opencode`
share, on `cohesion-ts` (`github:cohesionhq/ts`, pinned in `bun.lock`). Read
`README.md` first.

- Protocol work belongs in cohesionhq/ts; never redeclare frames here. Take a
  new ts with `bun update cohesion-ts`.
- Only code both clients need goes here; agent-specific code stays in them.
- No fallbacks for older clients or daemons.
- There are no tests. `bun run check`, which CI runs, must pass before a change is done. Don't
  restart the live clients or deploy.
