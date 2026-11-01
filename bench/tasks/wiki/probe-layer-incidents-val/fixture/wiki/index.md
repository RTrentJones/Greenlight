# Wiki index

## Patterns
- [keepalive-probe-misses-postgres](patterns/keepalive-probe-misses-postgres.md) — confirmed — a Supabase keepalive that never reaches Postgres.
- [neon-never-sleeps](patterns/neon-never-sleeps.md) — hypothesis — idle-time polling keeps a scale-to-zero compute awake.
- [probe-touches-wrong-layer](patterns/probe-touches-wrong-layer.md) — hypothesis — a liveness probe that touches a layer it is not managing.

## Incidents
- [2026-07-tripnote-keepalive-green-store-paused](incidents/2026-07-tripnote-keepalive-green-store-paused.md) — the keepalive stayed green while the store paused.
- [2026-08-ledgerline-store-never-suspends](incidents/2026-08-ledgerline-store-never-suspends.md) — an idle service kept its Neon compute awake.
