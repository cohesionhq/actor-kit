# CLAUDE.md

`cohesion-agent-kit`: what `cohesion-claude-code` and `cohesion-opencode`
share, on `cohesion-ts` (`file:../cohesion-ts`). Read `README.md` first.

- Protocol work belongs in `../cohesion-ts`; never redeclare frames here.
- Only code both clients need goes here; agent-specific code stays in them.
- No fallbacks for older clients or daemons.
- There are no tests. `bun run check`, which CI runs, must pass before a change is done. Don't
  restart the live clients or deploy.
