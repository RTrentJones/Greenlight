---
id: pattern/neon-never-sleeps
type: pattern
title: Idle-time polling keeps a scale-to-zero Neon compute awake
updated: 2026-11-01
status: hypothesis     # needs red→green evidence on a deployed artifact (LR-05); input to the cycle
kind: failure
class: free-tier-physics
atRisk: Neon free-tier compute allowance (the compute must suspend when idle)
probed: n/a — no check measured idle database traffic
cells: ["*/*/neon", "mcp/oci/*"]
affects: "*"          # framework versions that carry the defect
relevance: app-code
evidence:
  - post:https://rtrentjones.dev/blog/keepalive-green-database-paused/
catches:
  description: over a simulated idle window, the app issues zero queries to the store
  graderTask: replay/idle-app-zero-store-queries
remediation:
  - { outlet: skill, ref: "skill:greenlight-build", verified: false }
  - { outlet: doctor, ref: "DR-21", verified: false }
skills: [provider-neon, greenlight-build]
---
## Symptom
An idle containerized app with a Neon database queried Postgres about 50,000 times a day. Neon never suspended, and roughly 720
awake hours a month consumed most of the free compute allowance before any real use.

## Root cause
Three timers ran without doing useful work: a job-queue poll every 2 seconds, a stale-job reaper
every 60 seconds, and a container healthcheck every 30 seconds against `/health`, which queries the
database. Suspension needs five quiet minutes, which never happened.

## Fix / workaround
Wake workers on enqueue instead of polling, and schedule one wake-up for work that is due later.
Run reapers only while jobs run. Point container healthchecks and keepalives at a store-free
`/health/live` (app contract C2, C6).

## How it is caught
A replay counts store queries over an idle window and requires zero. DR-21 flags `needs-silence`
tools whose probe touches the store.
