---
id: pattern/keepalive-probe-misses-postgres
type: pattern
title: A Supabase keepalive that never reaches Postgres
updated: 2026-11-01
status: confirmed
kind: failure
class: proxy-check
atRisk: Supabase free-tier idle timer, measured as Postgres activity
probed: PostgREST's in-memory schema cache at /rest/v1/
cells: ["*/*/supabase"]
affects: "<0.9.0"          # framework versions that carry the defect
relevance: framework-version
evidence:
  - issue:RTrentJones/RTrentJones.dev#55
  - commit:RTrentJones/greenlight@c97222a07dc82904193ed241f266cb6a15cce29e
  - post:https://rtrentjones.dev/blog/keepalive-green-database-paused/
catches:
  description: the probe is a query that only Postgres can answer, and only a 2xx with a row counts as healthy
  checkSignature: "keepalive.*supabase.*probeTable"
  graderTask: replay/keepalive-probe-reaches-store
remediation:
  - { outlet: mechanism, ref: "greenlight@0.9.0", verified: true }
skills: [provider-supabase, deploy-verify-promote]
---
## Symptom
The keepalive Worker reported a Supabase-backed tool healthy on every sweep, but the project paused
anyway after a week. The next sweep got a 530 from the paused project and opened an issue.

## Root cause
The probe requested `/rest/v1/`. PostgREST answers that path from its schema cache without sending
anything to Postgres. Supabase measures idleness at the database, so the idle timer never reset.

## Fix / workaround
Since 0.9.0 a Supabase keepalive target must declare `probeTable`, and the probe becomes
`GET /rest/v1/<table>?select=<col>&limit=1`. Use a dedicated one-row table that is readable
anonymously, so the probe does not expose user data.

## How it is caught
The keepalive refuses a Supabase target without `probeTable`. Only a 2xx response counts as
healthy, so a revoked grant or a rotated key now fails loudly.
