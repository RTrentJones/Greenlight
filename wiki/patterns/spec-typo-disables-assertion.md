---
id: pattern/spec-typo-disables-assertion
type: pattern
title: A typo or unknown field in a verify spec silently disables an assertion
updated: 2026-11-01
status: confirmed
kind: failure
class: spec-validity
atRisk: the behavior the assertion was written to guard
probed: nothing — the misspelled field was ignored and the check passed
cells: ["*/*/*"]
affects: "<0.10.1"
relevance: framework-version
evidence:
  - commit:RTrentJones/greenlight@baae67534d2686116abfa8a7c40733c221755efd
catches:
  description: every spec is validated strictly before running; unknown, wrong-typed or out-of-range fields fail the gate
  checkSignature: "spec is valid"
remediation:
  - { outlet: mechanism, ref: "greenlight@0.10.1", verified: true }
skills: [deploy-verify-promote, greenlight-build]
---
## Symptom
A check written to assert something passed even when that something was broken.

## Root cause
The harness ignored fields it did not recognize, so a misspelling (or a field from a newer version)
turned an assertion into a no-op while the gate read green.

## Fix / workaround
Strict specs: an unknown, wrong-typed or uncompilable field fails as `spec is valid — checks[i]:
unsupported field "…"`. Follow-up fixes closed related gaps (non-negative budgets, integer counts,
own-property paths, future timestamps).

## How it is caught
Validation runs before any network call, so the guard fails on the faulty configuration itself.
Machine-written wiki artifacts follow the same rule: unknown frontmatter keys are rejected.
