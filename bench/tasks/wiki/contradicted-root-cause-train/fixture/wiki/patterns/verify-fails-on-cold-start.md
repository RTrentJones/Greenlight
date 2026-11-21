---
id: pattern/verify-fails-on-cold-start
type: pattern
title: Post-deploy verify fails while the new Worker is still cold
updated: 2026-09-12
status: hypothesis
kind: failure
class: free-tier-physics
atRisk: the first requests to a freshly deployed Worker
probed: the home page content, inside the verify request timeout
cells: ["astro/workers/none"]
affects: "*"
relevance: app-code
evidence:
  - issue:fixture-org/menuboard#31
  - run:fixture-org/menuboard/7730119245
  - pr:fixture-org/menuboard#33
remediation:
  - { outlet: verify, ref: "verify request timeout 5 s to 30 s, two retries", verified: false }
skills: [deploy-verify-promote]
---
## Symptom
`verify` fails on the home-page content check right after a deploy to beta, and passes when the
same commit is shipped again later (issue:fixture-org/menuboard#31).

## Root cause
The freshly deployed Worker is cold. Its first request has to load and start the new bundle, takes
longer than the 5 s verify request timeout, and the content check fails. By the next attempt the
Worker is warm. The duration of the failing request was not recorded.

## Fix / workaround
Give the Worker time to warm up: raise the verify request timeout to 30 s and retry twice
(pr:fixture-org/menuboard#33).

## How it is caught
It is not. The failure disappears on the next attempt.
