---
id: pattern/settle-greenlights-previous-deploy
type: pattern
title: The verify settle loop can pass against the previous deployment
updated: 2026-11-01
status: confirmed
kind: failure
class: artifact-identity
atRisk: the commit being shipped
probed: whatever artifact the URL served during the settle window
cells: ["*/*/*"]
affects: "<0.8.0"
relevance: framework-version
evidence:
  - commit:RTrentJones/greenlight@04280a63432a861e51e2b5e4d4bb71a209787bc1
  - commit:RTrentJones/greenlight@debcf1e4fc87ed6209e2c63ee182afa77f0aade5
  - commit:RTrentJones/RTrentJones.dev@2545b52af0ad00089897bca3576690bbb801c945
  - commit:RTrentJones/RTrentJones.dev@514dca49280f6e457810328d67d3c28a01ebd479
  - commit:RTrentJones/RTrentJones.dev@4ba03e3291e56504c595c826e4b063bf3e0fff61
catches:
  description: /__version must equal the shipped sha before any content check runs (requireIdentity)
  checkSignature: "identity|__version"
remediation:
  - { outlet: mechanism, ref: "greenlight@0.8.0", verified: true }
skills: [deploy-verify-promote]
---
## Symptom
Verify passed right after a deploy whose new artifact was broken.

## Root cause
The settle loop retries checks until they pass, to absorb eventual consistency. The previous
deployment was still serving and already passed, so the loop green-lit it.

## Fix / workaround
Since 0.8, the tool serves its build sha at `/__version`. `ship` passes `--expect-sha`, and the
settle loop gates on identity before any content check. Set `requireIdentity: true`, so that a
missing endpoint fails instead of reading as "unverified".

## How it is caught
The identity probe fails hard when the URL serves a different sha, on every SHA-gated ship. On a
deployed web app whose new build took minutes to go live, the gate refused the previous deployment
("deployed sha != expected") instead of passing it; against deployments serving the expected sha
the same gate passes.
A spec with no identity check is the remaining gap, and a doctor rule is planned to flag it.
