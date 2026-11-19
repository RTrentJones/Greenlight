---
id: pattern/probe-touches-wrong-layer
type: pattern
title: A liveness probe that touches a layer it is not managing
updated: 2026-11-19
status: hypothesis
kind: failure
class: proxy-check
atRisk: the layer the probe exists to manage (container for needs-heal, store for needs-traffic)
probed: a deeper or shallower layer than the one at risk
cells: ["*/*/*"]
affects: "*"
relevance: app-code
evidence:
  - commit:RTrentJones/RTrentJones.dev@16cee9a60db9a93d55567bd41d21378a193c0e42
  - post:https://rtrentjones.dev/blog/keepalive-green-database-paused/
  - raw:20261118T082244Z-1afa7547
  - raw:20261118T082244Z-33d05e6f
  - raw:20261119T072754Z-5a64f852
  - raw:20261119T072754Z-eb5865ee
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
A planned doctor rule compares `liveness.probe` against the liveness model. App contract C2 ships
both routes in every template.

Bench replay of a mcp/oci app whose Postgres is Neon (idle-probe-leaves-store-asleep, train): the failing run declared both the container healthcheck and the keepalive probe on `/health`, which queries the database. The grader counted 20 queries from the healthcheck and 1 from the keepalive, the store stayed awake 600 s of 600 s, and with the database stopped both probes returned 503, so a store outage read as a dead container (raw:20261118T082244Z-33d05e6f). The passing run pointed both at `/`, which has no database dependency, and left a comment saying so: 0 store queries, store suspended, probes 200 with the database stopped, and `/health` still reporting the database (raw:20261118T082244Z-1afa7547). The rule is conditional on the liveness model: for a container whose job is to be found dead or alive, the probe must stay off the store; a store-reaching probe belongs only to a store that needs traffic.

Rule by liveness model, stated so it can be checked. Under needs-traffic (a pausing store such as Supabase, which pauses unless it sees activity), the probe reaches the store: it must run a query only Postgres can answer. Under needs-silence (a scale-to-zero store such as Neon, which suspends only after quiet minutes) and needs-heal (a container that is found dead or alive), the probe stays off the store: it must answer from the process. The two incidents show each half: incident/2026-08-keepalive-green-database-paused is the needs-traffic case, where a probe that never reached Postgres let the database pause, and incident/2026-09-idle-app-neon-never-sleeps is the needs-silence case, where a probe and healthcheck that did reach the store kept it awake. One rule applied to both is wrong in either direction.

A second bench replay of a mcp/oci app on Neon repeats the split. The failing run put the Dockerfile HEALTHCHECK (every 30 s) and the keepalive probe on `/health`; the grader found 20 store queries from the healthcheck and 1 from the keepalive, the store awake 600 s of 600 s, and both probes returning 503 with the database stopped (raw:20261119T072754Z-5a64f852). The passing run used `/` for both, said in its summary that `/health` stays the readiness route for verify, and measured 0 queries, the store awake 240 s of 600 s, and 200 from both probes with the database stopped (raw:20261119T072754Z-eb5865ee). Pick the probe path from the liveness model before writing it; having a `/health` route is not a reason to use it. This is a bench replay, not a deployed app, so the status stays hypothesis.