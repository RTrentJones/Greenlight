# Wiki index

## Patterns
- [keepalive-probe-misses-postgres](patterns/keepalive-probe-misses-postgres.md) — hypothesis — a Supabase keepalive that never reaches Postgres.
- [neon-never-sleeps](patterns/neon-never-sleeps.md) — hypothesis — idle-time polling keeps a scale-to-zero compute awake.
- [probe-touches-wrong-layer](patterns/probe-touches-wrong-layer.md) — hypothesis — a liveness probe that touches a layer it is not managing.

## Incidents
- [2026-08-keepalive-green-database-paused](incidents/2026-08-keepalive-green-database-paused.md) — the keepalive was green, and the database paused anyway.
- [2026-09-polyphony-neon-never-sleeps](incidents/2026-09-polyphony-neon-never-sleeps.md) — an idle app kept its Neon compute awake.
