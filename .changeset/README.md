# Changesets

The five `@rtrentjones/greenlight*` packages are released in lockstep (`fixed` group).
Add a changeset for a change: `pnpm changeset`. Versioning/publish runs in
`.github/workflows/release.yml` (gated on `NPM_TOKEN`). Private packages (blog,
ping-mcp) are not published.
