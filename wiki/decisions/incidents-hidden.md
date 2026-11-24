---
id: decision/incidents-hidden
type: decision
title: Building agents never receive incident pages or unconfirmed patterns
updated: 2026-11-01
status: confirmed
decided: 2026-11-01
scope: ["*"]
skills: [greenlight-wiki, deploy-verify-promote]
---
Skills give building agents intent, liveness, decisions, facts and contract pages. After a gate
fails, they also get `confirmed` patterns through `wiki lookup`. Incidents (long narratives) and
`hypothesis` patterns are for the maintainer and humans only. Bench rollouts get no lookup at all.
This is grounded in the paper's ablation (ADR-10).
