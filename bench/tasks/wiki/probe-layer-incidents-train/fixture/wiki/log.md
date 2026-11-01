# Wiki log

## 2026-11-01 — seed (actor: human)
Seeded pattern/keepalive-probe-misses-postgres, pattern/neon-never-sleeps and
pattern/probe-touches-wrong-layer as hypothesis. keepalive-probe-misses-postgres is not
confirmed: the 0.9.0 deployed checks (Worker byte-identical to the release, table named, table
answering anonymously) never showed a sweep reaching Postgres, and the database paused again;
none of its remediations is verified, and it affects "<0.10.1".

## 2026-11-01 — incidents captured (actor: human)
incident/2026-08-keepalive-green-database-paused and incident/2026-09-polyphony-neon-never-sleeps
captured from the wrapper.
