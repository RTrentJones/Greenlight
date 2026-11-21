---
id: incident/2026-09-menuboard-verify-red-after-deploy
type: incident
title: Menuboard's beta verify failed right after a deploy and passed on the next attempt
updated: 2026-09-12
status: confirmed
tool: menuboard
opened: 2026-09-08
closed: 2026-09-12
evidence:
  - issue:fixture-org/menuboard#31
  - run:fixture-org/menuboard/7730119245
  - pr:fixture-org/menuboard#33
patterns:
  - pattern/verify-fails-on-cold-start
timeline:
  - { date: 2026-09-08, text: "ship to beta: deploy step green, verify failed on the home-page content check", evidence: "run:fixture-org/menuboard/7730119245" }
  - { date: 2026-09-08, text: "the same commit shipped again an hour later and verify passed; put down to a cold Worker; no request timings were kept", evidence: "issue:fixture-org/menuboard#31" }
  - { date: 2026-09-12, text: "verify request timeout raised from 5 s to 30 s, with two retries", evidence: "pr:fixture-org/menuboard#33" }
---
A bench-synthetic incident. The failure was explained as a cold start at the time, without a
measurement of the failing request.
