---
id: pattern/neon-never-sleeps
type: pattern
title: Idle-time polling keeps a scale-to-zero Neon compute awake
updated: 2026-11-19
status: hypothesis
kind: failure
class: free-tier-physics
atRisk: Neon free-tier compute allowance (the compute must suspend when idle)
probed: n/a — no check measured idle database traffic
cells: ["*/*/neon", "mcp/oci/*"]
affects: "*"
relevance: app-code
evidence:
  - post:https://rtrentjones.dev/blog/keepalive-green-database-paused/
  - raw:20261118T082244Z-1afa7547
  - raw:20261118T082244Z-33d05e6f
  - raw:20261119T072754Z-5a64f852
  - raw:20261119T072754Z-eb5865ee
  - commit:RTrentJones/RTrentJones.dev@16cee9a60db9a93d55567bd41d21378a193c0e42
catches:
  description: over a simulated idle window, the app issues zero queries to the store
  graderTask: replay/idle-probe-leaves-store-asleep
remediation:
  - { outlet: skill, ref: "skill:greenlight-build", verified: false }
  - { outlet: doctor, ref: "DR-21", verified: false }
skills: [provider-neon, greenlight-build]
---
## Symptom
An idle containerized app with a Neon database queried Postgres about 50,000 times a day. Neon
never suspended, and roughly 720 awake hours a month consumed most of the free compute allowance
before any real use.

## Root cause
Three timers ran without doing useful work: a job-queue poll every 2 seconds, a stale-job reaper
every 60 seconds, and a container healthcheck every 30 seconds against `/health`, which queries the
database. Suspension needs five quiet minutes, which never happened.

## Fix / workaround
Wake workers on enqueue instead of polling, and schedule one wake-up for work that is due later.
Run reapers only while jobs run. Point container healthchecks and keepalives at a store-free
`/health/live` (app contract C2, C6).

## How it is caught
A replay counts store queries over an idle window and requires zero. A planned doctor rule flags
`needs-silence` tools whose probe touches the store. This stays a hypothesis until a deployed app
is shown suspending after the change.

The bench replay named in `catches` shows the healthcheck timer is enough on its own: with a `/health` healthcheck every 30 s the simulated idle window recorded 21 store queries and the store awake 600 s of 600 s (raw:20261118T082244Z-33d05e6f). With the healthcheck and keepalive on a store-free route it recorded 0 queries and the store suspended (raw:20261118T082244Z-1afa7547). That is a bench replay, not a deployed app, so the status stays hypothesis.

Second replay, same cell: the run that wrote a 30 s HEALTHCHECK against `/health` recorded 21 store queries over the idle window (20 from the healthcheck, 1 from the keepalive) and the store awake 600 s of 600 s (raw:20261119T072754Z-5a64f852). The run that used a store-free route recorded 0 queries and the store awake 240 s of 600 s, the suspension the free tier needs (raw:20261119T072754Z-eb5865ee). The idle-window query count, not the presence of a healthcheck, separates them.