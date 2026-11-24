---
id: incident/2026-09-polyphony-neon-never-sleeps
type: incident
title: An idle Polyphony kept its Neon compute awake
updated: 2026-11-01
status: confirmed
tool: polyphony
opened: 2026-09-01
closed: 2026-09-30
evidence:
  - post:https://rtrentjones.dev/blog/keepalive-green-database-paused/
  - commit:RTrentJones/RTrentJones.dev@16cee9a60db9a93d55567bd41d21378a193c0e42
patterns:
  - pattern/neon-never-sleeps
  - pattern/probe-touches-wrong-layer
timeline:
  - { date: 2026-09-01, text: "found ~50,000 queries/day from an idle app (job poll 2s ≈ 43,200; reaper 60s ≈ 1,440; healthcheck 30s ≈ 5,760)" }
  - { date: 2026-09-15, text: "worker switched to wake-on-enqueue with one scheduled wake-up; reaper runs only while jobs run" }
  - { date: 2026-09-20, text: "liveness split: /health/live (no DB) for healthcheck and keepalive; /health for verify only", evidence: "commit:RTrentJones/RTrentJones.dev@16cee9a60db9a93d55567bd41d21378a193c0e42" }
---
Suspension needs five quiet minutes, and the app never gave it one. That came to roughly 720 awake
hours a month, using most of the free compute allowance before any scene had been generated. The
keepalive probe was not the cause, since its cron runs every three days, but it probed the wrong
layer.
