# Greenlight agent runbook — deploy → verify → promote

The loop an agent (or a human) runs to ship a change safely. CI calls the **same**
`verify` harness, so local, agent, and CI always agree (greenlight-v1.md §11).

## Deterministic URL scheme — never scrape deploy logs

| Subject | prod | beta |
|---|---|---|
| tool | `https://<name>.<domain>` | `https://beta.<name>.<domain>` |
| blog (apex) | `https://<domain>` | `https://beta.<domain>` |
| mcp connect | *(tool url)* `+ /mcp` | same `+ /mcp` |

`preview` is per-target and comes from the adapter's `deploy()` result — it is **not**
derivable from a name. Everything else is computed by `resolveUrl` in `@rtrentjones/greenlight-shared`.

## The loop

1. `git checkout -b <type>/<slug>`
2. push → preview deploy
3. verify preview — in CI/local: `runLoop` (build → deploy → verify); standalone: `pnpm greenlight verify <name> --env preview`
4. merge to `develop` → beta deploy
5. `pnpm greenlight verify <name> --env beta`
6. `pnpm greenlight promote <name>` — gated `develop → main` fast-forward
7. `pnpm greenlight verify <name> --env prod`

## Verify modes (selected by lane)

- `astro` / `next` → `api` (+ light `playwright`)
- `mcp` → `mcp`: initialize handshake → `tools/list` → call a tool → if auth != none, assert unauthorized is rejected

## Promote guard

Fast-forward `develop → main` **only if `main` is an ancestor of `develop`**. If `main`
diverged (e.g. a direct hotfix), reconcile first (rebase/merge) — never force-push
(`canPromote` in `@rtrentjones/greenlight-loop` enforces this).
