---
id: pattern/preview-port-in-use
type: pattern
title: A local preview fails because an earlier run still holds its port
updated: 2026-08-02
status: hypothesis
kind: failure
class: env-drift
atRisk: the local gate's ability to start the tool
cells: ["*/*/*"]
affects: "*"
relevance: app-code
evidence:
  - issue:fixture-org/menuboard#22
remediation:
  - { outlet: doctor, ref: "name the process holding the preview port", verified: false }
skills: [deploy-verify-promote]
---
## Symptom
`greenlight preview` exits at once with EADDRINUSE (issue:fixture-org/menuboard#22).

## Root cause
A dev server from an earlier session still holds the tool's preview port.

## Fix / workaround
Stop the earlier process, or preview on another port.

## How it is caught
The preview fails before any check runs, so nothing wrong can ship.
