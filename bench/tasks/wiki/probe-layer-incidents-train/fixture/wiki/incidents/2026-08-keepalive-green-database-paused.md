---
id: incident/2026-08-keepalive-green-database-paused
type: incident
title: The keepalive was green, and HeistMind's database paused anyway
updated: 2026-11-01
status: confirmed
tool: heistmind
opened: 2026-08-16
evidence:
  - issue:RTrentJones/RTrentJones.dev#55
  - issue:RTrentJones/RTrentJones.dev#86
  - commit:RTrentJones/greenlight@938973a9046fc1f10a2bb5c5c85577f25fbefdb3
  - pr:RTrentJones/greenlight#28
  - pr:RTrentJones/RTrentJones.dev#90
  - post:https://rtrentjones.dev/blog/keepalive-green-database-paused/
patterns:
  - pattern/keepalive-probe-misses-postgres
  - pattern/caret-zero-major
  - pattern/workers-fetch-cache-conflict
  - pattern/alert-suppressed-by-open-issue
timeline:
  - { date: 2026-07-31, text: "probeTable added to the config; inert on the deployed 0.8 Worker" }
  - { date: 2026-08-16, text: "database pauses; next sweep gets a 530 and opens an issue", evidence: "issue:RTrentJones/RTrentJones.dev#55" }
  - { date: 2026-08-24, text: "0.9.0 deployed after an explicit upgrade (^0.8.0 blocked it); Worker verified by SHA-256 against the release, config names the table, table answers anonymously" }
  - { date: 2026-08-31, text: "database pauses again, seven days after the unpause, with two clean sweeps inside the window: the probe's subrequest was served from Cloudflare's cache", evidence: "commit:RTrentJones/greenlight@938973a9046fc1f10a2bb5c5c85577f25fbefdb3" }
  - { date: 2026-10-10, text: "upgrade to 0.10.0" }
  - { date: 2026-10-13, text: "every sweep throws before the probe is sent; issue opened", evidence: "issue:RTrentJones/RTrentJones.dev#86" }
  - { date: 2026-10-17, text: "Worker fix merged upstream; probe-table move to keepalive_probe opened", evidence: "pr:RTrentJones/greenlight#28" }
  - { date: 2026-10-30, text: "database up, but not because of the keepalive; fix awaiting release (0.10.1)" }
---
Three different causes produced one symptom. The issue was closed in August only after three direct
checks:

- the probe table returned a real row anonymously;
- the deployed Worker was byte-identical to the release;
- the deployed configuration named the table.

None of them showed a sweep reaching Postgres, and the database paused again a week later.

Lesson for every skill: verify the deployed artifact, not the pipeline's report that it deployed,
for anything whose job is to keep something else alive. Close this incident when a sweep on 0.10.1
reaches `keepalive_probe` and the deployed Worker has been verified the same way.
