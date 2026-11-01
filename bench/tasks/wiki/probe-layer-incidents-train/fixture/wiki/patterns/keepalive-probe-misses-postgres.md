---
id: pattern/keepalive-probe-misses-postgres
type: pattern
title: A Supabase keepalive that never reaches Postgres
updated: 2026-11-01
status: hypothesis
kind: failure
class: proxy-check
atRisk: Supabase free-tier idle timer, measured as Postgres activity
probed: PostgREST's in-memory schema cache at /rest/v1/, then Cloudflare's edge cache, then nothing (the Worker threw before sending)
cells: ["*/*/supabase"]
affects: "<0.10.1"
relevance: both
evidence:
  - issue:RTrentJones/RTrentJones.dev#55
  - issue:RTrentJones/RTrentJones.dev#86
  - commit:RTrentJones/greenlight@c97222a07dc82904193ed241f266cb6a15cce29e
  - commit:RTrentJones/greenlight@938973a9046fc1f10a2bb5c5c85577f25fbefdb3
  - commit:RTrentJones/greenlight@b23a3010054dba6a3b80a9be90a6ebc3afba2ccd
  - commit:RTrentJones/greenlight@217d1f05645c0b052438536cdd807f9d303682a3
  - post:https://rtrentjones.dev/blog/keepalive-green-database-paused/
catches:
  description: the probe is a query that only Postgres can answer, sent uncached, and only a 2xx with a row counts as healthy; a sweep on the deployed Worker is shown reaching the probe table
  checkSignature: "keepalive.*supabase.*probeTable"
  graderTask: replay/keepalive-probe-reaches-store
remediation:
  - { outlet: mechanism, ref: "greenlight@0.9.0", verified: false }
  - { outlet: mechanism, ref: "greenlight@0.10.0", verified: false }
  - { outlet: mechanism, ref: "greenlight@0.10.1", verified: false }
skills: [provider-supabase, deploy-verify-promote]
---
## Symptom
The keepalive Worker reported a Supabase-backed tool healthy on every sweep, but the project paused
anyway after a week. It happened twice: in August, and again seven days after the unpause, with
two clean sweeps inside that window.

## Root cause
Three faults in a row kept the probe from reaching Postgres. Before 0.9.0 it requested
`/rest/v1/`, which PostgREST answers from its schema cache. In 0.9.x it queried a real table, but
the Worker's subrequest could be answered by Cloudflare's cache, so it never left the edge. In
0.10.0 the uncacheable subrequest combined `cache: 'no-store'` with `cf.cacheTtl`, which the
Workers runtime rejects, so every sweep threw before the probe was sent.

## Fix / workaround
Name a dedicated one-row probe table readable anonymously; the probe becomes
`GET /rest/v1/<table>?select=<col>&limit=1` (0.9.0). Send it with `cache: 'no-store'` only
(0.10.0 made it uncacheable; 0.10.1 dropped the `cf` override that made it throw). A hand-written
health route that stops at a cache repeats the fault in app code, whatever the framework version.

## How it is caught
The keepalive refuses a Supabase target without `probeTable`, and only a 2xx counts as healthy.
The 0.9.0 check of the deployed Worker (byte-identical to the release, table named, table answering
anonymously) did not show a sweep reaching Postgres, and the database paused again. This stays a
hypothesis until a sweep on 0.10.1 or later is shown reaching the probe table on the deployed
Worker.
