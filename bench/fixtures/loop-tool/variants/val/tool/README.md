# wrapper

A Greenlight wrapper with two small services, `linkshelf` and `pinboard` (`greenlight.config.mjs`).

## Environments

| branch | environment | how a change gets there |
|---|---|---|
| `develop` | beta | push to `develop`; `.github/workflows/deploy.yml` ships it |
| `main` | prod | `greenlight promote <tool>` (a gated fast-forward of `develop`) |

Deploys run in CI on push. The deploy credentials exist only there, so `greenlight ship` and
`greenlight deploy` are CI steps, not something to run from a workstation.

## Local gate

`greenlight preview <tool>` builds, serves and verifies one tool locally.
