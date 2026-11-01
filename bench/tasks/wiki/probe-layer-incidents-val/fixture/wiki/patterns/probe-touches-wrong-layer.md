---
id: pattern/probe-touches-wrong-layer
type: pattern
title: A liveness probe that touches a layer it is not managing
updated: 2026-11-01
status: hypothesis     # needs red→green evidence on a deployed artifact (LR-05); input to the cycle
kind: failure
class: proxy-check
atRisk: the layer the probe exists to manage (container for needs-heal, store for needs-traffic)
probed: a deeper or shallower layer than the one at risk
cells: ["*/*/*"]
affects: "*"          # framework versions that carry the defect
relevance: app-code
evidence:
  - commit:RTrentJones/RTrentJones.dev@16cee9a60db9a93d55567bd41d21378a193c0e42
  - post:https://rtrentjones.dev/blog/keepalive-green-database-paused/
catches:
  description: the probe path matches the liveness model — store-reaching for needs-traffic, store-free for needs-heal and needs-silence
remediation:
  - { outlet: doctor, ref: "DR-21", verified: false }
  - { outlet: template, ref: "C2 /health/live in all templates", verified: false }
skills: [deploy-verify-promote, provider-oci, greenlight-build]
---
## Symptom
A container tool's keepalive probed `/health`, which checks the database. It woke a database
that should have stayed asleep, and it told the heal path nothing the heal path needed.

## Root cause
The probe exists to detect a reclaimed or dead container. A probe guarding a pausing store has to
reach the store, but a probe guarding a container has to stop at the application. One endpoint was
serving both purposes.

## Fix / workaround
Split liveness from readiness. `/health/live` answers from the process, and it is what keepalive
and container healthchecks use. `/health` checks dependencies, and only verify calls it at deploy
time.

## How it is caught
DR-21 compares `liveness.probe` against the model. App contract C2 ships both routes in every
template.
