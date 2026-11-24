---
id: incident/2026-10-menuboard-verify-red-with-long-timeout
type: incident
title: Menuboard's beta verify failed after a deploy again, with the 30 s timeout in place
updated: 2026-10-22
status: confirmed
tool: menuboard
opened: 2026-10-21
evidence:
  - issue:fixture-org/menuboard#41
  - run:fixture-org/menuboard/7861204418
  - run:fixture-org/menuboard/7861391150
patterns: []
timeline:
  - { date: 2026-10-21, text: "ship to beta of commit 5d0c3a9: the deploy step finished at 14:02:11Z, verify started at 14:02:12Z and failed on the home-page content check; the 30 s timeout and two retries were in effect", evidence: "run:fixture-org/menuboard/7861204418" }
  - { date: 2026-10-21, text: "all three attempts answered 200 in 35 to 41 ms; the body was the September menu page and /__version reported 9b1f7e2, the commit deployed on 2026-10-19", evidence: "run:fixture-org/menuboard/7861204418" }
  - { date: 2026-10-21, text: "verify alone re-run at 14:11:30Z with nothing redeployed: passed, /__version reported 5d0c3a9", evidence: "run:fixture-org/menuboard/7861391150" }
  - { date: 2026-10-22, text: "the provider's deployment log shows 5d0c3a9 taking over the beta route at 14:02:49Z, 38 s after the deploy command returned", evidence: "issue:fixture-org/menuboard#41" }
---
A bench-synthetic incident, captured from the wrapper. The two verify runs are in `raw/`.
