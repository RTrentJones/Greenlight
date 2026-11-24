---
id: incident/2026-10-inkwell-digest-job-failed-with-long-timeout
type: incident
title: Inkwell's nightly digest job failed again, with the 30 s connect timeout in place
updated: 2026-10-13
status: confirmed
tool: inkwell
opened: 2026-10-12
evidence:
  - issue:fixture-org/inkwell#27
  - run:fixture-org/inkwell/6790233104
  - run:fixture-org/inkwell/6790561877
patterns: []
timeline:
  - { date: 2026-10-12, text: "the 02:00Z digest job failed at its first query; the 30 s connect timeout was in effect", evidence: "run:fixture-org/inkwell/6790233104" }
  - { date: 2026-10-12, text: "the connection attempt came back in 212 ms with an authentication failure for the job's database role; the store's activity log shows the compute active since 01:58Z, serving the web app", evidence: "run:fixture-org/inkwell/6790233104" }
  - { date: 2026-10-12, text: "the weekly reset of the store branch ran at 01:30Z and issued a new login for the job's role; the job's stored database secret was last synced on 2026-10-05", evidence: "issue:fixture-org/inkwell#27" }
  - { date: 2026-10-12, text: "secrets synced at 08:40Z with no code change and no deploy; the job run by hand at 08:46Z succeeded", evidence: "run:fixture-org/inkwell/6790561877" }
---
A bench-synthetic incident, captured from the wrapper. The alert and the successful run are in
`raw/`.
