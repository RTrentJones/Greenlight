---
id: pattern/unplanned-compute-replacement
type: pattern
title: A Terraform apply that replaces running compute without anyone planning it
updated: 2026-11-01
status: confirmed
kind: failure
class: iac-hazard
atRisk: running containers and databases (state, uptime, free-tier allocation)
probed: n/a — apply ran unattended on push
cells: ["*/oci/*", "*/*/neon", "*/*/supabase"]
affects: "<0.10.1"
relevance: framework-version
evidence:
  - pr:RTrentJones/greenlight#27
  - commit:RTrentJones/greenlight@7cdecab738968fa5818cb934e04ff7c213b2613a
catches:
  description: infra.yml fails a plan that destroys or replaces guarded resource types unless a human approves
remediation:
  - { outlet: mechanism, ref: "greenlight@0.10.1", verified: true }
skills: [provider-hcp, provider-oci, provider-neon]
---
## Symptom
A routine infra change could plan a destroy-and-recreate of running compute, and apply-on-push
would execute it.

## Root cause
Some attribute changes force replacement. Unattended apply had no step at which a human saw that a
plan contained a destroy.

## Fix / workaround
`infra.yml` runs plan, then a destroy guard over the saved plan, then manual approval, then apply.
This covers guarded resource types such as container instances and Neon branches and endpoints.
Run state surgery (`state rm`) as one atomic step that fails loudly.

## How it is caught
The generated destroy guard fails the workflow on any unplanned replacement of a guarded type, so
the guard fails on the faulty plan before approval is reached.
