---
id: decision/wiki-never-rolls-back
type: decision
title: Skill changes roll back; the wiki does not
updated: 2026-11-01
status: confirmed
decided: 2026-11-01
scope: ["*"]
skills: [greenlight-wiki]
---
This follows the paper: a rejected proposal reverts the skill, never the wiki. Knowledge learned
from the failed attempt stays. A wrong page is retired by `status: superseded` plus `supersededBy`,
or by archival, and never by deletion or history rewrite. The ledger records rejected proposals, so
the proposer does not repeat them.
