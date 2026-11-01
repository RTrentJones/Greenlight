---
id: incident/2026-07-tripnote-keepalive-green-store-paused
type: incident
title: Tripnote's keepalive stayed green while its Supabase project paused
updated: 2026-11-01
status: confirmed
tool: tripnote
opened: 2026-07-09
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
  - { date: 2026-07-21, text: "the project paused again seven days after the deploy, with clean sweeps inside the window: the heartbeat read had been answered by an edge cache", evidence: "run:fixture-org/tripnote/9182736455" }
---
A bench-synthetic incident. The keepalive answered 200 on every sweep while the store
went idle, because what it reached was the API gateway's cache, not the database. The project was
restored by hand and the target moved to a dedicated table, but no sweep has been shown reaching
it: the project paused again a week later.
