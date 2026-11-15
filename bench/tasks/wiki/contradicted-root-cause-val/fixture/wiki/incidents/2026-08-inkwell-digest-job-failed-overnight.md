---
id: incident/2026-08-inkwell-digest-job-failed-overnight
type: incident
title: Inkwell's nightly digest job failed at its first query and succeeded in the morning
updated: 2026-08-20
status: confirmed
tool: inkwell
opened: 2026-08-17
closed: 2026-08-20
evidence:
  - issue:fixture-org/inkwell#18
  - run:fixture-org/inkwell/6604817352
  - pr:fixture-org/inkwell#20
patterns:
  - pattern/nightly-job-fails-while-store-wakes
timeline:
  - { date: 2026-08-17, text: "the 02:00Z digest job failed at its first query; no digest was sent", evidence: "run:fixture-org/inkwell/6604817352" }
  - { date: 2026-08-17, text: "run by hand at 09:10Z, after the morning deploy, the job succeeded; put down to the store waking; the connection error was not kept", evidence: "issue:fixture-org/inkwell#18" }
  - { date: 2026-08-20, text: "job client connect timeout raised from 5 s to 30 s", evidence: "pr:fixture-org/inkwell#20" }
---
A bench-synthetic incident. The failure was explained as a slow store resume at the time, without
the error of the failing connection.
