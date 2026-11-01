---
id: incident/2026-07-tripnote-keepalive-green-store-paused
type: incident
title: Tripnote's keepalive stayed green while its Supabase project paused
updated: 2026-11-01
status: confirmed
tool: tripnote
opened: 2026-07-09
closed: 2026-07-21
evidence:
  - issue:fixture-org/tripnote#12
  - pr:fixture-org/tripnote#15
  - run:fixture-org/tripnote/9182736455
patterns:
  - pattern/keepalive-probe-misses-postgres
timeline:
  - { date: 2026-07-09, text: "project paused after seven idle days; the keepalive had reported every sweep healthy", evidence: "issue:fixture-org/tripnote#12" }
  - { date: 2026-07-12, text: "the probe target named no table, so every sweep requested the REST root, which the API layer answers from its schema cache" }
  - { date: 2026-07-18, text: "target moved to a one-row heartbeat table read anonymously; deployed", evidence: "pr:fixture-org/tripnote#15" }
  - { date: 2026-07-21, text: "a sweep after the deploy reset the idle timer: the project's last-activity time moved to the sweep time", evidence: "run:fixture-org/tripnote/9182736455" }
---
A bench-synthetic incident. The keepalive answered 200 on every sweep while the store
went idle, because what it reached was the API gateway's cache, not the database. The project was
restored by hand, and the target now reads a dedicated table.
