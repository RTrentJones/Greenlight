---
id: pattern/keepalive-probe-cached
type: pattern
title: A keepalive response served from Cloudflare's cache
updated: 2026-11-01
status: hypothesis
kind: failure
class: proxy-check
atRisk: the upstream store or app the keepalive is meant to touch
probed: Cloudflare's edge cache in front of the Worker's subrequest
cells: ["*/*/*"]
affects: "<0.10.0"
relevance: framework-version
evidence:
  - commit:RTrentJones/greenlight@938973a9046fc1f10a2bb5c5c85577f25fbefdb3
catches:
  description: the probe's subrequest bypasses the cache, and the upstream access is observable (a query count or log line moves)
  checkSignature: "keepalive.*cache"
remediation:
  - { outlet: mechanism, ref: "commit:RTrentJones/greenlight@938973a9046fc1f10a2bb5c5c85577f25fbefdb3", verified: false }
skills: [provider-cloudflare]
---
## Symptom
Keepalive sweeps succeeded with no corresponding activity at the target.

## Root cause
The Worker's `fetch` to the target could be answered by Cloudflare's cache, so the request never
left the edge. A cached 200 looks the same as a real one to the caller.

## Fix / workaround
Make keepalive subrequests uncacheable. Do not combine `cache: 'no-store'` with `cf.cacheTtl`:
the Workers runtime rejects that pair, and the first attempt at this fix made every sweep throw
before the probe was sent.

## How it is caught
In a replay, the target counts requests, and the grader asserts that the count increases once per
sweep. This page stays a hypothesis until a deployed sweep is shown reaching the store with the
uncacheable subrequest in place.
