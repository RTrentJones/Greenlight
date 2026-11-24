---
id: pattern/preview-missing-env-file
type: pattern
title: A local preview fails because the tool's env file was never created
updated: 2026-07-14
status: hypothesis
kind: failure
class: env-drift
atRisk: the local gate's ability to start the tool
cells: ["next/*/*"]
affects: "*"
relevance: app-code
evidence:
  - issue:fixture-org/inkwell#11
remediation:
  - { outlet: doctor, ref: "report a missing local env file by name", verified: false }
skills: [deploy-verify-promote]
---
## Symptom
`greenlight preview` fails during the build with an undefined-variable error
(issue:fixture-org/inkwell#11).

## Root cause
A fresh checkout has no local env file, and the build reads a variable from it.

## Fix / workaround
Copy the example env file before the first preview.

## How it is caught
The preview fails before any check runs, so nothing wrong can ship.
