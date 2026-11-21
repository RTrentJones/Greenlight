---
id: pattern/nightly-job-fails-while-store-wakes
type: pattern
title: A scheduled job fails because the scale-to-zero store is still waking
updated: 2026-08-20
status: hypothesis
kind: failure
class: free-tier-physics
atRisk: the first connection of the night to a suspended store
cells: ["next/vercel/neon"]
affects: "*"
relevance: app-code
evidence:
  - issue:fixture-org/inkwell#18
  - run:fixture-org/inkwell/6604817352
  - pr:fixture-org/inkwell#20
remediation:
  - { outlet: template, ref: "job database client: connect timeout 5 s to 30 s", verified: false }
skills: [provider-neon]
---
## Symptom
The nightly digest job fails at its first query and succeeds when it is run again later in the
morning (issue:fixture-org/inkwell#18).

## Root cause
The store suspends when idle, and the job is the first client of the night. Resuming the compute
takes longer than the client's 5 s connect timeout, so the first connection fails. By the morning
the store is awake. The error text of the failed connection was not kept.

## Fix / workaround
Give the store time to resume: raise the job client's connect timeout to 30 s
(pr:fixture-org/inkwell#20).

## How it is caught
It is not. The job succeeds when it is run again.
