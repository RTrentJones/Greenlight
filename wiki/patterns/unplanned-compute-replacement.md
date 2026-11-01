---
id: pattern/unplanned-compute-replacement
type: pattern
title: A Terraform apply that replaces running compute without anyone planning it
updated: 2026-11-01
status: hypothesis
kind: failure
class: iac-hazard
atRisk: running containers (uptime, and the free-tier allocation the replacement must fit into)
probed: n/a — apply ran unattended on push
cells: ["*/oci/*"]
affects: "<0.10.1"
relevance: framework-version
evidence:
  - pr:RTrentJones/greenlight#27
  - commit:RTrentJones/greenlight@ec04f9ef4a477fa5a274f8f7fa32d73c9ff29212
  - commit:RTrentJones/RTrentJones.dev@6ac5304ace802be813aae9313d9db2c5d6234768
catches:
  description: infra.yml fails a plan that replaces a running container instance unless the run was dispatched with allow_compute_replace=true
remediation:
  - { outlet: mechanism, ref: "greenlight@0.10.1", verified: false }
skills: [provider-hcp, provider-oci]
---
## Symptom
An env change on a container tool planned a delete-then-create of its instance, and apply-on-push
executed it. The tool was down until the new instance booted, and on the free tier the create
failed with `LimitExceeded`, leaving it down until a second apply.

## Root cause
Some attribute changes force replacement. Unattended apply had no step at which a human saw that a
plan replaced running compute, and the deleted instance's cores are released minutes after the
delete, so the immediate create can exceed the free-tier allocation.

## Fix / workaround
Since 0.10.1 the generated `infra.yml` fails the plan job on a replacement of a running container
instance unless the run is dispatched with `allow_compute_replace=true`. Existing wrappers keep
their own `infra.yml` and copy the guard step and dispatch input from the template. The separate
destroy guard for stateful stores (since 0.8) is unrelated to this one.

## How it is caught
The compute guard in the plan job. So far it has only been seen passing: the one replacement since
it was added was dispatched with `allow_compute_replace=true` and still hit `LimitExceeded`. This
stays a hypothesis until the guard is shown failing an unplanned replacement on a real plan.
