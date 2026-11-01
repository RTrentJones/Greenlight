---
id: incident/2026-08-ledgerline-store-never-suspends
type: incident
title: An idle Ledgerline kept its Neon compute awake around the clock
updated: 2026-11-01
status: confirmed
tool: ledgerline
opened: 2026-08-03
closed: 2026-08-26
evidence:
  - issue:fixture-org/ledgerline#7
  - commit:fixture-org/ledgerline@4b9e1d27c0a3f58e6d1b2c7a9f0e3d4c5b6a7980
  - pr:fixture-org/ledgerline#9
patterns:
  - pattern/neon-never-sleeps
  - pattern/probe-touches-wrong-layer
timeline:
  - { date: 2026-08-03, text: "compute-hours alert: the store had not suspended for 30 days with no bookings", evidence: "issue:fixture-org/ledgerline#7" }
  - { date: 2026-08-10, text: "query log by application_name: ledgerline-health 2,880/day from the container healthcheck every 30 s; ledgerline-outbox 43,200/day from a 2 s relay poll" }
  - { date: 2026-08-19, text: "relay kicked on write instead of polling; healthcheck and keepalive moved to a store-free liveness route; /health kept for verify", evidence: "commit:fixture-org/ledgerline@4b9e1d27c0a3f58e6d1b2c7a9f0e3d4c5b6a7980" }
  - { date: 2026-08-26, text: "store suspends within minutes of the last request", evidence: "pr:fixture-org/ledgerline#9" }
---
A bench-synthetic incident. The container healthcheck called the readiness route,
which runs a query, so the store never had five quiet minutes. The keepalive was not the main
cause but probed the same route.
